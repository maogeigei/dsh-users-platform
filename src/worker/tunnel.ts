/**
 * Worker 侧的**反向隧道管理器**（T08 跨机演练）。
 *
 * 为什么需要它：Manager 要连 Worker 上的两样东西 —— **agent 端口**与**每个实例的端口**
 * （实例只监听 `127.0.0.1`，这是 portGuard 的设计前提）。而 Worker 公网入方向通常被
 * **云安全组**挡住（实测：106 的 19100 从 47 与本机都连不上），放通只能在控制台点。
 *
 * 绕法：**让 Worker 主动拨 Manager**，用 SSH 反向转发把两边的 `127.0.0.1:<port>` 接起来。
 * 好处（实测）：
 *   · **两端都不用新开端口** —— 只用已开放的 SSH 端口（47 是 32022）；
 *   · 链路是加密的，且 Manager 侧落在 loopback（`GatewayPorts no` 默认）⇒ 不对外暴露；
 *   · 实例端口是**动态**的（`findFreePort()`）⇒ 用 **ControlMaster + `ssh -O forward/cancel`**
 *     在**同一条长连接**上加/减转发，不必为每个端口重开连接。
 *
 * ⚠️ 定位：这是**演练级**传输（生产长期方案见设计 §2.3：受控网段白名单或隧道服务）。
 * ⚠️ 默认**关闭**：只有设了 `DSH_USERS_PLATFORM_TUNNEL_TARGET` 才启用 ⇒ 对同机/单机形态零影响。
 *
 * @module dsh-users-platform/worker/tunnel
 */
import { execFile } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface TunnelOptions {
  /** 拨入目标，形如 `root@<SERVER_PUBLIC_IP>:32022`。 */
  target: string
  /** 私钥路径（建议专用、且在 Manager 侧用 `restrict,port-forwarding` 限权）。 */
  identity: string
  /** ControlMaster socket 路径（同一路径复用同一条连接）。 */
  controlPath: string
  /** 启动时就转发的端口（agent 自身；还可带控制面 PG 等）。 */
  staticPorts?: number[]
  /** `ssh` 可执行文件路径。 */
  sshBin?: string
}

export class SshTunnel {
  /** 内部一律用**已补默认值**的具体类型（否则 `sshBin` 会是 `string | undefined`）。 */
  private readonly opts: {
    target: string
    identity: string
    controlPath: string
    staticPorts: number[]
    sshBin: string
  }
  private readonly forwarded = new Set<number>()
  private readonly hostPart: string
  private readonly portPart: number | undefined

  constructor(options: TunnelOptions) {
    // `user@host:port` 里的 port 是 **SSH 端口**（不是转发的端口）—— 47 上用 32022，
    // 必须经 `-p` 传，否则会去连 22 而失败。
    const [hostPart, portPart] = options.target.split(':')
    this.hostPart = hostPart
    this.portPart = portPart === undefined ? undefined : Number(portPart)
    this.opts = {
      target: options.target,
      identity: options.identity,
      controlPath: options.controlPath,
      staticPorts: options.staticPorts ?? [],
      sshBin: options.sshBin ?? '/usr/bin/ssh',
    }
  }

  /** 所有 ssh 调用的公共参数（`-p` 只在目标里显式给了端口时才加）。 */
  private baseArgs(): string[] {
    return this.portPart === undefined ? [] : ['-p', String(this.portPart)]
  }

  /** 当前已转发的端口（诊断用）。 */
  get ports(): number[] {
    return [...this.forwarded]
  }

  /**
   * 建立（或复用）ControlMaster 长连接，并把 `staticPorts` 转发上去。
   * 幂等：socket 已存在且 master 还活着就直接返回。
   */
  async ensureMaster(): Promise<void> {
    if (existsSync(this.opts.controlPath)) {
      try {
        await run(this.opts.sshBin, [...this.baseArgs(), '-S', this.opts.controlPath, '-O', 'check', this.hostPart])
        // master 活着 ⇒ 只需补齐静态转发
        for (const port of this.opts.staticPorts ?? []) await this.forward(port)
        return
      } catch {
        try {
          unlinkSync(this.opts.controlPath) // 僵尸 socket：清掉重建
        } catch {
          /* 无所谓 */
        }
      }
    }
    const args = [
      '-M',
      '-N',
      '-f',
      ...this.baseArgs(),
      '-S',
      this.opts.controlPath,
      '-i',
      this.opts.identity,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
    ]
    for (const port of this.opts.staticPorts ?? []) args.push('-R', `${port}:127.0.0.1:${port}`)
    args.push(this.hostPart)
    await run(this.opts.sshBin, args, { timeout: 20_000 })
    for (const port of this.opts.staticPorts ?? []) this.forwarded.add(port)
  }

  /**
   * master 是否还活着（`ssh -O check`）。
   *
   * 为什么需要：**对端 SSH 重启/断链后，转发会全部消失，而本地 `forwarded` 集合并不知情**
   * ⇒ 若只看本地状态，会以为"隧道还好"，实际 Manager 已经连不上这台 Worker
   * （2026-09-15 收口"以跑通为目的"时补）。
   */
  async isMasterAlive(): Promise<boolean> {
    try {
      await run(this.opts.sshBin, [...this.baseArgs(), '-S', this.opts.controlPath, '-O', 'check', this.hostPart], {
        timeout: 8_000,
      })
      return true
    } catch {
      // check 失败 ⇒ master 不在了；顺手清掉本地记账，避免"以为还转着"
      this.forwarded.clear()
      return false
    }
  }

  /**
   * 动态加一条反向转发（实例起来时调用）。
   * 用**同一个端口号**：实例在 Worker 上是 `127.0.0.1:<port>`，反向转发落到 Manager 的
   * `127.0.0.1:<port>` ⇒ Manager 侧无需端口映射表，`endpointFor` 直接回 `127.0.0.1`。
   */
  async forward(port: number): Promise<boolean> {
    if (this.forwarded.has(port)) return true
    try {
      await run(
        this.opts.sshBin,
        [...this.baseArgs(), '-S', this.opts.controlPath, '-O', 'forward', '-R', `${port}:127.0.0.1:${port}`, this.hostPart],
        { timeout: 10_000 },
      )
      this.forwarded.add(port)
      return true
    } catch {
      return false // 失败不抛：实例本身仍在本机可用，只是跨机代理这跳不可用
    }
  }

  /** 撤销一条转发（实例停止/退出时调用）。 */
  async cancel(port: number): Promise<void> {
    if (!this.forwarded.has(port)) return
    try {
      await run(
        this.opts.sshBin,
        [...this.baseArgs(), '-S', this.opts.controlPath, '-O', 'cancel', '-R', `${port}:127.0.0.1:${port}`, this.hostPart],
        { timeout: 10_000 },
      )
    } catch {
      /* 连接已断也一样算撤销 */
    }
    this.forwarded.delete(port)
  }

  /** 关闭 master（进程退出时）。 */
  async close(): Promise<void> {
    try {
      await run(this.opts.sshBin, [...this.baseArgs(), '-S', this.opts.controlPath, '-O', 'exit', this.hostPart], {
        timeout: 10_000,
      })
    } catch {
      /* 已退出 */
    }
    this.forwarded.clear()
  }

  /** 目标 SSH 端口（`root@h:32022` → 32022）。 */
  get targetPort(): number | undefined {
    return this.portPart
  }
}
