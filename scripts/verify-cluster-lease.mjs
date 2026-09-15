/**
 * T08 S4 · 归属租约端到端验证（1a 形态：多 Manager + 一个 worker agent + 共享 PG）。
 *
 * 验的是 S4 的四条承重行为：
 *   ① **归属真的落库**：launch 后 `dsh_instances` 有 `host_id` / `epoch` / `lease_until`；
 *   ② **单写者**：另一个 Manager（另一个 worker 身份）在租约存活期内**拉不起来**同一用户
 *      ⇒ 抛 `LeaseBusyError`（退让，不是接管）；
 *   ③ **stop 释放归属** ⇒ 别人立刻能接（不用等 TTL）；
 *   ④ **失权即 self-fence**：租约被抢走后，原持有者下一次心跳会把"更高 epoch"下发给 worker，
 *      由 worker **停掉自己那个实例**（防双写的最后一道防线）。
 *   ⑤ 顺带验**注册 + 心跳**：`dsh_hosts` 里有记录且 `last_heartbeat` 持续更新。
 *
 * 需要 PG（两个 Manager 必须共享 DB，否则谈不上"归属"）：
 *   CLUSTER_TEST_PG_URL=postgres://dsh-users-platform:pw@127.0.0.1:15432/dsh-users-platform_smoke node scripts/verify-cluster-lease.mjs
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  console.error('需要 CLUSTER_TEST_PG_URL（两个 Manager 必须共享同一个库）')
  process.exit(2)
}
const TOKEN = 'verify-cluster-lease-token'
const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-lease-'))

// 短 TTL：TTL=1200ms > 2×renew=500ms（满足不变量），便于在秒级制造"过期/被抢"
process.env.DSH_USERS_PLATFORM_CLUSTER_LEASE_TTL_MS = '1200'
process.env.DSH_USERS_PLATFORM_CLUSTER_LEASE_RENEW_MS = '500'

let agentApp
let agentHandle
const managers = []

/** 清空测试库里的三张表（该库专供本测试）。 */
async function resetPg() {
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query('DELETE FROM dsh_instances')
  await client.query('DELETE FROM dsh_hosts')
  await client.query('DELETE FROM users')
  await client.end()
}

/** 起一个 Manager（cluster 模式）。hostId 即"它绑定的 worker 身份"。 */
async function startManager(hostId) {
  const app = await buildServer(
    resolveConfig({
      port: 0,
      dbUrl: PG_URL,
      dataRoot,
      deployMode: 'cluster',
      clusterAgentUrl: agentUrl,
      clusterAgentToken: TOKEN,
      clusterInstanceHost: '127.0.0.1',
      clusterHostId: hostId,
    }),
  )
  await app.listen({ port: 0 })
  managers.push(app)
  return app
}

let agentUrl = ''

