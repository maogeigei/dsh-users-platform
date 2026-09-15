/**
 * T08 S2 · 实例归属租约单测。
 *
 * 刻意**不 mock 时钟**：走真实 SQL（SqliteAdapter(':memory:')）并用**极短 TTL** 制造过期，
 * 这样测到的是"SQL 的原子抢占真的成立"，而不是"我的假时钟算对了"。
 *
 * 两个后端都跑（同 T08 S1 的做法）：默认 SQLite（内存库，每用例一份）；
 * 设 `LEASETEST_PG_URL=postgres://…` 时改跑 PG —— 用来验证两套实现语义一致。
 * 运行：node --test test/lease.test.mjs
 *       LEASETEST_PG_URL=postgres://dsh-users-platform:pw@127.0.0.1:15432/dsh-users-platform_smoke node --test test/lease.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { SqliteAdapter } from '../lib/db/sqlite.js'
import { openPgAdapter } from '../lib/db/pg.js'
import { InstanceLease, stillHolder, DEFAULT_LEASE_TTL_MS } from '../lib/supervisor/lease.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PG_URL = process.env.LEASETEST_PG_URL

/** PG 侧：每个用例前清空三张表（该库专供本测试，清空是安全的）。 */
async function resetPg() {
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query('DELETE FROM dsh_instances')
  await client.query('DELETE FROM dsh_hosts')
  await client.query('DELETE FROM users')
  await client.end()
}

/** 每个用例一个独立后端（SQLite = 新内存库；PG = 清空后的专用库）。 */
async function freshDb() {
  const db = PG_URL === undefined ? new SqliteAdapter(':memory:', 100000) : await openPgAdapter(PG_URL, 100000)
  if (PG_URL !== undefined) await resetPg()
  await db.createUser({
    id: 'u1',
    username: 'alice',
    passHash: 'x',
    role: 'active',
    homeDir: '/tmp/u1',
  })
  return db
}

/** 短 TTL 的租约（ttl=60ms > 2×20ms，满足不变量）。 */
function shortLease(db, hostId) {
  return new InstanceLease(db, hostId, { ttlMs: 60, renewMs: 20 })
}

test('lease: 默认时序满足 ttl > 2×renew 不变量', () => {
  assert.ok(DEFAULT_LEASE_TTL_MS > 2 * 10_000, '默认 30s TTL 必须 > 2×10s 续租')
})

test('lease: 违反不变量时构造即抛（fail-loud，防抖动误判）', async () => {
  const db = await freshDb()
  assert.throws(() => new InstanceLease(db, 'w-a', { ttlMs: 100, renewMs: 60 }), /ttlMs/)
  await db.close()
})

test('lease: 首次抢占成功，epoch 从 1 开始', async () => {
  const db = await freshDb()
  const a = new InstanceLease(db, 'w-a', { ttlMs: 5000, renewMs: 1000 })
  const r = await a.acquire('u1')
  assert.equal(r.ok, true)
  assert.equal(r.epoch, 1)
  assert.ok(r.leaseUntil > Date.now(), '租约应在未来')
  assert.deepEqual(a.holdings().get('u1'), { epoch: 1, hostId: 'w-a' })
  await db.close()
})

test('lease: 未过期时他人抢占失败 —— 单写者保证', async () => {
  const db = await freshDb()
  const a = new InstanceLease(db, 'w-a', { ttlMs: 5000, renewMs: 1000 })
  const b = new InstanceLease(db, 'w-b', { ttlMs: 5000, renewMs: 1000 })
  assert.equal((await a.acquire('u1')).ok, true)

  const r = await b.acquire('u1')
  assert.equal(r.ok, false, '有人在管 ⇒ 必须退让')
  assert.equal(r.holder, 'w-a')
  assert.equal(b.holdings().has('u1'), false, '失败不得写入本地持有记录')
  await db.close()
})

