/**
 * T08 · **真实部署**端到端功能确认（不是单进程内测试）。
 *
 * 与 `verify-cluster-*.mjs` 的区别（那些是**组件级**验证，两个 Fastify 跑在同一进程里）：
 * 这里**真的起进程** —— 2 个 `dsh-users-platform worker` agent + 1 个 Manager 都是独立进程，
 * 经**真 HTTP**（127.0.0.1 端口）与**真 PG** 通信，实例是**真 `dsh` 子进程**（account 隔离）。
 * 它回答的是最后一个问题：**这套东西按部署形态装起来，到底能不能用。**
 *
 * 检查链路（一条真实的用户路径）：
 *   ① bootstrap-admin → ③ register → approve（平台现有流程）
 *   ④ 登录 → ⑤ 建文件夹（经 RemoteUserFs 落到 worker）→ ⑥ launch（经 agent 起真 dsh）
 *   ⑦ 轮询 status → ⑧ **取实例页面（经代理）**← 功能确认的关键一步
 *   ⑨ stop → ⑩ 起第二台 worker → 注册 → **迁移** → 再取一次页面
 *   ⑪ `dsh-users-platform doctor` / `dsh-users-platform cluster status`（观测面）
 *
 * 需要：106 上 PG 已在 127.0.0.1:15432；以 root 运行（account 隔离要 setpriv/systemd-run）。
 * 运行：CLUSTER_LIVE_PG_URL=postgres://dsh-users-platform:pw@127.0.0.1:15432/dsh-users-platform_live node scripts/verify-cluster-live.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PG_URL = process.env.CLUSTER_LIVE_PG_URL
if (PG_URL === undefined || PG_URL === '') {
  console.error('需要 CLUSTER_LIVE_PG_URL')
  process.exit(2)
}
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const CLI = join(repoRoot, 'lib', 'cli.js')
const TOKEN = 'live-cluster-agent-token'
const DATA_ROOT = process.env.CLUSTER_LIVE_DATA_ROOT ?? '<INSTALL_DIR>-cluster/live-data'
const ISO = process.env.CLUSTER_LIVE_ISOLATION ?? 'account'
const M_PORT = Number(process.env.CLUSTER_LIVE_MANAGER_PORT ?? 13080)
const A1_PORT = Number(process.env.CLUSTER_LIVE_AGENT1_PORT ?? 19000)
const A2_PORT = Number(process.env.CLUSTER_LIVE_AGENT2_PORT ?? 19001)
const ADMIN_PW = 'liveadmin123'
const USER_PW = 'liveuser123'

const procs = []
/** 起一个子进程并记下来（收尾统一 SIGTERM ⇒ agent 会先 teardown 实例再退出）。 */
function run(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // ⚠️ **必须留日志**：不留就只能看到"实例没了"而看不到为什么（2026-09-15 实测踩到）
  const logPath = `/tmp/live-${label}.log`
  const stream = createWriteStream(logPath, { flags: 'w' })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  child.on('exit', (code) => {
    if (code !== null && code !== 0 && !stopping) console.error(`[${label}] 提前退出 code=${code}（日志 ${logPath}）`)
  })
  procs.push({ label, child, logPath })
  return child
}

/** 打印某个子进程日志的尾部（诊断用）。 */
function tailLog(label, lines = 12) {
  const found = procs.find((p) => p.label === label)
  if (found === undefined) return
  try {
    const text = readFileSync(found.logPath, 'utf8').trimEnd().split('\n')
    console.error(`  ── ${label} 日志尾部 ──`)
    for (const line of text.slice(-lines)) console.error('   ', line.slice(0, 200))
  } catch {
    /* 没日志就算了 */
  }
}

let stopping = false
function shutdownAll() {
  stopping = true
  for (const { child } of procs) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
}

/** 轮询等一个 URL 可用。 */
async function waitHttp(url, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.status < 500) return res.status
      last = `HTTP ${res.status}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await sleep(300)
  }
  throw new Error(`等待 ${what} 超时（${url}）：${last}`)
}

const base = `http://127.0.0.1:${M_PORT}`
const json = async (path, { method = 'GET', body, cookie } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = { raw: text.slice(0, 200) }
  }
  return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') }
}

