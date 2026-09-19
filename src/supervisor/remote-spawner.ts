/**
 * `Spawner` 的**远端实现**（T08 S3 单机 / S6 多机；设计 §1.1/§11）。
 *
 * 路由层只依赖 `Spawner` 接口（见 `spawner.ts` 头注释），所以本类**不触碰路由与代理**
 * —— 代理层把 `endpointFor` 返回的 `{host, port}` 直连即可（`proxy.ts` 的 TCP 目标
 * 与 Host 头本就是分开处理的，跨机不需要改信任逻辑）。
 *
 * 三条协议纪律：
 *  1. **幂等键复用**：同一次调用的重试**复用同一个 `operationId`** —— 否则 agent 会把
 *     "Manager 超时后重发"当成新请求，起出两个实例（设计 §11.3 手段 3）。
 *  2. **重试有界**：3 次（200ms / 1s / 3s），仍失败就**抛错**，由上层决定退让或告警；
 *     错误信息里带上状态码与响应体片段，避免"静默失败"。
 *  3. **按 host 路由**（S6）：每个用户的操作都落到**它实例所在的那台** —— 依据是
 *     `dsh_instances.host_id`，由上层以 `hostIdFor` 注入（本类不直接连 DB）。
 *
 * ⚠️ 本类**不持有归属租约**：租约由 Manager 侧的 `InstanceLease`/`LeasedSpawner` 管理。
 *
 * @module dsh-users-platform/supervisor/remote-spawner
 */
import { randomUUID } from 'node:crypto'
import { AGENT_TOKEN_HEADER } from '../worker/agent.js'
import type { Endpoint, Instance, Spawner, UserStatus } from './spawner.js'

/** 一台 worker 的接入信息。 */
export interface ClusterHost {
  hostId: string
  /** agent 基址。 */
  agentUrl: string
  /** 与 agent 约定的共享密钥。 */
  token: string
  /** 代理时使用的主机（同机 1a = `127.0.0.1`；跨机填 Worker 内网 IP）。 */
  instanceHost?: string
}

export interface RemoteSpawnerOptions {
  /** agent 基址，如 `http://127.0.0.1:9000`。 */
  agentUrl: string
  /** 与 agent 约定的共享密钥。 */
  token: string
  /** 代理时使用的主机（同机 1a = `127.0.0.1`；跨机填 Worker 内网 IP）。 */
  instanceHost?: string
  /** 单次请求超时（ms）。控制通道是短请求，默认 10 s（设计 §11.2）。 */
  timeoutMs?: number
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 解析该用户的模型 key 与 uid —— Manager 侧解析后**随 launch 投递**给 agent。
   * 为什么不投递"让 Worker 自己查凭据库"：那是**权限扩大**（Worker 就能读全量用户的 key），
   * 而投递是收窄到"本次实例那一把"。**注意**：这条只管**控制面凭据**，与"Worker 能不能有
   * 自己的库"无关（插件数据在实例 home 里，见设计 §1.3 数据分层）。
   */
  resolveApiKey?: (userId: string) => Promise<string | null>
  resolveUid?: (userId: string) => Promise<number>
  /** 默认 host 的 id（不提供 `hosts` 时的单机形态用它）。 */
  defaultHostId?: string
  /** **多机（S6）**：除默认 host 外的其它 worker。给了就按 `hostId` 路由。 */
  hosts?: ClusterHost[]
  /** **多机（S6）**：`userId` → 它实例所在的 `hostId`（上层查 `dsh_instances.host_id` 注入）。 */
  hostIdFor?: (userId: string) => Promise<string | undefined>
  /**
   * **host 目录的来源**（S6）：从 `dsh_hosts` 读。给它就**不必预知 worker 列表**，
   * 且**新增 worker 无需重启 Manager**（TTL 内自动生效）。
   */
  hostsProvider?: () => Promise<ClusterHost[]>
  /** 目录缓存时长（ms）。默认 30 s —— 与心跳同量级。 */
  directoryTtlMs?: number
}

const RETRY_DELAYS_MS = [200, 1000, 3000]

export class RemoteSpawner implements Spawner {
  private readonly defaultHost: ClusterHost
  private readonly hosts = new Map<string, ClusterHost>()
  private readonly timeoutMs: number
  private readonly doFetch: typeof fetch
  private readonly resolveApiKey?: (userId: string) => Promise<string | null>
  private readonly resolveUid?: (userId: string) => Promise<number>
  private readonly hostIdFor?: (userId: string) => Promise<string | undefined>
  private readonly hostsProvider?: () => Promise<ClusterHost[]>
  private readonly directoryTtlMs: number
  private directoryLoadedAt = 0

