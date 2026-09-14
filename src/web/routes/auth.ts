/**
 * Auth routes: self-registration (→ pending), login, logout, and the current
 * identity. Registration always yields a `pending` user; an admin approves it.
 * @module dsh-users-platform/web/routes/auth
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireAuth } from '../middleware/authn.js'
import { homeRoot, userRoot } from '../../fs/workspace.js'
import { deriveKey, encrypt } from '../../crypto.js'
import { toPublicUser } from '../../db/types.js'
import { catalogDiagnostics, isCatalogProvider, isCnProvider, listCatalogProviders } from '../model-catalog.js'
import { PROTOCOLS } from '../model-landing.js'
import {
  clearSessionCookie,
  hashPassword,
  hashSessionToken,
  newSessionToken,
  parseCookie,
  sessionCookie,
  verifyPassword,
} from '../auth.js'

const registerSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_-]+$' },
      password: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
} as const

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', maxLength: 64 },
      password: { type: 'string', maxLength: 128 },
    },
  },
} as const

interface Credentials {
  username: string
  password: string
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/auth/register',
    { schema: registerSchema, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { username, password } = request.body as Credentials
      if ((await app.db.findUserByUsername(username)) !== undefined) {
        return reply.code(409).send({ error: 'username_taken' })
      }
      const id = randomUUID()
      const homeDir = homeRoot(userRoot(app.config.dataRoot, id))
      const passHash = await hashPassword(password)
      // Create the user first so `initUserRoot` resolves the DB-assigned uid
      // (baseUid + row_id) instead of the hash fallback — the user's DSH process must
      // run as that *same* uid or the DSH cannot write its dirs.
      const user = await app.db.createUser({ id, username, passHash, role: 'pending', homeDir })
      await app.userFs.initUserRoot(id, user.uid ?? undefined)
      await app.db.audit(id, 'register', JSON.stringify({ username }))
      return reply.code(201).send({ user: { id, username, role: 'pending' } })
    },
  )

  app.post(
    '/api/auth/login',
    { schema: loginSchema, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { username, password } = request.body as Credentials
      const user = await app.db.findUserByUsername(username)
      if (user === undefined || !(await verifyPassword(password, user.pass_hash))) {
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      if (user.role === 'pending') return reply.code(403).send({ error: 'pending_review' })
      if (user.role === 'disabled') return reply.code(403).send({ error: 'disabled' })

      const token = newSessionToken()
      // 单活跃会话（last-wins）：新登录顶掉该账号此前所有会话——旧浏览器的
      // sid 立即失效，proxy/API 对其返回 401，需重新登录后才能继续访问。
      await app.db.deleteUserSessions(user.id)
      await app.db.createSession({
        tokenHash: hashSessionToken(token),
        userId: user.id,
        expiresAt: Date.now() + app.config.sessionTtlSeconds * 1000,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      })
      await app.db.audit(user.id, 'login', null)
      reply.header(
        'set-cookie',
        sessionCookie(token, app.config.sessionTtlSeconds, app.config.secureCookies, app.config.cookieDomain),
      )
      return { user: toPublicUser(user) }
    },
  )

  app.post('/api/auth/logout', async (request, reply) => {
    const token = parseCookie(request.headers.cookie, 'sid')
    if (token !== undefined) await app.db.deleteSession(hashSessionToken(token))
    reply.header('set-cookie', clearSessionCookie(app.config.secureCookies, app.config.cookieDomain))
    return { ok: true }
  })

  // ---- 同源退出页：会话内「退出登录」整页跳转（清 sid + 删 session → 回登录页） ----
  app.get('/logout', async (request, reply) => {
    const token = parseCookie(request.headers.cookie, 'sid')
    if (token !== undefined) await app.db.deleteSession(hashSessionToken(token))
    reply.header('set-cookie', clearSessionCookie(app.config.secureCookies, app.config.cookieDomain))
    return reply.redirect('/')
  })

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({ user: request.user }))

  const keyAddSchema = {
    body: {
      type: 'object',
      required: ['name', 'apiKey'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 32 },
        apiKey: { type: 'string', minLength: 1, maxLength: 256 },
        // 补做：**目录厂家 id**（选了它只需 apiKey；endpoint/协议/模型由官方目录兜底）。
        provider: { type: 'string', minLength: 1, maxLength: 40 },
        // 自定义厂家三件套 —— **都不给**就是老语义的「内置 DeepSeek 那一把 key」。
        route: { type: 'string', minLength: 1, maxLength: 40 },
        baseUrl: { type: 'string', maxLength: 300 },
        api: { type: 'string', minLength: 1, maxLength: 40 },
        models: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 128 } },
      },
    },
  } as const

  const toggleSchema = {
    body: {
      type: 'object',
      required: ['enabled'],
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' } },
    },
  } as const

  // ---- 模型厂家与密钥（2026-09-13 第三轮口径）--------------------------
  //   用户口径（**已定，不得再拿去当选择题**）：
  //     ① 条目**各自开关、可同时启用**（不再互斥）；
  //     ② admin 配的**平台共享模型也列入**列表，用户可开关（`users.shared_model_enabled`）；
  //     ③ 具体用哪个模型**在 dsh 对话框的模型选择器里选** —— 平台只负责把「已启用」的都配好。
  //   ⇒ 因此**不再有**"当前生效的那一把"这种概念：`keySourceOf` 只回答"有没有自己的内置
  //      DeepSeek key"，供界面文案用；真正生效的是 spawn 时的落地结果（`server.ts`）。
  //   ⚠️ 落地发生在 **spawn** 时 ⇒ 改完必须**重启实例**才生效，这也是这几条路由最后都要
  //      `refreshAfterKeyChange` 的原因。

  /** 展示名 → route 的默认值：英文/数字折成小写短横线；纯中文名折不出东西 ⇒ `provider`。 */
  function slugify(name: string): string {
    const s = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
    return s === '' || !/^[a-z0-9]/.test(s) ? 'provider' : s
  }

  /** 该用户当前**实际生效**的密钥来源。 */
  async function keySourceOf(userId: string): Promise<'own' | 'shared' | 'none'> {
    if ((await app.db.getEnabledCredentialKeyRef(userId)) !== null) return 'own'
    // 关掉了共享开关的人**就是** none —— 这正是验收③要的语义。
    if (!(await app.db.getSharedModelEnabled(userId))) return 'none'
    const admins = (await app.db.listPublicUsers()).filter((u) => u.role === 'admin')
    if (admins.length === 0) return 'none'
    return (await app.db.getEnabledCredentialKeyRef(admins[0].id)) !== null ? 'shared' : 'none'
  }

  /** 平台共享模型的**非敏感**信息（名字 / 归属 / 条数；绝不返回密钥本身）。 */
  async function sharedKeyInfo(userId: string): Promise<{
    available: boolean
    name: string | null
    owner: string | null
    ownerIsMe: boolean
    enabled: boolean
    count: number
  }> {
    const admins = (await app.db.listPublicUsers()).filter((u) => u.role === 'admin')
    const enabled = await app.db.getSharedModelEnabled(userId)
    if (admins.length === 0) return { available: false, name: null, owner: null, ownerIsMe: false, enabled, count: 0 }
    // 共享**不再假设只有一把** —— admin 也能配多条（与用户侧同一套口径）。
    const keys = await app.db.listEnabledCredentialKeys(admins[0].id)
    // `ownerIsMe`：admin 看的是**自己**配的那些 ⇒ 前端文案要区分「我配的」与「别人配的」。
    return {
      available: keys.length > 0,
      name: keys[0]?.name ?? null,
      owner: admins[0].username,
      ownerIsMe: admins[0].id === userId,
      enabled,
      count: keys.length,
    }
  }
  /** 改动后的刷新：admin 动的是共享内容 ⇒ 广播重启；其他人只重启自己。 */
  async function refreshAfterKeyChange(userId: string, role: string): Promise<void> {
    if (role === 'admin') await app.supervisor.restartAllMains()
    else await app.supervisor.restartMain(userId)
  }

  app.get('/api/me/keys', { preHandler: requireAuth }, async (request) => ({
    keys: await app.db.listCredentialKeys(request.user!.id),
    effective: await keySourceOf(request.user!.id),
    shared: await sharedKeyInfo(request.user!.id),
    // 档 87：把「共享开关」与「协议枚举」一并给出，免得前端各写一份常量然后漂掉。
    sharedModelEnabled: await app.db.getSharedModelEnabled(request.user!.id),
    protocols: [...PROTOCOLS],
  }))

  /**
   * 官方 **pi-ai 厂家目录**（补做）——「新增模型条目」的选择框数据源。
   *
   * 为什么由后端给：目录是**安装期冻结**在官方包里的（`@earendil-works/pi-ai/dist/providers/data/`），
   * 前端拿不到也不该硬编码；后端读一次缓存 10 分钟。选中的厂家**只要填 API Key** ——
   * endpoint / 协议 / 模型目录全由目录提供（见 `model-catalog.ts` 头注释）。
   * ⚠️ 目录里的 `deepseek` 被**排除**：平台已有「内置 DeepSeek」入口（走 `dsh-llm-deepseek` +
   * 平台共享 key），再列一个同名选项只会让用户分不清哪个生效。
   */
  app.get('/api/me/model-providers', { preHandler: requireAuth }, async () => {
    const all = await listCatalogProviders()
    return {
      providers: all
        .filter((p) => p.id !== 'deepseek')
        .map((p) => ({
          id: p.id,
          label: p.label,
          api: p.api,
          baseURL: p.baseURL,
          cn: isCnProvider(p.id),
          modelCount: p.models.length,
          // 只回前 60 个模型名给界面展示（足量的"看到它自带什么"），不整份下发。
          models: p.models.slice(0, 60).map((m) => m.name ?? m.id),
        })),
      // 目录**可读性**：读不到时前端要如实说明"为什么只剩两项"，而不是静默给个空列表
      // （2026-09-14：这个静默曾让一个 P1 布局缺陷长期不可见）。
      catalog: catalogDiagnostics(),
    }
  })

  app.post('/api/me/keys', { preHandler: requireAuth, schema: keyAddSchema }, async (request, reply) => {
    const body = request.body as {
      name: string
      apiKey: string
      provider?: string
      route?: string
      baseUrl?: string
      api?: string
      models?: string[]
    }
    const cleanName = body.name.trim()
    // 展示名**允许中文**（寻址用的是 route），但仍拒掉控制字符，免得污染日志与界面。
    // eslint-disable-next-line no-control-regex
    if (cleanName === '' || /[\u0000-\u001f\u007f]/.test(cleanName)) {
      return reply.code(400).send({ error: 'invalid_name' })
    }
    // Header-safe charset only: reject spaces, quotes, non-ASCII, etc.
    if (!/^[A-Za-z0-9\-_.]{1,256}$/.test(body.apiKey)) {
      return reply.code(400).send({ error: 'invalid_api_key' })
    }
    const existingKeys = await app.db.listCredentialKeys(request.user!.id)
    /** route 是 settings.yaml 里的 dict 键 ⇒ 同一用户下撞键 = 后写的覆盖前者、静默失效。 */
    const routeTaken = (r: string): boolean => existingKeys.some((k) => k.route === r && k.name !== cleanName)

    // ── 情形 A：**目录厂家**（用户只填了 API Key）────────────────────────────────
    const providerId = (body.provider ?? '').trim()
    if (providerId !== '') {
      if (!(await isCatalogProvider(providerId))) return reply.code(400).send({ error: 'unknown_provider' })
      if (routeTaken(providerId)) return reply.code(409).send({ error: 'route_taken' })
      const key = await app.db.setCredentialKey(
        request.user!.id,
        cleanName,
        encrypt(body.apiKey, deriveKey(app.config.encryptionSecret)),
        // 只记 route：endpoint / 协议 / 模型清单**都不写**，交给官方目录兜底。
        { route: providerId, baseUrl: null, api: null, models: null },
      )
      await app.db.audit(request.user!.id, 'set_api_key', JSON.stringify({ name: cleanName, provider: providerId }))
      await refreshAfterKeyChange(request.user!.id, request.user!.role)
      return { key }
    }

    // ── 情形 B：内置 DeepSeek（不带 baseUrl）／自定义网关（带 baseUrl）────────────
    const baseUrl = (body.baseUrl ?? '').trim()
    const isCustom = baseUrl !== ''
    let route: string | null = null
    let api: string | null = null
    let models: string | null = null
    if (isCustom) {
      if (!/^https?:\/\/\S{1,280}$/.test(baseUrl)) return reply.code(400).send({ error: 'invalid_base_url' })
      route = (body.route ?? '').trim().toLowerCase() || slugify(cleanName)
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(route)) return reply.code(400).send({ error: 'invalid_route' })
      if (body.api !== undefined && !(PROTOCOLS as readonly string[]).includes(body.api)) {
        return reply.code(400).send({ error: 'invalid_api' })
      }
      api = body.api ?? null
      const ids = (body.models ?? []).map((m) => m.trim()).filter((m) => m !== '')
      if (ids.length === 0) return reply.code(400).send({ error: 'models_required' })
      models = JSON.stringify(ids.slice(0, 50))
      if (routeTaken(route)) return reply.code(409).send({ error: 'route_taken' })
    }
    const key = await app.db.setCredentialKey(
      request.user!.id,
      cleanName,
      encrypt(body.apiKey, deriveKey(app.config.encryptionSecret)),
      { route, baseUrl: isCustom ? baseUrl : null, api, models },
    )
    await app.db.audit(request.user!.id, 'set_api_key', JSON.stringify({ name: cleanName, route, custom: isCustom }))
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { key }
  })

  /** 开/关**单个**条目（口径①：不互斥、可同时启用）。 */
  app.post('/api/me/keys/:id/toggle', { preHandler: requireAuth, schema: toggleSchema }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { enabled } = request.body as { enabled: boolean }
    if (!(await app.db.toggleCredentialKey(request.user!.id, id, enabled))) {
      return reply.code(404).send({ error: 'not_found' })
    }
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { ok: true }
  })

  /** 平台共享模型的开关（口径②）—— 只动**自己**的偏好，不碰 admin 的配置。 */
  app.post('/api/me/models/shared', { preHandler: requireAuth, schema: toggleSchema }, async (request, reply) => {
    const { enabled } = request.body as { enabled: boolean }
    if (!(await app.db.setSharedModelEnabled(request.user!.id, enabled))) {
      return reply.code(404).send({ error: 'not_found' })
    }
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { ok: true }
  })

  /**
   * @deprecated 起语义已变成"启用这一个、**不关**别的"（与 `toggle(true)` 同义）。
   * 保留路由只为老客户端不 404；新前端不该再用它。
   */
  app.post('/api/me/keys/:id/select', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!(await app.db.selectCredentialKey(request.user!.id, id))) return reply.code(404).send({ error: 'not_found' })
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { ok: true }
  })

  app.delete('/api/me/keys/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!(await app.db.deleteCredentialKey(request.user!.id, id))) return reply.code(404).send({ error: 'not_found' })
    // 删掉的是自己配的 ⇒ 落地时自然回落到「平台共享模型」（前提是共享开关开着）。
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { ok: true }
  })
}
