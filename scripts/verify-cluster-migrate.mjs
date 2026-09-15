/**
 * T08 S6 · 多 worker + 容量准入 + **计划内迁移**验证。
 *
 * 这一条是整套设计的落点：**实例可迁移**。它同时验证：
 *   ① **容量准入**：`selectHost` 把"已用 + 预留 > 容量"的机排除掉 ⇒ 实例落到还有余量的那台；
 *   ② **归属与实例一致**：`dsh_instances.host_id` 指向实例真正所在的那台；
 *   ③ **迁移三步**（drain → 目标机拉起 → 归属原子更新）：`host_id` 换台、`epoch` 单调 +1；
 *   ④ **迁移后代理照常**：`endpointFor` 按新归属路由，页面仍 200；
 *   ⑤ **数据不搬家也能用**：两台 worker **共享同一 dataRoot**（模拟共享存储 / 同路径基线）。
 *
 * 需要 PG（归属在 DB 里，两个 Manager/worker 共享）：
 *   CLUSTER_TEST_PG_URL=postgres://dsh-users-platform:pw@127.0.0.1:15432/dsh-users-platform_smoke node scripts/verify-cluster-migrate.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { buildServer } from '../lib/web/server.js'
import { buildWorkerAgent, AGENT_TOKEN_HEADER } from '../lib/worker/agent.js'
import { resolveConfig } from '../lib/config.js'
import { hashPassword } from '../lib/web/auth.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PG_URL = process.env.CLUSTER_TEST_PG_URL
if (PG_URL === undefined || PG_URL === '') {
  console.error('需要 CLUSTER_TEST_PG_URL')
  process.exit(2)
}
const TOKEN = 'verify-cluster-migrate-token'
const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
/** 两台 worker **共享同一 dataRoot** = 模拟共享存储 / "所有 worker 同路径"的基线约定。 */
const sharedRoot = mkdtempSync(join(tmpdir(), 'dsh-migrate-'))

// Manager 自己不承载实例（capacity=-1）；两台 worker 声明 4096MB
process.env.DSH_USERS_PLATFORM_CLUSTER_CAPACITY_MB = '-1'

let app
const agents = []

async function resetPg() {
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query('DELETE FROM dsh_instances')
  await client.query('DELETE FROM dsh_hosts')
  await client.query('DELETE FROM users')
  await client.end()
}

async function startAgent(hostId) {
  const config = resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot: sharedRoot,
    dshCommand: [process.execPath, fakeDsh],
    clusterHostId: hostId,
  })
  const agent = buildWorkerAgent(config, {
    hostId,
    token: TOKEN,
    port: 0,
    host: '127.0.0.1',
    instanceHost: '127.0.0.1',
    logLevel: 'warn',
  })
  await agent.app.listen({ host: '127.0.0.1', port: 0 })
  agents.push(agent) // 整个 handle：收尾要用 stop() 收实例
  const url = `http://127.0.0.1:${agent.app.server.address().port}`
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: { [AGENT_TOKEN_HEADER]: TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  /** 该机上的实例数（对账口径）。 */
  const instanceCount = async () => (await call('/instances')).body.instances.length
  return { hostId, url, call, instanceCount }
}