  constructor(options: RemoteSpawnerOptions) {
    this.defaultHost = {
      hostId: options.defaultHostId ?? 'local',
      agentUrl: options.agentUrl.replace(/\/$/, ''),
      token: options.token,
      instanceHost: options.instanceHost ?? '127.0.0.1',
    }
    this.hosts.set(this.defaultHost.hostId, this.defaultHost)
    for (const host of options.hosts ?? []) {
      this.hosts.set(host.hostId, { ...host, agentUrl: host.agentUrl.replace(/\/$/, '') })
    }
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.doFetch = options.fetchImpl ?? fetch
    this.resolveApiKey = options.resolveApiKey
    this.resolveUid = options.resolveUid
    this.hostIdFor = options.hostIdFor
    this.hostsProvider = options.hostsProvider
    this.directoryTtlMs = options.directoryTtlMs ?? 30_000
  }

  /**
   * 按需刷新 host 目录（TTL 内不重复查询）。
   * **默认 host 始终在表里**（配置里那台），即使它还没注册进 `dsh_hosts`。
   */
  private async ensureHosts(): Promise<void> {
    if (this.hostsProvider === undefined) return
    if (Date.now() - this.directoryLoadedAt < this.directoryTtlMs) return
    this.directoryLoadedAt = Date.now()
    try {
      for (const host of await this.hostsProvider()) {
        this.hosts.set(host.hostId, { ...host, agentUrl: host.agentUrl.replace(/\/$/, '') })
      }
      this.hosts.set(this.defaultHost.hostId, this.defaultHost)
    } catch {
      // 查库失败就沿用旧目录（可能是全库不可用的前兆，由心跳/管理面暴露）
    }
  }

  /** 已知的 host 目录（管理面/诊断用）。 */
  knownHosts(): ClusterHost[] {
    return [...this.hosts.values()]
  }

  /** 强制刷新目录（管理面/测试用）。 */
  async reloadHosts(): Promise<void> {
    this.directoryLoadedAt = 0
    await this.ensureHosts()
  }

  /** hostId → 接入信息；未知 host 回退到默认（单机形态下这就是唯一那台）。 */
  hostById(hostId: string | null | undefined): ClusterHost {
    if (hostId === null || hostId === undefined) return this.defaultHost
    return this.hosts.get(hostId) ?? this.defaultHost
  }

  /**
   * 决定这次操作落到哪台。优先级：**显式指定**（迁移目标机、launch 时选好的机）
   * → **该用户实例的归属**（`hostIdFor`）→ 默认 host。
   */
  private async hostFor(userId: string, explicit?: string): Promise<ClusterHost> {
    await this.ensureHosts()
    if (explicit !== undefined) {
      let found = this.hosts.get(explicit)
      if (found === undefined) {
        // 目录有 30s TTL：显式指定的 host 可能"刚 join 还没进目录" ⇒ 强制刷一次
        this.directoryLoadedAt = 0
        await this.ensureHosts()
        found = this.hosts.get(explicit)
      }
      // ⛔ 仍然找不到就**报错**，绝不回退到默认 host ——
      // "租约认领在 A、实例却起在 B"是多机下最危险的静默失败（归属与实例分离）。
      if (found === undefined) throw new Error(`unknown host "${explicit}"：不在 host 目录里，拒绝改投到别的 worker`)
      return found
    }
    if (this.hostIdFor !== undefined) {
      const owned = await this.hostIdFor(userId)
      if (owned !== undefined) {
        const found = this.hosts.get(owned)
        if (found !== undefined) return found
      }
    }
    return this.defaultHost
  }

