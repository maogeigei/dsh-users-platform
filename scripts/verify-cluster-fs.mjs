/**
 * T08 S5 · 跨机文件面验证。
 *
 * 关键设计：**Manager 的 `dataRoot` 故意与 worker 的 `dataRoot` 不同** ——
 * 只有这样"文件面真的走了远端"才被证明；若两个 root 相同，本地实现也能碰巧通过。
 *
 * 验的是：
 *   ① 门户的路由（`/api/desktop/tree`、`/api/fs/*`）在 cluster 模式下照常工作（**路由零改动**）；
 *   ② 文件**落在 worker 的 dataRoot 下**、且**不在** Manager 的 dataRoot 下；
 *   ③ 路径安全与本地**同源**（`bad_path` 走同一条 `resolveWithinRoot`）；
 *   ④ `resolvePath` 返回的是**实例眼里的路径**（按 worker 的 dataRoot 算）。
 *
 * 运行：node scripts/verify-cluster-fs.mjs
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
const TOKEN = 'verify-cluster-fs-token'
const workerRoot = mkdtempSync(join(tmpdir(), 'dsh-cfs-worker-'))
const managerRoot = mkdtempSync(join(tmpdir(), 'dsh-cfs-manager-'))
let agentApp
let agentHandle
let app

try {
  // ── worker agent（dataRoot = workerRoot）────────────────────────────────
  const agent = buildWorkerAgent(
    resolveConfig({ port: 0, dbPath: ':memory:', dataRoot: workerRoot, dshCommand: [process.execPath, fakeDsh], clusterHostId: 'w-1' }),
    { hostId: 'w-1', token: TOKEN, port: 0, host: '127.0.0.1', instanceHost: '127.0.0.1', logLevel: 'warn' },
  )
  agentApp = agent.app
  agentHandle = agent
  await agentApp.listen({ host: '127.0.0.1', port: 0 })
  const agentUrl = `http://127.0.0.1:${agentApp.server.address().port}`
  console.log('worker      -> dataRoot %s', workerRoot)

  // ── Manager（dataRoot = managerRoot ≠ workerRoot；显式告知 worker 的 root）──
  app = await buildServer(
    resolveConfig({
      port: 0,
      dbPath: ':memory:',
      dataRoot: managerRoot,
      deployMode: 'cluster',
      clusterAgentUrl: agentUrl,
      clusterAgentToken: TOKEN,
      clusterInstanceHost: '127.0.0.1',
      clusterHostId: 'm-1',
      clusterWorkerDataRoot: workerRoot,
    }),
  )
  await app.listen({ port: 0 })
  const base = `http://127.0.0.1:${app.server.address().port}`
  console.log('manager     -> dataRoot %s（与 worker 不同 ⇒ 能证明走远端）', managerRoot)

  const json = async (path, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') }
  }

  await app.db.createUser({
    id: 'u1',
    username: 'bob',
    passHash: await hashPassword('bobpass123'),
    role: 'active',
    homeDir: '/tmp/u1-home',
  })
  // 用户根必须建在 **worker 上**（这一步本身就走远端）
  await app.userFs.initUserRoot('u1')

  // ④ resolvePath = 实例眼里的路径（按 worker 的 dataRoot）
  const resolved = app.userFs.resolvePath('u1', 'proj')
  assert(resolved === join(workerRoot, 'users', 'u1', 'ws', 'proj'), `resolvePath 应按 worker 的 root 计算（实际 ${resolved}）`)
  console.log('④ resolvePath -> %s', resolved)

  // ── ① 门户路由（零改动）──────────────────────────────────────────────
  let r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, 'login succeeds')
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/desktop/tree', { cookie })
  assert(r.status === 200 && r.body.entries.length === 0, '空工作区列出 0 项')

  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj' } })
  assert(r.status === 200, `mkdir 经远端成功（实际 ${r.status} ${JSON.stringify(r.body)}）`)

  r = await json('/api/fs/upload', {
    method: 'POST',
    cookie,
    body: { path: 'proj', name: 'hello.txt', data: Buffer.from('hi there').toString('base64') },
  })
  assert(r.status === 200, `upload 经远端成功（实际 ${r.status}）`)

  r = await json('/api/desktop/tree', { cookie })
  assert(r.status === 200 && r.body.entries.length === 1, '工作区里出现了 proj')
  console.log('① 门户路由  -> tree/mkdir/upload 全部经远端通过')

  // ── ② 文件真的落在 worker 上 ──────────────────────────────────────────
  const onWorker = join(workerRoot, 'users', 'u1', 'ws', 'proj', 'hello.txt')
  const onManager = join(managerRoot, 'users', 'u1', 'ws', 'proj', 'hello.txt')
  assert(existsSync(onWorker), `文件应落在 worker：${onWorker}`)
  assert(!existsSync(onManager), `文件不该出现在 Manager 本地：${onManager}`)
  console.log('② 落点       -> worker 有、manager 无（确认走远端）')

  // ── ③ 路径安全与本地同源 ──────────────────────────────────────────────
  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: '../evil' } })
  assert(r.status === 400 && r.body.error === 'bad_path', `越界路径应 400 bad_path（实际 ${r.status} ${JSON.stringify(r.body)}）`)
  for (const bad of ['..', '../../etc']) {
    let threw = false
    try {
      app.userFs.resolvePath('u1', bad)
    } catch (err) {
      threw = err.code === 'bad_path'
    }
    assert(threw, `resolvePath(${bad}) 应抛 bad_path`)
  }
  console.log('③ 路径安全  -> bad_path 与本地同源（走同一个 resolveWithinRoot）')

  // 下载回读（readFile 经远端）—— 注意该路由回的是**原始字节**，不是 JSON
  const dl = await fetch(`${base}/api/fs/download?path=proj/hello.txt`, { headers: { cookie } })
  assert(dl.status === 200, `download 经远端成功（实际 ${dl.status}）`)
  const downloaded = await dl.text()
  assert(downloaded === 'hi there', `下载内容应为上传的原文（实际 ${JSON.stringify(downloaded)}）`)
  console.log('   下载回读   -> readFile 经远端成功（内容逐字一致）')

  console.log('\nOK: 跨机文件面（RemoteUserFs → agent /fs/*）通过')
  console.log('   ✓ 门户路由零改动   ✓ 落在 worker   ✓ 路径安全同源   ✓ resolvePath 按 worker 计算')
} finally {
  await app?.close()
  await agentHandle?.stop()
  await new Promise((r) => setTimeout(r, 300))
  for (const dir of [workerRoot, managerRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}