try {
  await resetPg()

  // ── 0) 两台 worker ────────────────────────────────────────────────────
  const a = await startAgent('w-a')
  const b = await startAgent('w-b')
  console.log('worker      -> w-a %s / w-b %s（共享 dataRoot）', a.url, b.url)

  // ── 1) Manager（默认 agent 指 w-a；自己 capacity=-1 不承载）─────────────
  app = await buildServer(
    resolveConfig({
      port: 0,
      dbUrl: PG_URL,
      dataRoot: sharedRoot,
      deployMode: 'cluster',
      clusterAgentUrl: a.url,
      clusterAgentToken: TOKEN,
      clusterInstanceHost: '127.0.0.1',
      clusterHostId: 'm-1',
      clusterWorkerDataRoot: sharedRoot,
    }),
  )
  await app.listen({ port: 0 })
  const base = `http://127.0.0.1:${app.server.address().port}`

  // 注册两台 worker（join 脚本走的就是这个 API）
  await app.db.upsertDshHost({ id: 'w-a', endpoint: a.url, agentToken: TOKEN, capacityMb: 4096 })
  await app.db.upsertDshHost({ id: 'w-b', endpoint: b.url, agentToken: TOKEN, capacityMb: 4096 })
  // 把 w-b 的已用水位抬高到"再来一个实例就超" ⇒ 用来验证**准入拒绝**
  await app.db.setDshHostStatus('w-b', 'up', 3800, Date.now())

  // admin 账号（迁移 API 需要）
  await app.db.createUser({
    id: 'admin-1',
    username: 'root',
    passHash: await hashPassword('rootpass123'),
    role: 'admin',
    homeDir: '/tmp/admin-home',
  })
  await app.db.createUser({
    id: 'u1',
    username: 'carol',
    passHash: await hashPassword('carolpass123'),
    role: 'active',
    homeDir: '/tmp/u1-home',
  })
  await app.userFs.initUserRoot('u1')
  // 门户流程里 folder 是用户从「我的文件」里挑的**已存在**目录 ⇒ 这里先建出来
  mkdirSync(join(sharedRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

  const json = async (path, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') }
  }

  // ── 2) 容量准入：w-b 水位高 ⇒ 必须落到 w-a ────────────────────────────
  const c = await json('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'carolpass123' } })
  assert(c.status === 200, 'user login')
  const userCookie = c.setCookie.split(';')[0]

  let r = await json('/api/dsh/launch', { method: 'POST', cookie: userCookie, body: { folder: 'proj' } })
  assert(r.status === 200, `launch 经远端成功（实际 ${r.status} ${JSON.stringify(r.body)}）`)

  let row = await app.db.findUserInstance('u1', 'main')
  assert(row.hostId === 'w-a', `容量准入应选 w-a（w-b 已 3800+512>4096）；实际 ${row.hostId}`)
  assert(row.epoch === 1, `首次抢占 epoch=1（实际 ${row.epoch}）`)
  assert((await a.instanceCount()) === 1, 'w-a 上有 1 个实例')
  assert((await b.instanceCount()) === 0, 'w-b 上 0 个实例')
  console.log('① 容量准入  -> 落到 w-a（w-b 因水位被排除），host_id=w-a epoch=1')

  // 代理照常
  let proxyText
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${base}/u/u1/dsh/hello`, { headers: { cookie: userCookie } })
    if (res.status === 200) {
      proxyText = await res.text()
      break
    }
    await sleep(100)
  }
  assert(proxyText !== undefined && proxyText.includes('fake-dsh'), '迁移前代理 200（经 w-a）')
  console.log('   迁移前代理 -> 200（经 w-a）')

  // 顺便在用户工作区放个文件（迁移后要还在 —— 共享存储场景）
  await json('/api/fs/upload', {
    method: 'POST',
    cookie: userCookie,
    body: { path: 'proj', name: 'keep.txt', data: Buffer.from('survives migration').toString('base64') },
  })

  // ── 3) 迁移到 w-b ─────────────────────────────────────────────────────
  const adm = await json('/api/auth/login', { method: 'POST', body: { username: 'root', password: 'rootpass123' } })
  assert(adm.status === 200, 'admin login')
  const adminCookie = adm.setCookie.split(';')[0]

  r = await json('/api/admin/users/u1/dsh/migrate', {
    method: 'POST',
    cookie: adminCookie,
    body: { targetHost: 'w-b' },
  })
  assert(r.status === 200, `迁移成功（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  assert(r.body.from === 'w-a' && r.body.to === 'w-b', `迁移方向 w-a→w-b（实际 ${JSON.stringify(r.body)}）`)
  assert(r.body.epoch === 2, `epoch 应 +1 到 2（实际 ${r.body.epoch}）`)
  row = await app.db.findUserInstance('u1', 'main')
  assert(row.hostId === 'w-b' && row.epoch === 2, '归属已原子更新到 w-b / epoch=2')
  assert((await a.instanceCount()) === 0, 'w-a 上实例已停（drain 生效）')
  assert((await b.instanceCount()) === 1, 'w-b 上有 1 个实例')
  console.log('② 迁移      -> w-a → w-b，host_id=w-b epoch=%d，源机实例已停', r.body.epoch)

  // 迁移后代理照常（按新归属路由到 w-b）
  proxyText = undefined
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${base}/u/u1/dsh/hello`, { headers: { cookie: userCookie } })
    if (res.status === 200) {
      proxyText = await res.text()
      break
    }
    await sleep(100)
  }
  assert(proxyText !== undefined && proxyText.includes('fake-dsh'), '迁移后代理 200（经 w-b）')

  // ── 4) 数据还在（共享存储）────────────────────────────────────────────
  const keptPath = join(sharedRoot, 'users', 'u1', 'ws', 'proj', 'keep.txt')
  assert(existsSync(keptPath), `迁移后文件仍在：${keptPath}`)
  const dl = await fetch(`${base}/api/fs/download?path=proj/keep.txt`, { headers: { cookie: userCookie } })
  assert(dl.status === 200 && (await dl.text()) === 'survives migration', '迁移后仍能下载到原文')
  console.log('③ 迁移后    -> 代理 200（经 w-b）、文件可读（数据不搬家）')

  // ── 5) 已在该机 + 目标机不存在 ⇒ 明确报错（不静默）────────────────────
  r = await json('/api/admin/users/u1/dsh/migrate', { method: 'POST', cookie: adminCookie, body: { targetHost: 'w-b' } })
  assert(r.status === 409 && r.body.error === 'already_there', `重复迁移应 409 already_there（实际 ${r.status}）`)
  r = await json('/api/admin/users/u1/dsh/migrate', { method: 'POST', cookie: adminCookie, body: { targetHost: 'nope' } })
  assert(r.status === 404 && r.body.error === 'unknown_host', `未知目标机应 404（实际 ${r.status}）`)
  console.log('④ 边界      -> already_there / unknown_host 都明确报错')

  console.log('\nOK: 多 worker + 容量准入 + 迁移通过')
  console.log('   ✓ 容量准入   ✓ 归属与实例一致   ✓ 迁移(drain→拉起→epoch+1)   ✓ 迁移后代理/文件正常')
} finally {
  // ⚠️ 收尾必须**停掉还活着的实例**：否则 fake-dsh 子进程会继承 stdout，
  // 管道永不关闭 ⇒ ssh / CI 会一直挂在这里（2026-09-15 实测踩到）。
  try {
    await app?.supervisor?.stop('u1')
  } catch {
    /* best-effort */
  }
  await app?.close()
  for (const h of agents) await h?.stop()
  await sleep(500)
  try {
    rmSync(sharedRoot, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
