/**
 * T08 · **域名形态访问**验证（在演练环境做：不动生产、不动 DNS、不动证书）。
 *
 * 要回答的问题：生产切到 cluster（Manager 在 47、实例在 106）后，
 * **按域名形态访问**（`<用户名>.<baseDomain>.com`）还能不能正常落到 106 上的实例？
 *
 * 做法：给演练 Manager 设一个**测试 baseDomain**，用**显式 `Host` 头**打进去。
 *
 * ⚠️ 关键坑（2026-09-15 实际踩到，两次假阳性都源于它）：**`fetch` 会静默丢弃 `Host` 头**
 *    （Fetch 规范把它列为禁止头，undici 直接忽略）⇒ 请求落到"无租户"的门户路由、回 200 门户页，
 *    看起来"验证通过"其实是假的。⇒ **必须用 curl（`-H Host:`）**，且判据不能只看状态码。
 *
 * 运行（在 47 上）：MANAGER=http://127.0.0.1:13080 BASE_DOMAIN=test.<baseDomain>.com \
 *                   AGENT=http://127.0.0.1:19000 AGENT_TOKEN=cross-machine-token \
 *                   node scripts/verify-cluster-domain.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const MANAGER = process.env.MANAGER ?? 'http://127.0.0.1:13080'
const BASE_DOMAIN = process.env.BASE_DOMAIN ?? 'test.<baseDomain>.com'
const AGENT = process.env.AGENT ?? 'http://127.0.0.1:19000'
const TOKEN = process.env.AGENT_TOKEN ?? 'cross-machine-token'
const ADMIN_PW = process.env.ADMIN_PW ?? 'crossmgr123'
const USER_PW = 'domainuser123'

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

/**
 * 用 **curl** 带 `Host` 头取页面（`-L` 跟随重定向 ⇒ 等价真实浏览器）。
 * 返回 `{ status, body }`，body 从临时文件读（避免编码/二进制问题）。
 */
function getByHost(sub, path, cookie) {
  const out = '/tmp/dompage.html'
  const args = [
    '-s',
    '-L',
    '--max-time',
    '25',
    '-o',
    out,
    '-w',
    '%{http_code}',
    '-H',
    `Host: ${sub}.${BASE_DOMAIN}`,
    ...(cookie ? ['-b', cookie] : []),
    `${MANAGER}${path}`,
  ]
  let status = '0'
  try {
    status = execFileSync('curl', args, { encoding: 'utf8' }).trim()
  } catch {
    status = '0'
  }
  let body = ''
  try {
    body = readFileSync(out, 'utf8')
  } catch {
    body = ''
  }
  return { status: Number(status), body }
}

/**
 * 判据：**dsh 实例页**带 `<base href="/">`（子路径与子域两种形态都带）；平台门户页不带。
 * ⚠️ 只靠"含 dsh 字样"会把门户页误判成实例页（实测踩过这个假阳性）。
 */
const isDshApp = (html) => typeof html === 'string' && html.includes('<base href=')
const describe = (html) => {
  const hit = []
  if (isDshApp(html)) hit.push('base-href')
  if (html.includes('/api/auth/login')) hit.push('platform-login')
  const t = /<title>([^<]*)<\/title>/.exec(html)
  return `${hit.join(',') || '(无特征)'} ｜ title=${t === null ? '?' : t[1].trim()} ｜ 首100字: ${html.replace(/\s+/g, ' ').slice(0, 100)}`
}

async function waitRunning(cookie, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const st = await json('/api/dsh/status', { cookie })
    if (st.body?.running === true) return true
    await sleep(1000)
  }
  return false
}

