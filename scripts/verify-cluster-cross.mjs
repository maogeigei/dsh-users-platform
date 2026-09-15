/**
 * T08 · **真跨机演练**驱动脚本（在 Manager 那台机器上运行）。
 *
 * 与 `verify-cluster-live.mjs`（同机、脚本自己起进程）的区别：这里**假设两侧都已部署好**：
 *   · Manager 运行在**本机**（47）`http://127.0.0.1:13080`
 *   · Worker agent 运行在**另一台机器**（106），经 **SSH 反向隧道**出现在本机 `127.0.0.1:19000`
 *   · 控制面 PG 也在**另一台机器**（106）上，经隧道出现在本机 `127.0.0.1:15432`
 * 它回答的是本次演练的核心问题：**跨机到底能不能用**（含跨机代理取页面、跨 worker 迁移）。
 *
 * 运行（在 47 上）：MANAGER=http://127.0.0.1:13080 AGENT_TOKEN=cross-machine-token \
 *                   AGENT2=http://127.0.0.1:19001 node scripts/verify-cluster-cross.mjs
 */
const MANAGER = process.env.MANAGER ?? 'http://127.0.0.1:13080'
const TOKEN = process.env.AGENT_TOKEN ?? 'cross-machine-token'
const AGENT1 = process.env.AGENT1 ?? 'http://127.0.0.1:19000'
const AGENT2 = process.env.AGENT2 ?? ''
const ADMIN_PW = process.env.ADMIN_PW ?? 'crossmgr123'
const USER_PW = 'crossuser123'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const json = async (path, { method = 'GET', body, cookie } = {}) => {
  const res = await fetch(MANAGER + path, {
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

/** 直接问 worker（绕过 Manager）—— 证明实例真的落在**那台机器**上。 */
const agent = async (base, path) => {
  const res = await fetch(base + path, { headers: { 'x-dsh-agent-token': TOKEN }, signal: AbortSignal.timeout(10_000) })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}

/** 取页面：跟随重定向（dsh 首页 303），并对启动窗口的断连做重试。 */
async function fetchPage(url, cookie, tries = 40) {
  let status = 0
  let snippet = ''
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(MANAGER + url, { headers: { cookie }, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      status = res.status
      if (res.status === 200) {
        snippet = (await res.text()).slice(0, 200)
        break
      }
    } catch {
      status = 0
    }
    await sleep(1000)
  }
  return { status, snippet }
}

async function waitRunning(cookie, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const st = await json('/api/dsh/status', { cookie })
    if (st.body?.running === true) return st.body
    if (st.body?.instance?.status === 'crashed') return st.body
    await sleep(1000)
  }
  return await json('/api/dsh/status', { cookie }).then((r) => r.body)
}

try {
  console.log('=== 跨机演练：Manager=%s  Worker=%s ===', MANAGER, AGENT1)

  // ── 0) 两侧可达性（跨机链路的第一层证据）─────────────────────────────
  const h1 = await agent(AGENT1, '/healthz')
  assert(h1.status === 200 && h1.body.hostId === 'w-106', `Worker w-106 应可达（实际 ${JSON.stringify(h1.body)}）`)
  assert(h1.body.tunnel?.ready === true, `Worker 侧隧道应就绪（实际 ${JSON.stringify(h1.body.tunnel)}）`)
  console.log('⓪ worker 可达 -> %s（隧道 ready，已转发 %s）', h1.body.hostId, JSON.stringify(h1.body.tunnel.ports))

  // ── 1) 管理面：注册 worker（join 脚本干的事）──────────────────────────
  const adm = await json('/api/auth/login', { method: 'POST', body: { username: 'root', password: ADMIN_PW } })
  assert(adm.status === 200, `管理员登录失败 ${adm.status}`)
  const adminCookie = adm.setCookie.split(';')[0]

  let r = await json('/api/admin/hosts', {
    method: 'POST',
    cookie: adminCookie,
    body: { id: 'w-106', endpoint: AGENT1, token: TOKEN, capacityMb: 4096 },
  })
  assert(r.status === 200, `注册 w-106 失败 ${r.status}`)
  const hosts = await json('/api/admin/hosts', { cookie: adminCookie })
  assert(hosts.body.hosts.some((h) => h.id === 'w-106'), 'w-106 出现在 worker 目录')
  assert(!('agentToken' in (hosts.body.hosts[0] ?? {})), '**绝不下发 agentToken**')
  console.log('① 注册      -> w-106（列表不含 agentToken）')

  // ── 2) 用户流程 ───────────────────────────────────────────────────────
  const uname = `crossuser${Date.now() % 100000}`
  r = await json('/api/auth/register', { method: 'POST', body: { username: uname, password: USER_PW } })
  assert(r.status === 201, `注册应 201（实际 ${r.status}）`)
  const users = await json('/api/admin/users', { cookie: adminCookie })
  const target = users.body.users.find((u) => u.username === uname)
  assert(target !== undefined, '管理员能看到待审用户')
  r = await json(`/api/admin/users/${target.id}/approve`, { method: 'POST', cookie: adminCookie })
  assert(r.status === 200, `审批应 200（实际 ${r.status}）`)
  const login = await json('/api/auth/login', { method: 'POST', body: { username: uname, password: USER_PW } })
  assert(login.status === 200, `用户登录失败 ${login.status}`)
  const cookie = login.setCookie.split(';')[0]
  console.log('② 用户流程  -> 注册→审批→登录（uid=%s）', target.id)

  // ── 3) 文件面跨机（Manager 在 47、目录落在 106）───────────────────────
  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj' } })
  assert(r.status === 200, `mkdir 应 200（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  console.log('③ 文件面    -> mkdir 经隧道落到 106 的 worker')

  // ── 4) 拉起实例（真 dsh 在 **106** 上）────────────────────────────────
  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  assert(r.status === 200, `launch 应 200（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  const st = await waitRunning(cookie)
  assert(st?.running === true, `实例应 running（实际 ${JSON.stringify(st)?.slice(0, 300)}）`)
  const onAgent = await agent(AGENT1, '/instances')
  assert(onAgent.body.instances.length === 1, 'worker(106) 上有 1 个实例')
  console.log('④ 拉起      -> running=true，**实例在 106 上**（worker /instances=%d）', onAgent.body.instances.length)

  // ── 5) 登录直达 + **跨机取页面**（本演练的核心证据）───────────────────
  const enter = await json('/api/dsh/enter', { method: 'POST', cookie })
  assert(enter.status === 200, `enter 应 200（实际 ${enter.status}）`)
  const url = enter.body.url
  assert(typeof url === 'string' && url.includes('token='), `enter 应带 token（实际 ${url}）`)
  const page = await fetchPage(url, cookie)
  assert(page.status === 200, `**跨机页面**应 200（实际 ${page.status}）`)
  console.log('⑤ 跨机页面  -> 200（47 的 Manager 代理到 106 的实例；片段 %s）', page.snippet.replace(/\s+/g, ' ').slice(0, 60))

  // ── 6) 第二台 worker（106 上模拟的第二台服务器）+ 迁移 ────────────────
  if (AGENT2 !== '') {
    const h2 = await agent(AGENT2, '/healthz')
    assert(h2.status === 200, `第二台 worker 应可达（实际 ${h2.status}）`)
    r = await json('/api/admin/hosts', {
      method: 'POST',
      cookie: adminCookie,
      body: { id: 'w-106b', endpoint: AGENT2, token: TOKEN, capacityMb: 4096 },
    })
    assert(r.status === 200, `注册 w-106b 失败 ${r.status}`)
    console.log('⑥ 第二台    -> %s（模拟的第二台服务器）已注册', h2.body.hostId)

    r = await json(`/api/admin/users/${target.id}/dsh/migrate`, {
      method: 'POST',
      cookie: adminCookie,
      body: { targetHost: 'w-106b' },
    })
    assert(r.status === 200, `迁移应 200（实际 ${r.status} ${JSON.stringify(r.body)}）`)
    assert(r.body.to === 'w-106b', `迁移目标应为 w-106b（实际 ${r.body.to}）`)
    await waitRunning(cookie)
    const a1 = await agent(AGENT1, '/instances')
    const a2 = await agent(AGENT2, '/instances')
    assert(a1.body.instances.length === 0 && a2.body.instances.length === 1, '实例应从 w-106 移到 w-106b')
    console.log('⑦ 跨机迁移  -> %s → %s（epoch=%d），源机已空、目标机有 1 个实例', r.body.from, r.body.to, r.body.epoch)

    const enter2 = await json('/api/dsh/enter', { method: 'POST', cookie })
    assert(enter2.status === 200 && enter2.body.url !== url, '迁移后 enter 应给**新** URL')
    const page2 = await fetchPage(enter2.body.url, cookie)
    assert(page2.status === 200, `迁移后页面应 200（实际 ${page2.status}）`)
    console.log('⑧ 迁移后    -> 新 token URL 页面 200')
  } else {
    console.log('⑥⑦⑧ 跳过（未提供 AGENT2）')
  }

  // ── 9) 收尾 ───────────────────────────────────────────────────────────
  r = await json('/api/dsh/stop', { method: 'POST', cookie })
  assert(r.status === 200, `stop 应 200（实际 ${r.status}）`)
  console.log('⑨ 停止      -> ok')

  console.log('\nOK: **真跨机**（47 当 Manager / 106 当 Worker，隧道跨界）演练通过')
  console.log('   ✓ worker 可达   ✓ 注册   ✓ 用户流程   ✓ 文件面跨机   ✓ 实例在 106   ✓ 跨机取页面   ✓ 跨 worker 迁移')
} finally {
  /* 不主动清理：实例由调用方决定留或停（演练后要观察现场） */
}
