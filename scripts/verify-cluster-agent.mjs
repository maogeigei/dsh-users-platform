/**
 * T08 S3 · 端到端验证：**Manager 经 RemoteSpawner 把实例起在 worker agent 上**。
 *
 * 与 `smoke-dsh.mjs` 的区别：那条走的是"本机直接 spawn"，这条**多了一跳 HTTP**
 * （Manager → agent → LocalSpawner），因此它验证的是 S3 真正的交付物：
 *   ① 路由/代理层**一行没改**就能工作（`Spawner` 抽象 + `endpointFor` 的 host:port）；
 *   ② **launch token 回传**（P0-6）—— 否则"登录直达会话"与 401 自愈会失效；
 *   ③ **幂等键**：同一 operationId 重发不会起第二个实例（Manager 超时重试是常态）；
 *   ④ **self-fencing**：`/fence` 下发的 epoch 更高时，agent 主动停掉自己那个实例。
 *
 * 刻意用 **soft 隔离 + stand-in fake-dsh**：本测试要验的是**跨机协议**，
 * 不是沙箱（沙箱另有 S1.6 的双机证据）。用 account 模式反而会被"夹具路径必须在
 * 沙箱绑定集内"这条夹具限制干扰。
 *
 * 运行：node scripts/verify-cluster-agent.mjs
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { buildWorkerAgent, AGENT_TOKEN_HEADER } from '../lib/worker/agent.js'
import { resolveConfig } from '../lib/config.js'
import { hashPassword } from '../lib/web/auth.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const TOKEN = 'verify-cluster-agent-token'
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-cluster-'))
let agentApp
let agentHandle
let app

try {
  // ── 1) 起 worker agent（进程内，端口随机）──────────────────────────────
  const agentConfig = resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot,
    dshCommand: [process.execPath, fakeDsh],
    clusterHostId: 'w-1',
  })
  const agent = buildWorkerAgent(agentConfig, {
    hostId: 'w-1',
    token: TOKEN,
    port: 0,
    host: '127.0.0.1',
    instanceHost: '127.0.0.1',
    logLevel: 'warn',
  })
  agentApp = agent.app
  agentHandle = agent // 收尾要用 agent.stop()（会 teardown 本机实例），否则子进程孤儿化
  await agentApp.listen({ host: '127.0.0.1', port: 0 })
  const agentUrl = `http://127.0.0.1:${agentApp.server.address().port}`
  console.log('agent       ->', agentUrl)

  const agentJson = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(agentUrl + path, {
      method,
      headers: {
        [AGENT_TOKEN_HEADER]: TOKEN,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  // agent 存活 + 鉴权（不带 token 必须 401）
  const hz = await agentJson('/healthz')
  assert(hz.status === 200 && hz.body.hostId === 'w-1', 'agent healthz')
  const noAuth = await fetch(agentUrl + '/instances')
  assert(noAuth.status === 401, 'agent 拒绝无凭据请求')

  // ── 2) 起 Manager（deployMode=cluster → RemoteSpawner）─────────────────
  const managerConfig = resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot,
    deployMode: 'cluster',
    clusterAgentUrl: agentUrl,
    clusterAgentToken: TOKEN,
    clusterInstanceHost: '127.0.0.1',
  })
  app = await buildServer(managerConfig)
  await app.listen({ port: 0 })
  const base = `http://127.0.0.1:${app.server.address().port}`
  console.log('manager     ->', base, '(deployMode=cluster)')

  await app.db.createUser({
    id: 'u1',
    username: 'carol',
    passHash: await hashPassword('carolpass123'),
    role: 'active',
    homeDir: '/tmp/u1-home',
  })
  mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

  const json = async (path, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') }
  }

  // ── 3) 登录 → 拉起（实例实际落在 agent 上）────────────────────────────
  let r = await json('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'carolpass123' } })
  assert(r.status === 200, 'login succeeds')
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/status', { cookie })
  assert(r.body.running === false, 'not running initially')

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('launch      ->', r.status, r.body?.url ? 'url 已返回' : r.body)
  assert(r.status === 200, 'launch succeeds')
  // ② launch token 回传（P0-6）：URL 里必须带 token，否则"登录直达"失效
  assert(typeof r.body.url === 'string' && r.body.url.includes('token='), 'launch token 必须回传到 URL')

  // 实例真的在 **worker** 上（而不是 Manager 本机）
  const onAgent = await agentJson('/instances')
  assert(onAgent.body.instances.length === 1, 'worker 上有 1 个实例')
  assert(onAgent.body.instances[0].userId === 'u1', 'worker 上的实例属于 u1')
  console.log('agent 视角   -> 实例数', onAgent.body.instances.length)

  r = await json('/api/dsh/status', { cookie })
  assert(r.body.running === true, 'running after launch')

  // ── 4) 代理链路（endpointFor → agent 给的 host:port）──────────────────
  let proxyText
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch(`${base}/u/u1/dsh/hello`, { headers: { cookie } })
      if (res.status === 200) {
        proxyText = await res.text()
        break
      }
    } catch {
      /* 子进程还没监听，重试 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(proxyText !== undefined && proxyText.includes('fake-dsh'), 'proxy reaches the child DSH（经远端协议）')
  console.log('proxy       -> 200 且命中 fake-dsh')

  // ── 5) 幂等键：同 operationId 重发不得起第二个实例 ─────────────────────
  const opId = 'verify-idempotent-1'
  const l1 = await agentJson('/launch', { method: 'POST', body: { userId: 'u1', folder: join(dataRoot, 'users', 'u1', 'ws', 'proj'), patch: undefined, operationId: opId } })
  const l2 = await agentJson('/launch', { method: 'POST', body: { userId: 'u1', folder: join(dataRoot, 'users', 'u1', 'ws', 'proj'), patch: undefined, operationId: opId } })
  assert(l1.status === 200 && l2.status === 200, '重复 launch 不报错')
  const afterIdem = await agentJson('/instances')
  assert(afterIdem.body.instances.length === 1, '幂等：仍然只有 1 个实例')
  console.log('幂等        -> 同 operationId 重发后实例数仍为', afterIdem.body.instances.length)

  // ── 6) self-fencing：更高 epoch 下发 ⇒ agent 主动停掉自己那个实例 ───────
  await agentJson('/launch', { method: 'POST', body: { userId: 'u1', epoch: 1, operationId: 'verify-epoch-1' } })
  const f1 = await agentJson('/fence', { method: 'POST', body: { userId: 'u1', epoch: 1 } })
  assert(f1.body.fenced === false, 'epoch 相同 ⇒ 不被 fence')
  const f2 = await agentJson('/fence', { method: 'POST', body: { userId: 'u1', epoch: 2 } })
  assert(f2.body.fenced === true, 'epoch 更高 ⇒ self-fence')
  const afterFence = await agentJson('/instances')
  assert(afterFence.body.instances.length === 0, 'fence 后实例已停')
  console.log('self-fence  -> epoch 1→2 触发，实例已停止')

  // ── 7) 停止 ───────────────────────────────────────────────────────────
  r = await json('/api/dsh/stop', { method: 'POST', cookie })
  assert(r.status === 200, 'stop succeeds')
  r = await json('/api/dsh/status', { cookie })
  assert(r.body.running === false, 'stopped after stop')

  console.log('\nOK: cluster 模式（Manager → worker agent → 实例）端到端通过')
  console.log('   ✓ 路由/代理层零改动   ✓ launch token 回传   ✓ 幂等键   ✓ self-fencing')
} finally {
  await app?.close()
  // ⚠️ 必须走 agent.stop()：它先 teardown 本机实例再关 HTTP —— 否则 fake-dsh 孤儿会继承
  // stdout，管道不关 ⇒ ssh / CI 挂死（2026-09-15 实测）。
  await agentHandle?.stop()
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // best-effort：Windows 上子进程的 cwd 还在里面时会 EBUSY（temp 目录会被系统回收）
  }
}