test('lease: 续租必须带 epoch —— 旧持有者续租失败（fencing 生效）', async () => {
  const db = await freshDb()
  const a = shortLease(db, 'w-a')
  assert.equal((await a.acquire('u1')).ok, true)
  const staleEpoch = a.holdings().get('u1').epoch

  await sleep(90) // 让租约过期
  const b = shortLease(db, 'w-b')
  const taken = await b.acquire('u1')
  assert.equal(taken.ok, true, '过期后可被抢占')
  assert.equal(taken.epoch, staleEpoch + 1, 'epoch 必须递增')

  // 老持有者拿着旧 epoch 续租 ⇒ 必须失败（否则就脑裂双写了）
  assert.equal(await a.renew('u1'), false)
  assert.equal(a.holdings().has('u1'), false, '失权后必须清掉本地记录（供 self-fence）')

  // 直接调 DB 层也一样：epoch 不匹配 → 不更新
  assert.equal(await db.renewInstanceLease('u1', 'w-a', staleEpoch, 60), false)
  assert.equal(await b.renew('u1'), true, '新持有者续租成功')
  await db.close()
})

test('lease: 释放后归零，可再次抢占且 epoch 继续递增', async () => {
  const db = await freshDb()
  const a = new InstanceLease(db, 'w-a', { ttlMs: 5000, renewMs: 1000 })
  await a.acquire('u1')
  assert.equal(await a.release('u1'), true)
  assert.equal(a.holdings().has('u1'), false)

  const inst = await db.findUserInstance('u1', 'main')
  assert.equal(inst.hostId, null, '释放 = 归属清空')
  assert.equal(stillHolder(inst, 'w-a', 1), false)

  const b = new InstanceLease(db, 'w-b', { ttlMs: 5000, renewMs: 1000 })
  const r = await b.acquire('u1')
  assert.equal(r.ok, true)
  assert.equal(r.epoch, 2, 'epoch 单调递增（不复用）')
  await db.close()
})

test('lease: release 也带 epoch 校验 —— 老持有者不能清掉新持有者的归属', async () => {
  const db = await freshDb()
  const a = shortLease(db, 'w-a')
  await a.acquire('u1')
  await sleep(90)
  const b = shortLease(db, 'w-b')
  await b.acquire('u1')

  // a 试图释放（它本地已失权 ⇒ release 返回 false 且不动 DB）
  assert.equal(await a.release('u1'), false)
  const inst = await db.findUserInstance('u1', 'main')
  assert.equal(inst.hostId, 'w-b', '新持有者的归属不能被误清')
  await db.close()
})

test('lease: stillHolder 判据（hostId + epoch 双匹配）', async () => {
  const db = await freshDb()
  const a = new InstanceLease(db, 'w-a', { ttlMs: 5000, renewMs: 1000 })
  await a.acquire('u1')
  const inst = await db.findUserInstance('u1', 'main')

  assert.equal(stillHolder(inst, 'w-a', 1), true)
  assert.equal(stillHolder(inst, 'w-a', 2), false, 'epoch 不符 = 已失权')
  assert.equal(stillHolder(inst, 'w-b', 1), false, '换了机器 = 已失权')
  assert.equal(stillHolder(undefined, 'w-a', 1), false)
  await db.close()
})

test('lease: 对账视图 —— mine() 只回本机、expiredAll() 回全局过期', async () => {
  const db = await freshDb()
  await db.createUser({ id: 'u2', username: 'bob', passHash: 'x', role: 'active', homeDir: '/tmp/u2' })
  const a = shortLease(db, 'w-a')
  const b = shortLease(db, 'w-b')
  await a.acquire('u1')
  await b.acquire('u2')

  assert.deepEqual((await a.mine()).map((i) => i.userId), ['u1'], '一次拿回整机（本机只有 u1）')
  assert.deepEqual((await b.mine()).map((i) => i.userId), ['u2'])
  assert.equal((await a.expiredAll()).length, 0, '刚认领未过期')

  await sleep(90)
  assert.equal((await a.expiredAll()).length, 2, '过期后两台都进清单（供巡检，不自动接管）')
  assert.equal((await a.expiredHere()).length, 1, 'expiredHere 只回自己名下')
  await db.close()
})

test('lease: renewAll 回传失权清单（调用方据此 self-fence）', async () => {
  const db = await freshDb()
  const a = shortLease(db, 'w-a')
  await a.acquire('u1')
  assert.deepEqual(await a.renewAll(), [], '正常时无人失权')

  await sleep(90)
  const b = shortLease(db, 'w-b')
  await b.acquire('u1') // 抢走
  assert.deepEqual(await a.renewAll(), ['u1'], 'a 必须知道自己已失权')
  await db.close()
})