  /** 带重试的请求。`operationId` 由调用方生成并在重试间**保持不变**（幂等）。 */
  private async call<T>(
    host: ClusterHost,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    operationId?: string,
  ): Promise<T> {
    const payload = body === undefined ? undefined : { ...body, ...(operationId === undefined ? {} : { operationId }) }
    let lastErr: unknown
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]))
      try {
        const res = await this.doFetch(`${host.agentUrl}${path}`, {
          method,
          headers: {
            [AGENT_TOKEN_HEADER]: host.token,
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (res.ok) return (await res.json()) as T
        const text = await res.text()
        // 4xx 是"协议/参数错"，重试没意义；5xx 与网络错才重试。
        if (res.status < 500) throw new Error(`agent ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
        lastErr = new Error(`agent ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  async launch(
    userId: string,
    folder: string,
    patch?: string,
    opts?: { force?: boolean; epoch?: number; hostId?: string },
  ): Promise<Instance> {
    const host = await this.hostFor(userId, opts?.hostId)
    // 同一个 operationId 贯穿这次调用的所有重试 ⇒ agent 侧幂等回放（不会起两个实例）。
    const operationId = randomUUID()
    const apiKey = this.resolveApiKey === undefined ? null : await this.resolveApiKey(userId)
    const uid = this.resolveUid === undefined ? undefined : await this.resolveUid(userId)
    const res = await this.call<{ instance: Instance; note?: string }>(
      host,
      'POST',
      '/launch',
      { userId, folder, patch, apiKey, uid, epoch: opts?.epoch },
      operationId,
    )
    return res.instance
  }

  async restartMain(userId: string, hostId?: string): Promise<Instance | undefined> {
    const current = await this.status(userId)
    if (current.main === undefined) return undefined
    const { folder, patch } = current.main
    const host = await this.hostFor(userId, hostId)
    await this.stop(userId, host.hostId)
    return this.launch(userId, folder, patch, { hostId: host.hostId })
  }

  /** 重启**所有 host 上**能看到的实例（跨机聚合；上层 `LeasedSpawner` 会限定在自己持有的范围内）。 */
  async restartAllMains(): Promise<void> {
    for (const host of this.hosts.values()) {
      let instances: Array<{ userId: string }> = []
      try {
        const res = await this.call<{ instances: Array<{ userId: string }> }>(host, 'GET', '/instances')
        instances = res.instances
      } catch {
        continue // 该 host 不可达：跳过（心跳/告警负责暴露）
      }
      for (const inst of instances) {
        try {
          await this.restartMain(inst.userId, host.hostId)
        } catch {
          // 单台失败不打断其余（与 LocalSpawner 的语义一致）
        }
      }
    }
  }

  async spawnWatchdog(userId: string): Promise<Instance | undefined> {
    const host = await this.hostFor(userId)
    const res = await this.call<{ instance: Instance | null }>(host, 'POST', `/watchdog/${encodeURIComponent(userId)}`)
    return res.instance ?? undefined
  }

  async status(userId: string): Promise<UserStatus> {
    const host = await this.hostFor(userId)
    const res = await this.call<{ main: Instance | null }>(host, 'GET', `/status/${encodeURIComponent(userId)}`)
    return res.main === null ? {} : { main: res.main }
  }

  /** 代理目标：由**实例所在那台** agent 给端口（未运行 → undefined，代理会走冷启动分支）。 */
  async endpointFor(userId: string): Promise<Endpoint | undefined> {
    const host = await this.hostFor(userId)
    const res = await this.call<{ running: boolean; host?: string; port?: number }>(
      host,
      'GET',
      `/endpoint/${encodeURIComponent(userId)}`,
    )
    return res.running && res.host !== undefined && res.port !== undefined
      ? { host: res.host, port: res.port }
      : undefined
  }

  async stop(userId: string, hostId?: string): Promise<void> {
    const host = await this.hostFor(userId, hostId)
    await this.call(host, 'POST', '/stop', { userId }, randomUUID())
  }

  async teardown(): Promise<void> {
    // 远端实例的寿命长于任何单个 Manager 副本 ⇒ 由 Manager 的归属/租约管理，不在关闭时清。
  }

  /**
   * 等 launch token 出现（本地模式 = 启动完成的信号）。
   * 跨机后 token 由 agent 回传，语义不变；超时返回（不抛）—— 与本地实现一致。
   */
  async waitForLaunchTokenForUser(userId: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const st = await this.status(userId)
        if (st.main !== undefined && st.main.launchToken !== undefined) return
        if (st.main === undefined) return // 没实例/已停 ⇒ 立即返回（与本地实现一致）
      } catch {
        // 网络抖动：继续等
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  async restartAndProbe(userId: string, settleMs?: number): Promise<{ ok: boolean; reason: string }> {
    const host = await this.hostFor(userId)
    return this.call<{ ok: boolean; reason: string }>(
      host,
      'POST',
      `/restart-probe/${encodeURIComponent(userId)}`,
      settleMs === undefined ? {} : { settleMs },
    )
  }

  /** 活动信号：转发给**实例所在那台** agent，让它自己的 idle-reap 不误杀（fire-and-forget）。 */
  touch(userId: string): void {
    void this.hostFor(userId)
      .then((host) =>
        this.doFetch(`${host.agentUrl}/touch/${encodeURIComponent(userId)}`, {
          method: 'POST',
          headers: { [AGENT_TOKEN_HEADER]: host.token },
        }),
      )
      .catch(() => {
        /* 活动信号丢了不影响正确性 */
      })
  }

  async ensureFileService(_userId: string): Promise<void> {
    // worker 本机就有用户卷（local 语义）⇒ 无需 sidecar。跨机文件面由 RemoteUserFs（/fs/*）承担。
  }
}