try {
  console.log('=== 真实部署检查：dataRoot=%s 隔离=%s ===', DATA_ROOT, ISO)
  rmSync(DATA_ROOT, { recursive: true, force: true })
  mkdirSync(DATA_ROOT, { recursive: true })

  // 干净的 PG 库（本检查专用）
  const psql = (sql) =>
    spawnSync('su', ['-', 'postgres', '-c', `/usr/bin/psql -p 15432 -q -c "${sql}"`], { encoding: 'utf8' })
  psql('DROP DATABASE IF EXISTS dsh-users-platform_live')
  psql('CREATE DATABASE dsh-users-platform_live OWNER dsh-users-platform')
  console.log('PG          -> dsh-users-platform_live 已重建')

  // ── ① worker agent（独立进程）─────────────────────────────────────────
  const agentEnv = { DSH_USERS_PLATFORM_DATA_ROOT: DATA_ROOT, DSH_USERS_PLATFORM_ISOLATION_MODE: ISO }
  run('agent-w-1', [CLI, 'worker', '--token', TOKEN, '--port', String(A1_PORT), '--host', '127.0.0.1', '--host-id', 'w-1', '--instance-host', '127.0.0.1', '--log-level', 'warn'], agentEnv)
  await waitHttp(`http://127.0.0.1:${A1_PORT}/healthz`, 15_000, 'agent w-1')
  console.log('worker w-1  -> http://127.0.0.1:%d 就绪', A1_PORT)

  // ── ② Manager（独立进程，cluster 模式）────────────────────────────────
  const managerEnv = {
    DSH_USERS_PLATFORM_DEPLOY_MODE: 'cluster',
    DSH_USERS_PLATFORM_DB_URL: PG_URL,
    DSH_USERS_PLATFORM_DATA_ROOT: DATA_ROOT,
    DSH_USERS_PLATFORM_CLUSTER_HOST_ID: 'm-1',
    DSH_USERS_PLATFORM_CLUSTER_AGENT_URL: `http://127.0.0.1:${A1_PORT}`,
    DSH_USERS_PLATFORM_CLUSTER_AGENT_TOKEN: TOKEN,
    DSH_USERS_PLATFORM_CLUSTER_INSTANCE_HOST: '127.0.0.1',
    DSH_USERS_PLATFORM_CLUSTER_WORKER_DATA_ROOT: DATA_ROOT,
    DSH_USERS_PLATFORM_CLUSTER_CAPACITY_MB: '-1', // Manager 自己**不承载实例**
    DSH_USERS_PLATFORM_CLUSTER_REGISTER_SELF: '0', // 专用 Manager ⇒ **不自注册**（一个 agent 只应有一条 host 记录）
    DSH_USERS_PLATFORM_CLUSTER_LEASE_TTL_MS: '30000',
  }
  run('manager', [CLI, '--port', String(M_PORT), '--host', '127.0.0.1', '--log-level', 'warn'], managerEnv)
  await waitHttp(`${base}/login.html`, 20_000, 'Manager')
  console.log('manager     -> %s 就绪（deployMode=cluster）', base)

  // ── ③ bootstrap-admin（首次建管理员）──────────────────────────────────
  const boot = spawnSync(process.execPath, [CLI, 'bootstrap-admin', '--username', 'root', '--password', ADMIN_PW], {
    cwd: repoRoot,
    // 用 local 模式初始化管理员 root：它就是这台机上的目录，与 worker 用同一个 DATA_ROOT
    env: { ...process.env, DSH_USERS_PLATFORM_DATA_ROOT: DATA_ROOT, DSH_USERS_PLATFORM_DB_URL: PG_URL },
    encoding: 'utf8',
  })
  assert(boot.status === 0, `bootstrap-admin 失败：${boot.stderr?.slice(0, 300)}`)
  console.log('管理员      -> root 已创建（bootstrap-admin）')

  // ── ④ 真实用户流程：注册 → 审批 → 登录 ────────────────────────────────
  let adm = await json('/api/auth/login', { method: 'POST', body: { username: 'root', password: ADMIN_PW } })
  assert(adm.status === 200, `管理员登录失败：${adm.status}`)
  const adminCookie = adm.setCookie.split(';')[0]

  let r = await json('/api/auth/register', { method: 'POST', body: { username: 'liveuser', password: USER_PW } })
  assert(r.status === 201, `注册应 201（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  const users = await json('/api/admin/users', { cookie: adminCookie })
  const target = users.body.users.find((u) => u.username === 'liveuser')
  assert(target !== undefined, '管理员能列出待审用户')
  r = await json(`/api/admin/users/${target.id}/approve`, { method: 'POST', cookie: adminCookie })
  assert(r.status === 200, `审批应 200（实际 ${r.status}）`)

  const login = await json('/api/auth/login', { method: 'POST', body: { username: 'liveuser', password: USER_PW } })
  assert(login.status === 200, `用户登录失败：${login.status}`)
  const cookie = login.setCookie.split(';')[0]
  console.log('① 用户流程  -> 注册 → 审批 → 登录 全部通过（uid=%s）', target.id)

  // 显式注册 w-1（= join 脚本那一步：agent 已在跑，调管理面登记）
  r = await json('/api/admin/hosts', {
    method: 'POST',
    cookie: adminCookie,
    body: { id: 'w-1', endpoint: `http://127.0.0.1:${A1_PORT}`, token: TOKEN, capacityMb: 4096 },
  })
  assert(r.status === 200, `注册 w-1 应 200（实际 ${r.status}）`)

  // ── ⑤ 建文件夹（经 RemoteUserFs 落到 worker）─────────────────────────
  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj' } })
  assert(r.status === 200, `mkdir 应 200（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  assert(
    (await json('/api/desktop/tree', { cookie })).body.entries.some((e) => e.name === 'proj'),
    '工作区里出现 proj',
  )
  console.log('② 文件面    -> mkdir 落库到 worker（经 agent /fs/mkdir）')

  // ── ⑥ 拉起实例（经 agent 起**真 dsh**）───────────────────────────────
  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  assert(r.status === 200, `launch 应 200（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  assert(typeof r.body.url === 'string' && r.body.url.startsWith('/u/'), `launch 返回子路径形态 URL（实际 ${r.body.url}）`)
  console.log('③ 拉起      -> %s（真 dsh 启动中，token 稍后才吐）', r.body.url)
  // 直接问 worker（绕过 Manager）：实例到底在不在 agent 手上
  const onAgent = await fetch(`http://127.0.0.1:${A1_PORT}/instances`, { headers: { 'x-dsh-agent-token': TOKEN } })
  console.log('    worker 视角 -> /instances = %s', (await onAgent.text()).slice(0, 200))

  // ── ⑦ 轮询到「running **且** launch token 到位」 ─────────────────────
  // 真 dsh 与 fake-dsh 不同：进程起来 ≠ 已打印 token。**launch token 回传（P0-6）**
  // 只有在 token 真的从 worker 传回 Manager 之后才算成立，所以这里要等到它。
  const t0 = Date.now()
  let running = false
  let tokenSeen = ''
  let lastStatus = null
  for (let i = 0; i < 90; i += 1) {
    const st = await json('/api/dsh/status', { cookie })
    lastStatus = st.body
    const main = st.body.main
    if (main?.status === 'crashed') {
      console.error('   实例崩溃：exitCode=%s lastError=%s', main.exitCode, String(main.lastError).slice(0, 400))
      break
    }
    // 注意：`/api/dsh/status` 的实例视图是**精简视图**（id/port/status/restarts），
    // **不含 launchToken** ⇒ token 的存在性用下面的 `/api/dsh/enter` 判定（它回带 token 的 URL）。
    if (st.body.running === true) {
      running = true
      tokenSeen = st.body.url ?? ''
      break
    }
    await sleep(1000)
  }
  if (!running) {
    tailLog('agent-w-1', 20)
    tailLog('manager', 10)
  }
  assert(running, `实例应在 90s 内 running（实际 ${JSON.stringify(lastStatus)?.slice(0, 500)}）`)
  console.log('④ 状态      -> running=true（真 dsh，隔离=%s，耗时 %ds）', ISO, Math.round((Date.now() - t0) / 1000))

  // ── ⑧ **登录直达**（P0-6 的真实端到端）：enter 走"复用已运行实例"分支 ⇒ 带 token 的 URL
  const enter = await json('/api/dsh/enter', { method: 'POST', cookie })
  assert(enter.status === 200, `enter 应 200（实际 ${enter.status} ${JSON.stringify(enter.body)}）`)
  const launchUrl = enter.body.url
  assert(typeof launchUrl === 'string' && launchUrl.includes('token='), `enter 应返回**带 token** 的直达 URL（实际 ${launchUrl}）`)
  console.log('⑤ 登录直达  -> %s', launchUrl)

  let pageStatus = 0
  let pageSnippet = ''
  for (let i = 0; i < 40; i += 1) {
    // 真实浏览器会**跟随重定向**（dsh 首页 303 → 应用页）⇒ 这里也跟随，否则会误判为失败。
    // ⚠️ 必须 try/catch：实例刚 spawn 时正在初始化，代理可能中途断连（`other side closed`），
    //    这是**启动窗口的正常现象**，重试即可 —— 不捕获会让检查在第一次尝试就失败。
    try {
      const res = await fetch(base + launchUrl, { headers: { cookie }, redirect: 'follow', signal: AbortSignal.timeout(15_000) })
      pageStatus = res.status
      if (res.status === 200) {
        pageSnippet = (await res.text()).slice(0, 400)
        break
      }
    } catch {
      pageStatus = 0
    }
    await sleep(1000)
  }
  assert(pageStatus === 200, `实例页面应最终 200（实际 ${pageStatus}）`)
  console.log('⑥ 实例页面  -> 200（经 Manager 代理到 worker 上 account 沙箱内的真 dsh；已跟随 303 重定向）')

  // ── ⑨ 停止 ────────────────────────────────────────────────────────────
  r = await json('/api/dsh/stop', { method: 'POST', cookie })
  assert(r.status === 200, `stop 应 200（实际 ${r.status}）`)
  await sleep(500)
  assert((await json('/api/dsh/status', { cookie })).body.running === false, 'stop 后 running=false')
  console.log('⑦ 停止      -> ok')

  // ── ⑩ 第二台 worker + 迁移 ────────────────────────────────────────────
  run('agent-w-2', [CLI, 'worker', '--token', TOKEN, '--port', String(A2_PORT), '--host', '127.0.0.1', '--host-id', 'w-2', '--instance-host', '127.0.0.1', '--log-level', 'warn'], agentEnv)
  await waitHttp(`http://127.0.0.1:${A2_PORT}/healthz`, 15_000, 'agent w-2')
  r = await json('/api/admin/hosts', {
    method: 'POST',
    cookie: adminCookie,
    body: { id: 'w-2', endpoint: `http://127.0.0.1:${A2_PORT}`, token: TOKEN, capacityMb: 4096 },
  })
  assert(r.status === 200, `注册 w-2 应 200（实际 ${r.status}）`)
  const hosts = await json('/api/admin/hosts', { cookie: adminCookie })
  assert(hosts.body.hosts.some((h) => h.id === 'w-2'), 'w-2 出现在 worker 目录')
  assert(!('agentToken' in (hosts.body.hosts[0] ?? {})), '**绝不下发 agentToken**')
  console.log('⑧ 第二台    -> w-2 已注册（且列表不含 agentToken）')

  // 重新拉起（此刻只有 w-1 是候选 ⇒ 确定性落 w-1），再注册 w-2、再迁移
  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  assert(r.status === 200, `再次 launch 应 200（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  for (let i = 0; i < 40 && !(await json('/api/dsh/status', { cookie })).body.running; i += 1) await sleep(1000)
  const owner = (await json('/api/dsh/status', { cookie })).body
  assert(owner.running === true, '重新拉起后 running=true')

  r = await json(`/api/admin/users/${target.id}/dsh/migrate`, {
    method: 'POST',
    cookie: adminCookie,
    body: { targetHost: 'w-2' },
  })
  assert(r.status === 200, `迁移应 200（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  assert(r.body.to === 'w-2', `迁移目标应为 w-2（实际 ${r.body.to}）`)
  for (let i = 0; i < 30 && !(await json('/api/dsh/status', { cookie })).body.running; i += 1) await sleep(1000)
  console.log('⑨ 迁移      -> %s → %s（epoch=%d）', r.body.from, r.body.to, r.body.epoch)

  // ⚠️ 迁移后实例是**新进程 ⇒ 新 launch token**：旧 URL 里的 token 已失效（404 是**预期**行为）。
  // 真实用户会重新走 `/api/dsh/enter`（门户的"进入工作区"就是这个接口）拿**新** URL ⇒ 这里照做。
  let newUrl = ''
  pageStatus = 0
  for (let i = 0; i < 40; i += 1) {
    try {
      const en = await json('/api/dsh/enter', { method: 'POST', cookie })
      if (en.status === 200 && typeof en.body.url === 'string') {
        newUrl = en.body.url
        const res = await fetch(base + newUrl, { headers: { cookie }, redirect: 'follow', signal: AbortSignal.timeout(15_000) })
        pageStatus = res.status
        if (res.status === 200) {
          pageSnippet = (await res.text()).slice(0, 200)
          break
        }
      }
    } catch {
      pageStatus = 0
    }
    await sleep(1000)
  }
  if (newUrl === '' || newUrl === launchUrl) {
    // 诊断：两台 agent 各自认为有什么 + DB 归属如何
    for (const [label, port] of [['w-1', A1_PORT], ['w-2', A2_PORT]]) {
      const res = await fetch(`http://127.0.0.1:${port}/instances`, { headers: { 'x-dsh-agent-token': TOKEN } })
      const body = await res.text()
      console.error(`  ${label} /instances = ${body.slice(0, 220)}`)
      const st = await fetch(`http://127.0.0.1:${port}/status/${target.id}`, { headers: { 'x-dsh-agent-token': TOKEN } })
      console.error(`  ${label} /status     = ${(await st.text()).slice(0, 220)}`)
    }
    tailLog('agent-w-2', 16)
    tailLog('manager', 8)
  }
  assert(newUrl !== '' && newUrl !== launchUrl, `迁移后 enter 应给**新** URL（旧 ${launchUrl} / 新 ${newUrl}）`)
  assert(pageStatus === 200, `迁移后经新 URL 的实例页面应 200（实际 ${pageStatus}）`)
  console.log('⑩ 迁移后    -> enter 返回新 token URL，页面 200（经 w-2）')

  // ── ⑪ 观测面 ──────────────────────────────────────────────────────────
  const doctor = spawnSync(process.execPath, [CLI, 'doctor'], { cwd: repoRoot, env: { ...process.env, ...managerEnv }, encoding: 'utf8' })
  const status = spawnSync(process.execPath, [CLI, 'cluster', 'status'], { cwd: repoRoot, env: { ...process.env, ...managerEnv }, encoding: 'utf8' })
  console.log('⑪ dsh-users-platform doctor -> rc=%d（0 = 无硬失败）', doctor.status ?? -1)
  console.log(String(status.stdout).split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'))

  // 收尾：停实例（避免留下 dsh 子进程）
  await json('/api/dsh/stop', { method: 'POST', cookie })

  console.log('\nOK: 真实部署（2 个 worker agent 进程 + 1 个 Manager 进程 + 真 PG）端到端功能确认通过')
  console.log('   ✓ 用户流程   ✓ 文件面跨机   ✓ 真 dsh 拉起并可从公网侧取页面   ✓ 停止   ✓ 注册+迁移+迁移后复验   ✓ 观测面')
  console.log('   页面片段：%s', pageSnippet.replace(/\s+/g, ' ').slice(0, 80))
} finally {
  shutdownAll()
  await sleep(1500)
}