try {
  console.log('=== 域名形态验证：baseDomain=%s（Manager=%s）===', BASE_DOMAIN, MANAGER)

  const adm = await json('/api/auth/login', { method: 'POST', body: { username: 'root', password: ADMIN_PW } })
  assert(adm.status === 200, `管理员登录失败 ${adm.status}`)
  const adminCookie = adm.setCookie.split(';')[0]

  const uname = `domuser${Date.now() % 100000}`
  let r = await json('/api/auth/register', { method: 'POST', body: { username: uname, password: USER_PW } })
  assert(r.status === 201, `注册应 201（实际 ${r.status}）`)
  const users = await json('/api/admin/users', { cookie: adminCookie })
  const target = users.body.users.find((u) => u.username === uname)
  assert(target !== undefined, '能看到待审用户')
  await json(`/api/admin/users/${target.id}/approve`, { method: 'POST', cookie: adminCookie })
  const login = await json('/api/auth/login', { method: 'POST', body: { username: uname, password: USER_PW } })
  assert(login.status === 200, `用户登录失败 ${login.status}`)
  const cookie = login.setCookie.split(';')[0]
  console.log('① 用户      -> %s（uid=%s）', uname, target.id)

  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj' } })
  assert(r.status === 200, `mkdir 失败 ${r.status}`)
  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  assert(r.status === 200, `launch 失败 ${r.status} ${JSON.stringify(r.body)}`)
  assert(await waitRunning(cookie), '实例应 running')
  console.log('② 拉起      -> running=true')

  const enter = await json('/api/dsh/enter', { method: 'POST', cookie })
  assert(enter.status === 200, `enter 失败 ${enter.status}`)
  const url = enter.body.url
  console.log('③ 直达 URL  -> %s', url)
  assert(url.startsWith('https://'), `baseDomain 生效时应为 https://<子域>/（实际 ${url}）`)
  assert(url.includes(`${uname}.${BASE_DOMAIN}`), `URL 应含用户名子域（实际 ${url}）`)

  // ④ 子域形态访问：**必须带 token**（真 dsh 没 token 只给自己的登录页）
  const token = new URL(url).searchParams.get('token') ?? ''
  assert(token !== '', `enter URL 应带 token（实际 ${url}）`)
  let page = { status: 0, body: '' }
  for (let i = 0; i < 40; i += 1) {
    page = getByHost(uname, `/?token=${encodeURIComponent(token)}`, cookie)
    if (page.status === 200 && isDshApp(page.body)) break
    await sleep(1000)
  }
  assert(page.status === 200, `子域访问应 200（实际 ${page.status}）`)
  assert(isDshApp(page.body), `子域访问必须是**真的 dsh 实例页**（实际 ${describe(page.body)}）`)
  console.log('④ 子域访问  -> 200 且是**真 dsh 实例页**（Host: %s.%s → 106 上的实例）', uname, BASE_DOMAIN)

  // ⑤ 越权对照：拿 A 的 cookie 访问**另一个真实用户**（root）的子域 ⇒ 必须 401/403
  const other = getByHost('root', `/?token=${encodeURIComponent(token)}`, cookie)
  assert(!isDshApp(other.body), `越权响应绝不能是实例页（实际 ${describe(other.body)}）`)
  assert([401, 403].includes(other.status), `用 A 的 cookie 访问 root 子域应 401/403（实际 ${other.status}）`)
  console.log('⑤ 越权对照  -> 用 A 的 cookie 访问 root 子域 = %d（正确拒绝）', other.status)

  // ⑥ 独立取证：实例确实在 106
  const onAgent = await fetch(`${AGENT}/instances`, { headers: { 'x-dsh-agent-token': TOKEN } }).then((x) => x.json())
  assert(onAgent.instances.length >= 1, 'worker(106) 上应有实例')
  console.log('⑥ 取证      -> 实例确实在 106（worker /instances=%d）', onAgent.instances.length)

  await json('/api/dsh/stop', { method: 'POST', cookie })
  console.log('\nOK: **域名形态访问**在 cluster 下可用（子域 → Manager(47) → 实例(106)），且越权被拒')
} finally {
  /* 现场保留 */
}
