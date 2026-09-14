// DB adapter regression tests (node:test). Runs against the built `lib/`
// output — `npm test` builds first. Covers the constraint-mapping and
// transaction semantics shared by both backends:
//   - unique / foreign-key errors converge on UniqueViolationError /
//     ForeignKeyViolationError
//   - the "disable-all-then-enable-one" credential upsert keeps exactly one
//     enabled key under concurrent writes
//   - concurrent createUser / audit writes land cleanly
// The Postgres suite self-skips unless DSH_USERS_PLATFORM_TEST_DB_URL is set
// (mirrors the CI e2e self-skip convention).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqliteAdapter } from '../lib/db/sqlite.js'
import { openPgAdapter } from '../lib/db/pg.js'
import { ForeignKeyViolationError, UniqueViolationError } from '../lib/db/errors.js'

const user = (id, username) => ({ id, username, passHash: 'x', role: 'active', homeDir: `/home/${username}` })

function register(backend, makeAdapter) {
  test(`${backend}: duplicate username → UniqueViolationError`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      await assert.rejects(() => db.createUser(user('b', 'alice')), UniqueViolationError)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: session for unknown user → ForeignKeyViolationError`, async () => {
    const db = await makeAdapter()
    try {
      await assert.rejects(
        () => db.createSession({ tokenHash: 't', userId: 'missing', expiresAt: Date.now() + 1000 }),
        ForeignKeyViolationError,
      )
    } finally {
      await db.close()
    }
  })

  // 条目口径从「互斥单选」改为「**各自开关、可同时启用**」⇒ 老断言整体改写。
  test(`${backend}: concurrent setCredentialKey keeps every entry enabled (不再互斥)`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => db.setCredentialKey('a', `k${i}`, `ref${i}`)),
      )
      const keys = await db.listCredentialKeys('a')
      assert.equal(keys.length, 5, 'five rows')
      // 写新条目**不再**把其它条目全关（老实现是 `SET enabled = 0 WHERE user_id = ?`）。
      assert.equal(keys.filter((k) => k.enabled).length, 5, 'every entry stays enabled')
      assert.equal((await db.listEnabledCredentialKeys('a')).length, 5, 'listEnabled agrees with list')
      const ref = await db.getEnabledCredentialKeyRef('a')
      assert.ok(ref !== null && ref.startsWith('ref'), 'enabled key has a ref')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: toggleCredentialKey 只动一行（不影响其它条目）`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      const k1 = await db.setCredentialKey('a', 'k1', 'r1')
      await db.setCredentialKey('a', 'k2', 'r2')
      assert.equal(await db.toggleCredentialKey('a', k1.id, false), true)
      const keys = await db.listCredentialKeys('a')
      assert.equal(keys.find((k) => k.id === k1.id).enabled, false, 'target row off')
      assert.equal(keys.find((k) => k.name === 'k2').enabled, true, 'the other row untouched')
      assert.equal((await db.listEnabledCredentialKeys('a')).length, 1, 'only one enabled now')
      // 不存在的 id ⇒ false（路由据此回 404）
      assert.equal(await db.toggleCredentialKey('a', 'nope', true), false)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: getEnabledCredentialKeyRef 只认内置条目（语义重定义）`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      // 自定义厂家（给了 baseUrl）**不是**"用户自己的 DeepSeek key"，否则 keySourceOf /
      // resolveApiKey 会把一个网关的 key 当成平台内置 key 用。
      await db.setCredentialKey('a', 'gw', 'gwref', {
        route: 'my-gw',
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        models: '["gpt-4o"]',
      })
      assert.equal(await db.getEnabledCredentialKeyRef('a'), null, 'custom provider is not the builtin ref')
      await db.setCredentialKey('a', 'ds', 'dsref')
      assert.equal(await db.getEnabledCredentialKeyRef('a'), 'dsref', 'builtin entry wins')
      // 元数据必须原样存回来（route / baseUrl / api / models）
      const gw = (await db.listCredentialKeys('a')).find((k) => k.name === 'gw')
      assert.equal(gw.route, 'my-gw')
      assert.equal(gw.baseUrl, 'https://api.example.com/v1')
      assert.equal(gw.api, 'openai-completions')
      assert.equal(gw.models, '["gpt-4o"]')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: sharedModelEnabled 默认开、可关（口径②）`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      assert.equal(await db.getSharedModelEnabled('a'), true, 'V6 默认 true')
      assert.equal(await db.setSharedModelEnabled('a', false), true)
      assert.equal(await db.getSharedModelEnabled('a'), false)
      assert.equal(await db.setSharedModelEnabled('a', true), true)
      assert.equal(await db.getSharedModelEnabled('a'), true)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: selectCredentialKey 不再关掉别的条目`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      const k1 = await db.setCredentialKey('a', 'k1', 'r1')
      const k2 = await db.setCredentialKey('a', 'k2', 'r2')
      // 两条内置条目都启用 ⇒ 取"最新一条"（两条写在同一毫秒时由 id 决定，故这里只断非空）
      assert.ok((await db.getEnabledCredentialKeyRef('a')) !== null)
      assert.equal(await db.selectCredentialKey('a', k1.id), true)
      // 老语义会先把所有条目关掉再开这一个；新语义只保证"这一个开"。
      const keys = await db.listCredentialKeys('a')
      assert.equal(keys.find((k) => k.id === k2.id).enabled, true, 'another entry is not switched off')
      assert.equal(keys.find((k) => k.id === k1.id).enabled, true, 'target stays enabled')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: concurrent createUser`, async () => {
    const db = await makeAdapter()
    try {
      await Promise.all(Array.from({ length: 20 }, (_, i) => db.createUser(user(`u${i}`, `user${i}`))))
      assert.equal((await db.listPublicUsers()).length, 20)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: getOrCreateWorkspace is idempotent`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      const w1 = await db.getOrCreateWorkspace('a', 'proj/one')
      const w2 = await db.getOrCreateWorkspace('a', 'proj/one')
      assert.equal(w1.id, w2.id)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: createUser assigns a unique uid`, async () => {
    const db = await makeAdapter()
    try {
      const a = await db.createUser(user('a', 'alice'))
      const b = await db.createUser(user('b', 'bob'))
      assert.ok(a.uid !== null && a.uid !== undefined, 'first user has a uid')
      assert.notEqual(a.uid, b.uid, 'uids are unique across users')
      assert.equal((await db.listUsersWithoutUid()).length, 0, 'no unassigned uids remain')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: concurrent audit writes`, async () => {
    const db = await makeAdapter()
    try {
      await Promise.all(Array.from({ length: 10 }, (_, i) => db.audit('system', 'test', `detail-${i}`)))
    } finally {
      await db.close()
    }
  })

  test(`${backend}: upsertInstance round-trips folder + patch and is idempotent`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      await db.upsertInstance({ id: 'dsh-a', userId: 'a', role: 'main', status: 'starting', folder: '/ws/proj', patch: '- insert:\n' })
      const first = await db.findInstance('dsh-a')
      assert.equal(first.folder, '/ws/proj')
      assert.equal(first.patch, '- insert:\n')
      assert.equal(first.status, 'starting')
      assert.ok(first.startedAt > 0, 'started_at stamped')

      // Same deterministic id → overwrite, not a duplicate row.
      await db.upsertInstance({ id: 'dsh-a', userId: 'a', role: 'main', status: 'running', folder: '/ws/other' })
      const second = await db.findInstance('dsh-a')
      assert.equal(second.folder, '/ws/other')
      assert.equal(second.patch, null, 'omitted patch clears the column')
      assert.equal((await db.listInstancesByRole('main')).filter((i) => i.userId === 'a').length, 1)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: setInstanceStatus records the exit outcome`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      await db.upsertInstance({ id: 'dsh-a', userId: 'a', role: 'main', status: 'running', folder: '/ws' })
      assert.equal(await db.setInstanceStatus('dsh-a', 'crashed', { exitCode: 137, lastError: 'OOMKilled' }), true)
      const row = await db.findInstance('dsh-a')
      assert.equal(row.status, 'crashed')
      assert.equal(row.exitCode, 137)
      assert.equal(row.lastError, 'OOMKilled')
      assert.ok(row.lastExit > 0, 'last_exit stamped')
      assert.equal(await db.setInstanceStatus('dsh-missing', 'stopped'), false, 'unknown id reports no change')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: instances are scoped by user and role, and cascade on user delete`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      await db.createUser(user('b', 'bob'))
      await db.upsertInstance({ id: 'dsh-a', userId: 'a', role: 'main', status: 'running', folder: '/ws' })
      await db.upsertInstance({ id: 'dsh-a-watchdog', userId: 'a', role: 'watchdog', status: 'starting' })
      await db.upsertInstance({ id: 'dsh-b', userId: 'b', role: 'main', status: 'running', folder: '/ws' })

      assert.equal((await db.findUserInstance('a', 'main')).id, 'dsh-a')
      assert.equal((await db.findUserInstance('a', 'watchdog')).id, 'dsh-a-watchdog')
      assert.equal((await db.listInstancesByRole('main')).length, 2)
      assert.equal((await db.listInstancesByRole('watchdog')).length, 1)

      await db.deleteUserInstances('a')
      assert.equal(await db.findUserInstance('a', 'main'), undefined)
      assert.equal((await db.listInstancesByRole('main')).length, 1, "b's instance survives")
    } finally {
      await db.close()
    }
  })

  test(`${backend}: hasActiveSession reflects unexpired vs expired sessions`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      assert.equal(await db.hasActiveSession('a'), false, 'no session → inactive')
      await db.createSession({ tokenHash: 't1', userId: 'a', expiresAt: Date.now() + 60_000 })
      assert.equal(await db.hasActiveSession('a'), true, 'unexpired session → active')
      await db.createSession({ tokenHash: 't2', userId: 'a', expiresAt: Date.now() - 1000 })
      assert.equal(await db.hasActiveSession('a'), true, 'at least one unexpired session → active')
      await db.deleteSession('t1')
      assert.equal(await db.hasActiveSession('a'), false, 'only expired session left → inactive')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: instance for unknown user → ForeignKeyViolationError`, async () => {
    const db = await makeAdapter()
    try {
      await assert.rejects(
        () => db.upsertInstance({ id: 'dsh-ghost', userId: 'missing', role: 'main', status: 'starting' }),
        ForeignKeyViolationError,
      )
    } finally {
      await db.close()
    }
  })
}

register('sqlite', () => new SqliteAdapter(':memory:', 100000))

const pgUrl = process.env.DSH_USERS_PLATFORM_TEST_DB_URL
if (pgUrl) {
  register('pg', () => openPgAdapter(pgUrl, 100000))
} else {
  test('pg: skipped — set DSH_USERS_PLATFORM_TEST_DB_URL to run', { skip: 'no DSH_USERS_PLATFORM_TEST_DB_URL' }, () => {})
}