try {
  await resetPg()

  // ── 0) worker agent ───────────────────────────────────────────────────
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
  agentHandle = agent
  await agentApp.listen({ host: '127.0.0.1', port: 0 })
  agentUrl = `http://127.0.0.1:${agentApp.server.address().port}`
  const agentJson = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(agentUrl + path, {
      method,
      headers: { [AGENT_TOKEN_HEADER]: TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  // ── 1) 两个 Manager（不同 worker 身份）────────────────────────────────
  const m1 = await startManager('m-1')
  const m2 = await startManager('m-2')
  console.log('manager     -> m-1 %s / m-2 %s（共享 PG + 同一 agent）', m1.supervisor.hostId, m2.supervisor.hostId)

  await m1.db.createUser({
    id: 'u1',
    username: 'carol',
    passHash: await hashPassword('carolpass123'),
    role: 'active',
    homeDir: '/tmp/u1-home',
  })
  mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })
  const folder = join(dataRoot, 'users', 'u1', 'ws', 'proj')

  // ⑤ 注册 + 心跳：dsh_hosts 里应有记录（启动即注册 + 立即一次心跳）
  const hosts = await m1.db.listDshHosts()
  assert(hosts.length === 2, `dsh_hosts 应有 2 条（实际 ${hosts.length}）`)
  assert(hosts.every((h) => h.status === 'up' && h.lastHeartbeat !== null), 'worker 状态 up 且有心跳时间')
  console.log('注册/心跳   -> dsh_hosts =', hosts.map((h) => `${h.id}:${h.status}`).join(', '))

  // ── 2) m-1 拉起：归属必须落库 ─────────────────────────────────────────
  const inst1 = await m1.supervisor.launch('u1', folder)
  assert(inst1.userId === 'u1', 'launch 返回实例')
  let row = await m1.db.findUserInstance('u1', 'main')
  assert(row.hostId === 'm-1', `归属应落库为 m-1（实际 ${row.hostId}）`)
  assert(row.epoch === 1, `首次抢占 epoch 应为 1（实际 ${row.epoch}）`)
  assert(row.leaseUntil > Date.now(), 'lease_until 应在未来')
  console.log('① 归属落库  -> host_id=%s epoch=%d lease_until=+%dms', row.hostId, row.epoch, row.leaseUntil - Date.now())

  // worker 侧真的收到了 epoch=1（`/fence` 同值 ⇒ 不该被 fence）
  const f0 = await agentJson('/fence', { method: 'POST', body: { userId: 'u1', epoch: 1 } })
  assert(f0.body.fenced === false, 'worker 已记录 epoch=1（同值不 fence）')
  console.log('   worker 已记录 epoch=1')

  // ── 3) 单写者：m-2 在租约存活期内拉不起来 ────────────────────────────
  let busy
  try {
    await m2.supervisor.launch('u1', folder)
  } catch (err) {
    busy = err
  }
  assert(busy !== undefined, 'm-2 必须拉起失败')
  assert(busy.name === 'LeaseBusyError', `应是 LeaseBusyError（实际 ${busy.name}）`)
  assert(busy.holder === 'm-1', `错误里应带持有者 m-1（实际 ${busy.holder}）`)
  const stillMine = await m1.db.findUserInstance('u1', 'main')
  assert(stillMine.hostId === 'm-1' && stillMine.epoch === 1, '失败方不得改动归属')
  console.log('② 单写者    -> m-2 抛 LeaseBusyError(holder=%s)，归属未被改动', busy.holder)

  // ── 4) stop 释放 ⇒ 别人立刻能接（不用等 TTL）──────────────────────────
  await m1.supervisor.stop('u1')
  row = await m1.db.findUserInstance('u1', 'main')
  assert(row.hostId === null, 'stop 后归属应清空')

  // 多机语义（S6 起）：不显式指定目标机时由 `selectHost` 按容量挑"最优的那台"，
  // 不一定是 m-2 ⇒ 这一步要验的是"释放后可被接管"，所以**显式指定 m-2**（确定性）。
  const inst2 = await m2.supervisor.launch('u1', folder, undefined, { hostId: 'm-2' })
  assert(inst2.userId === 'u1', 'm-2 拉起成功')
  row = await m2.db.findUserInstance('u1', 'main')
  assert(row.hostId === 'm-2', `归属应转给 m-2（实际 ${row.hostId}）`)
  assert(row.epoch === 2, `epoch 必须递增到 2（实际 ${row.epoch}）`)
  console.log('③ 释放即接手 -> host_id=m-2 epoch=%d（epoch 单调递增）', row.epoch)

  // ── 5) 失权即 self-fence ─────────────────────────────────────────────
  // 让 m-2 也"死掉"（停心跳）→ 等待 TTL 过期 → m-1 抢占（epoch=3）
  m2.supervisor.stopHeartbeat()
  await sleep(1400)
  const stolen = await m1.db.claimInstance('u1', 'm-1', 60_000)
  assert(stolen.ok === true && stolen.epoch === 3, `m-1 过期后应能抢到 epoch=3（实际 ${JSON.stringify(stolen)}）`)
  console.log('   m-1 在租约过期后抢回（epoch=3）')

  // m-2 的下一跳心跳发现自己失权 ⇒ 给 worker 下发更高 epoch ⇒ worker 停掉自己那个实例
  const before = await agentJson('/instances')
  await m2.supervisor.tick()
  await sleep(200)
  const after = await agentJson('/instances')
  assert(after.body.instances.length === 0, `失权方心跳后实例应被停（前 ${before.body.instances.length} → 后 ${after.body.instances.length}）`)
  console.log('④ 失权即 fence -> worker 实例数 %d → %d（self-fencing 生效）', before.body.instances.length, after.body.instances.length)

  // 归属仍在 m-1 名下（fence 不会误清他人的归属）
  row = await m1.db.findUserInstance('u1', 'main')
  assert(row.hostId === 'm-1', 'fence 不该清掉持有者的归属')
  console.log('   归属仍在 m-1 名下（未被误清）')

  console.log('\nOK: 归属租约（1a 形态）端到端通过')
  console.log('   ✓ 归属落库   ✓ 单写者（LeaseBusyError）   ✓ 释放即接手   ✓ 失权即 self-fence   ✓ 注册+心跳')
} finally {
  for (const app of managers) await app?.close()
  await agentHandle?.stop()
  await sleep(500)
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
