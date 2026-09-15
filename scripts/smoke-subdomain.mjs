// Subdomain routing + auth flow: a per-user `Host: <username>.<baseDomain>` routes
// to that user's DSH only when the caller's session cookie matches the subdomain.
import { request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { hashPassword } from '../lib/web/auth.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-subdomain-'))

const app = await buildServer(
  resolveConfig({ port: 0, dbPath: ':memory:', dataRoot, baseDomain: 'test.local', dshCommand: [process.execPath, fakeDsh] }),
)
await app.listen({ port: 0 })
const port = app.server.address().port

await app.db.createUser({
  id: 'u1',
  username: 'Carol',
  passHash: await hashPassword('carolpass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
})
await app.db.createUser({
  id: 'u2',
  username: 'bob',
  passHash: await hashPassword('bobpass123'),
  role: 'active',
  homeDir: '/tmp/u2-home',
})
mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

async function json(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') }
}

function getWithHost(path, host, cookie) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { host, ...(cookie ? { cookie } : {}) } },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  let r = await json('/api/auth/login', { method: 'POST', body: { username: 'Carol', password: 'carolpass123' } })
  const cookie = r.setCookie.split(';')[0]
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  const bobCookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('launch            ->', r.status, r.body?.url)
  assert(r.status === 200, 'launch succeeds')
  // 2026-09-15（T08 S3）：夹具 `fake-dsh.mjs` 现在**照实打印带 token 的 URL**（与真实 dsh 一致），
  // 于是这里不能再写死成不带 token 的相等 —— 原断言是"夹具不吐 token"时的意外产物。
  // 保留原意（是子域 URL、不泄露回环端口），并把 token 的存在一并纳入判据。
  assert(r.body.url.startsWith('https://carol.test.local/'), 'launch returns the subdomain URL')
  assert(!r.body.url.includes('127.0.0.1'), 'launch URL must not leak the loopback port')

  await sleep(200)

  let res = await getWithHost('/hello', 'carol.test.local', cookie)
  console.log('authed /hello     ->', res.status)
  assert(res.status === 200 && res.body.includes('fake-dsh'), 'authed subdomain routes to the DSH')

  res = await getWithHost('/hello', 'carol.test.local')
  console.log('no-cookie /hello  ->', res.status)
  assert(res.status === 401, 'unauthenticated subdomain is rejected')

  res = await getWithHost('/hello', 'carol.test.local', bobCookie)
  console.log('bob /hello        ->', res.status)
  assert(res.status === 403, 'wrong user is rejected')

  res = await getWithHost('/', `127.0.0.1:${port}`)
  assert(!res.body.includes('fake-dsh'), 'non-subdomain Host does not proxy')

  console.log('OK: subdomain routing + auth flow passed')
} finally {
  await app.close()
  await sleep(300)
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}
