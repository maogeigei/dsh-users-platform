/**
 * Fastify bootstrap: assembles the HTTP server, registers plugins and routes,
 * and owns the DB lifecycle via the close hook.
 * @module dsh-users-platform/web/server
 */

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { ServerConfig } from '../config.js'
import { createDbAdapter, type CredentialLandingRow, type DbAdapter, type PublicUser } from '../db/index.js'
import { createUserFs } from '../fs/provider.js'
import { RemoteUserFs } from '../fs/remote-user-fs.js'
import type { UserFs } from '../fs/user-fs.js'
import { decrypt, deriveKey } from '../crypto.js'
import { hashUid } from '../isolation.js'
import { LocalSpawner } from '../supervisor/orchestrator.js'
import { LeasedSpawner } from '../supervisor/leased-spawner.js'
import { RemoteSpawner, type ClusterHost } from '../supervisor/remote-spawner.js'
import { registerDshProxy } from '../supervisor/proxy.js'
import type { Spawner } from '../supervisor/spawner.js'
import {
  BUILTIN_REF,
  normalizeProtocol,
  parseModels,
  readRefValue,
  reconcileCredentials,
  reconcileSettings,
  refForEntry,
  type SettingsEntry,
} from './model-landing.js'
import { rateLimit } from './middleware/rate-limit.js'
import { authRoutes } from './routes/auth.js'
import { adminRoutes } from './routes/admin.js'
import { adminUserOpsRoutes } from './routes/admin-user-ops.js'
import { businessPluginRoutes } from './routes/business-plugins.js'
import { desktopRoutes } from './routes/desktop.js'
import { dshRoutes } from './routes/dsh.js'
import { domainRoutes } from './routes/domain.js'
import { skillRoutes } from './routes/skills.js'
import { whitelistRoutes } from './routes/whitelist.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: DbAdapter
    config: ServerConfig
    supervisor: Spawner
    userFs: UserFs
  }
  interface FastifyRequest {
    user: PublicUser | null
  }
}

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web')

/** Whether an `Origin` header belongs to the platform base domain (or a
 * per-user subdomain of it). Used to allow cross-subdomain API calls from dsh
 * instances (功能插件启停). */
function isAllowedOrigin(origin: string, baseDomain: string): boolean {
  if (baseDomain === '') return false
  try {
    const host = new URL(origin).hostname
    return host === baseDomain || host.endsWith('.' + baseDomain)
  } catch {
    return false
  }
}

/**
 * Build a fully-wired Fastify instance. Does not call `listen`; the caller owns
 * bind + shutdown.
 * @param config - resolved runtime configuration.
 */
export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const db = await createDbAdapter(config)
  const encryptionKey = deriveKey(config.encryptionSecret)
  // ── 模型条目落地──────────────────────────────────────────────────
  //   用户口径（2026-09-13 定）：条目**各自开关、可同时启用**；admin 配的**平台共享模型
  //   **也列入**、用户可开关（`users.shared_model_enabled`）；平台只负责把「**已启用**」
  //   的都配好 —— 具体用哪个模型在 dsh 对话框的模型选择器里挑。
  //
  //   为什么必须由平台写文件：官方「设置 → 模型」页在平台环境**必然报错**（该页要 Host
  //   settings 镜像，而平台是浏览器经域名访问远程服务器 ⇒ `isLoopback=false` ⇒ persistence
  //   降级 `memory` ⇒ 页面报「加载提供方目录失败」）。详见 `ensure-role-profile-patch.cjs`。
  //
  //   为什么**仍然不注入 env**（2026-09-13 读官方源码定的）：dsh 凭据解析顺序是
  //   `inherited process environment (read-only, wins) > $DSH_HOME/.credentials.yaml > …`，
  //   且 `dsh-credentials-local.write()` 里有 `assertUnshadowed()` —— 只要 env 存在同名 ref，
  //   保存就报错（"supplied read-only by the launching environment …"）⇒ 注入 env 等于
  //   **把用户锁死在"不能自配 key"**。所以共享 key 改成**预置进凭据文件**，本函数恒返回 null。
  //
  //   落地两处（字段名 2026-09-13 读官方包实测，勿凭记忆改 —— 见 model-landing.ts 头注释）：
  //     · `$DSH_HOME/.credentials.yaml` 的 `refs.<REF>`
  //     · `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<route>`
  //
  //   ⛔ 备份**绝不能落在用户 home 里**：dsh 用 chokidar watch 整个 home，一个**实例读不了**
  //   的文件（root 属主 600）会让它抛 `EACCES` ⇒ **实例崩溃循环**（2026-09-13 实测踩过，
  //   当时 .credentials.yaml.bak-platform 直接把 guest 打进 attempt=5）。
  interface Managed {
    refs: string[]
    routes: string[]
  }
  /** 托管清单落点：**平台状态目录**（不在 home、也不在文档库）。 */
  const managedDir = join(process.env.DSH_PLATFORM_STATE_DIR ?? '/var/lib/dsh-users-platform/state', 'model-landing')
  /** 只有清单里的 ref / route 才允许被平台改写或删除 —— 用户自己配的一律不碰。 */
  const readManaged = async (userId: string): Promise<Managed> => {
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    try {
      const raw = JSON.parse(await readFile(join(managedDir, userId + '.json'), 'utf8')) as Record<string, unknown>
      return { refs: strs(raw.refs), routes: strs(raw.routes) }
    } catch {
      return { refs: [], routes: [] } // 不存在 / 读坏 ⇒ 视为"平台还没管过任何东西"（保守）
    }
  }
  const writeManaged = async (userId: string, m: Managed): Promise<void> => {
    await mkdir(managedDir, { recursive: true })
    await writeFile(join(managedDir, userId + '.json'), JSON.stringify(m), { mode: 0o600 })
  }
  const readTextOrEmpty = async (file: string): Promise<string> => {
    try {
      return await readFile(file, 'utf8')
    } catch {
      return ''
    }
  }
  /**
   * 写 home 里的配置文件：备份（落**平台目录**）→ 写 → chown 给 home 属主。
   * 实例以 dsh-<uid> 身份运行，root 写的 600 文件它读不了 ⇒ 最后一步不能省。
   */
  const writeHomeFile = async (homeDir: string, file: string, text: string): Promise<void> => {
    try {
      const bakDir = process.env.DSH_PLATFORM_BACKUP_DIR ?? '/var/lib/dsh-users-platform/backups'
      await mkdir(bakDir, { recursive: true })
      const label = basename(file).replace(/^\./, '').replace(/\.ya?ml$/, '')
      // ⚠️ 带上 home 的**父目录名**（= 用户 id）：只写 basename 的话每个人都是 "home"，
      //    备份文件互相看不出是谁的（旧实现就是这个毛病：credentials-home-*.yaml）。
      const who = basename(dirname(homeDir))
      writeFileSync(join(bakDir, `${label}-${who}-${Date.now()}.yaml`), text, { mode: 0o600 })
    } catch {
      /* 备份失败不阻断 */
    }
    await writeFile(file, text, { mode: 0o600 })
    try {
      const st = await stat(homeDir)
      await chown(file, st.uid, st.gid)
    } catch {
      /* chown 失败（非 root 运行等）不阻断 */
    }
  }

  /** 平台共享条目（admin 配的、已启用的那些）—— 只在该用户开关打开、且他不是那个 admin 时纳入。 */
  const sharedLandingRows = async (userId: string): Promise<CredentialLandingRow[]> => {
    if (!(await db.getSharedModelEnabled(userId))) return []
    const admins = (await db.listPublicUsers()).filter((u) => u.role === 'admin')
    if (admins.length === 0 || admins[0].id === userId) return []
    return db.listCredentialLandingRows(admins[0].id)
  }

  /**
   * 把「已启用条目」对账进实例的两个配置文件。**幂等**，且只在真有变化时写盘。
   * 合并顺序 = **自己的在前** ⇒ 同一个 ref 上，用户自己配的 key 永远赢过平台共享的那把。
   */
  const landModels = async (userId: string): Promise<void> => {
    const owner = await db.findUserById(userId)
    if (owner === undefined) return
    const previous = await readManaged(userId)
    const rows = [...(await db.listCredentialLandingRows(userId)), ...(await sharedLandingRows(userId))]
    const seen = new Set<string>()
    const creds: Array<{ ref: string; value: string }> = []
    const providers: SettingsEntry[] = []
    for (const row of rows) {
      const ref = refForEntry({ route: row.route, baseUrl: row.baseUrl })
      if (seen.has(ref)) continue
      let value: string
      try {
        value = decrypt(row.encryptedRef, encryptionKey)
      } catch {
        // 解不开的条目跳过：宁可少配一个厂家，也不能让整次 spawn 失败。
        console.error('model landing: 解不开的条目已跳过', { userId, name: row.name })
        continue
      }
      seen.add(ref)
      creds.push({ ref, value })
      // 有 route 才写 settings.yaml。两种情形：
      //   · **目录厂家**（route 命中官方 pi-ai catalog，baseUrl 为空）⇒ 只写 `apiKeyEnv`，
      //     endpoint / 协议 / 模型目录全由官方目录提供（补做）。
      //   · **自定义厂家**（baseUrl 非空）⇒ endpoint + 协议 + 模型清单必须齐全。
      // 内置 DeepSeek 没有 route ⇒ 只写 `refs.DEEPSEEK_API_KEY`，不进 settings.yaml。
      const route = row.route ?? ''
      if (route !== '') {
        if (row.baseUrl === null || row.baseUrl === '') {
          providers.push({ route, apiKeyEnv: ref })
        } else {
          providers.push({
            route,
            apiKeyEnv: ref,
            baseURL: row.baseUrl,
            api: normalizeProtocol(row.api),
            models: parseModels(row.models),
          })
        }
      }
    }
    const credFile = join(owner.home_dir, '.credentials.yaml')
    const setFile = join(owner.home_dir, 'settings.yaml')
    const credText = await readTextOrEmpty(credFile)
    const setText = await readTextOrEmpty(setFile)
    // 一次性交接：老实现把平台共享 key 写进 `refs.DEEPSEEK_API_KEY` 时没有托管清单，
    // 新逻辑会把它当成"用户自己写的" ⇒ 关掉共享开关后那行仍留着（"关掉即生效"不成立）。
    // 首次运行（没有任何清单）且**文件里那行确实等于平台共享 key 明文**时，认领它；
    // 不相等 = 用户自己配的 ⇒ 绝不碰。
    let prevRefs = previous.refs
    if (previous.refs.length === 0 && previous.routes.length === 0) {
      if (readRefValue(credText, BUILTIN_REF) !== null) {
        const shared = await sharedDeepseekKey()
        if (shared !== null && shared === readRefValue(credText, BUILTIN_REF)) prevRefs = [BUILTIN_REF]
      }
    }
    const nextCred = reconcileCredentials(credText, creds, prevRefs)
    const nextSet = reconcileSettings(setText, providers, previous.routes)
    if (nextCred.text !== credText) await writeHomeFile(owner.home_dir, credFile, nextCred.text)
    if (nextSet.text !== setText) await writeHomeFile(owner.home_dir, setFile, nextSet.text)
    await writeManaged(userId, { refs: nextCred.managed, routes: nextSet.managed })
  }

  /** 保底：平台共享的那把内置 DeepSeek key 明文 —— 只在写配置失败退回 env 注入时才用。 */
  const sharedDeepseekKey = async (): Promise<string | null> => {
    const admins = (await db.listPublicUsers()).filter((u) => u.role === 'admin')
    if (admins.length === 0) return null
    const ref = await db.getEnabledCredentialKeyRef(admins[0].id)
    if (ref === null) return null
    try {
      return decrypt(ref, encryptionKey)
    } catch {
      return null // 密文坏了 ⇒ 当作没配，等 admin 重填
    }
  }

  /**
   * 「该给实例注入什么 env」的答案：**什么也不注入**（恒 `null`）。
   * 保留函数名与签名是因为 `Spawner` 的接口就是这么定义的（见上面那段大注释：注入 env 会把
   * 用户在模型页的保存打回错误）。写配置失败时**退回 env 注入保底** —— 宁可让用户暂时用
   * 平台共享 key，也不能因为写文件出错就让实例起不来。
   */
  const resolveApiKey = async (userId: string): Promise<string | null> => {
    try {
      await landModels(userId)
      return null
    } catch (err) {
      console.error('model landing failed, falling back to env injection', err)
      return await sharedDeepseekKey()
    }
  }
  const resolveUid = async (userId: string): Promise<number> => {
    const user = await db.findUserById(userId)
    return user?.uid ?? hashUid(userId, config.baseUid)
  }
  // cluster 模式（T08 S3/S4）：实例在 worker 上，Manager 只投递操作 + 代理。
  // fail-loud：没配 agent 地址就直接报错，别等第一个用户点进来才发现。
  if (config.deployMode === 'cluster' && config.clusterAgentUrl === '') {
    throw new Error('deployMode=cluster requires DSH_USERS_PLATFORM_CLUSTER_AGENT_URL (e.g. http://127.0.0.1:9000)')
  }
  // cluster：RemoteSpawner（传输）+ LeasedSpawner（**归属租约**）——
  // 后者保证"能不能拉起先问归属"，这是多机下防双写同一个 home 的承重件（设计 §3.2）。
  let leased: LeasedSpawner | undefined
  // ── 多 worker 的 host 目录（T08 S6）────────────────────────────────────
  // 由 `dsh_hosts` 派生并**随用随刷新**（TTL 30 s）⇒ **新增 worker 不必重启 Manager**。
  // 同时供三处使用：RemoteSpawner 的按 host 路由、LeasedSpawner 的 fence 目标、
  // 以及 `selectHost` 的容量准入 —— 都读**同一份**内存目录，避免三套各自漂移。
  const hostDirectory = new Map<string, ClusterHost>()
  hostDirectory.set(config.clusterHostId, {
    hostId: config.clusterHostId,
    agentUrl: config.clusterAgentUrl,
    token: config.clusterAgentToken,
    instanceHost: config.clusterInstanceHost,
  })
  const hostsProvider = async (): Promise<ClusterHost[]> => {
    for (const row of await db.listDshHosts()) {
      hostDirectory.set(row.id, {
        hostId: row.id,
        agentUrl: row.endpoint,
        token: row.agentToken,
        instanceHost: config.clusterInstanceHost,
      })
    }
    return [...hostDirectory.values()]
  }
  /**
   * 按用户归属解析 host（实例面与**文件面**共用这一份，避免两套路由漂移）。
   *
   * 为什么两处都要用：用户工作区在**那台 worker 的本地盘**；若文件面固定打一台 agent，
   * 就会出现「实例跑在 A、mkdir/上传写到 B」⇒ 实例看不到自己的文件、甚至 cwd 不存在而崩
   * （2026-09-15 生产切换暴露）。
   */
  const hostIdForUser = async (userId: string): Promise<string | undefined> =>
    (await db.findUserInstance(userId, 'main'))?.hostId ?? undefined

  /**
   * **文件面专用**路由：没有归属就**先选机并钉住**。
   *
   * 为什么不能直接用 hostIdForUser：新用户还没有归属，"写文件"和"launch"会各自选一次机，
   * 两次可能选到不同机器 ⇒「文件写到 A、实例起在 B」⇒ 实例看不到自己的文件（2026-09-15 实测）。
   * 首次触达工作区就把归属钉住，后续（含 launch）全走粘性 ⇒ 两面必然一致。
   */
  const hostIdForFile = async (userId: string): Promise<string | undefined> => {
    const owned = await hostIdForUser(userId)
    if (owned !== undefined && owned !== null) return owned
    const chosen = (await selectHost(userId)) ?? config.clusterHostId
    if (chosen === '') return undefined
    await db.pinInstanceHost(userId, chosen)
    return chosen
  }
  /**
   * 选机：**① 粘性优先 ② 再按容量准入**。
   *
   * ⚠️ 顺序不能颠倒（2026-09-15 生产切换时补的缺口）：用户工作区在**本地盘**、跟着机器走，
   * 把"已有历史数据的用户"调度到另一台 ⇒ 他打开实例看到**空工作区**。
   * ⇒ 有历史归属且那台还 `up` 就留在原地；只有**从未有过归属**（新用户）才按容量挑最空的。
   * `capacityMb <= 0` = 未声明（不设限）；`-1` = 显式禁用承载。
   */
  const reserveMb = Number(process.env.DSH_USERS_PLATFORM_CLUSTER_RESERVE_MB ?? '512')
  const selectHost = async (userId?: string): Promise<string | undefined> => {
    const rows = await db.listDshHosts()
    const eligible = rows.filter((h) => h.status === 'up' && h.capacityMb !== -1)
    if (userId !== undefined) {
      const owned = (await db.findUserInstance(userId, 'main'))?.hostId ?? null
      if (owned !== null && eligible.some((h) => h.id === owned)) return owned
    }
    const candidates = eligible.filter(
      (h) => h.capacityMb <= 0 || h.usedMb + reserveMb <= h.capacityMb,
    )
    if (candidates.length === 0) return undefined // 无候选 ⇒ 回退到配置里那台
    candidates.sort((a, b) => a.usedMb - b.usedMb)
    return candidates[0].id
  }
  const supervisor: Spawner =
    config.deployMode === 'cluster'
      ? (leased = new LeasedSpawner(
          new RemoteSpawner({
            agentUrl: config.clusterAgentUrl,
            token: config.clusterAgentToken,
            instanceHost: config.clusterInstanceHost,
            defaultHostId: config.clusterHostId,
            hostsProvider,
            resolveApiKey,
            resolveUid,
            // 按 host 路由：每次操作都落到"该用户实例所在那台"（与文件面同一份）
            hostIdFor: hostIdForUser,
          }),
          db,
          {
            hostId: config.clusterHostId,
            agentUrl: config.clusterAgentUrl,
            agentToken: config.clusterAgentToken,
            capacityMb: Number(process.env.DSH_USERS_PLATFORM_CLUSTER_CAPACITY_MB ?? '0'),
            // 专用 Manager 部署设 DSH_USERS_PLATFORM_CLUSTER_REGISTER_SELF=0（见 LeasedSpawner 的注释）
            registerSelf: (process.env.DSH_USERS_PLATFORM_CLUSTER_REGISTER_SELF ?? '1') !== '0',
            ttlMs: Number(process.env.DSH_USERS_PLATFORM_CLUSTER_LEASE_TTL_MS ?? '30000'),
            renewMs: Number(process.env.DSH_USERS_PLATFORM_CLUSTER_LEASE_RENEW_MS ?? '10000'),
            selectHost,
            agentFor: (hostId: string) => {
              const h = hostDirectory.get(hostId)
              return h === undefined ? undefined : { agentUrl: h.agentUrl, token: h.token }
            },
          },
        ))
      : new LocalSpawner(config, resolveApiKey, resolveUid)
  // 注册本机 + 起心跳（异步，不阻塞启动；心跳失败只影响该 worker 的状态位）
  if (leased !== undefined) {
    void leased.start().catch((err: unknown) => {
      console.error('[cluster] heartbeat/register failed to start:', err)
    })
  }
  const userFs = createUserFs(config, {
    hostIdFor: hostIdForFile,
    agentFor: (hostId: string) => {
      const h = hostDirectory.get(hostId)
      return h === undefined ? undefined : { agentUrl: h.agentUrl, token: h.token }
    },
  })
  // T08 S5：cluster 模式下**所有 worker 的 dataRoot 必须是同一绝对路径**（基线约定，
  // 设计 §14.3）。不一致会让 `resolvePath` 算出的"实例眼里的路径"与实际不符 ⇒
  // 文件面与 launch 的 folder 都会错。这里在启动时**报出来**，别等用户点进去才发现。
  if (userFs instanceof RemoteUserFs) {
    void userFs
      .probeWorkerRoot()
      .then((root) => {
        if (root !== undefined && root !== userFs.workerDataRoot) {
          console.error(
            `[cluster] worker dataRoot 与配置不一致：agent 报 ${root}，本进程按 ${userFs.workerDataRoot} 计算路径。` +
              '请把 DSH_USERS_PLATFORM_CLUSTER_WORKER_DATA_ROOT 设为 worker 上的实际值（所有 worker 必须同路径）。',
          )
        }
      })
      .catch(() => {
        /* 探测失败不阻塞启动：会有心跳/调用失败暴露 */
      })
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: config.maxUploadBytes,
  })

  app.decorate('db', db)
  app.decorate('config', config)
  app.decorate('supervisor', supervisor)
  app.decorate('userFs', userFs)
  app.decorateRequest('user', null)

  // Reverse proxy (subdomain + legacy subpath). Registered first so its global
  // onRequest hook intercepts per-user subdomain traffic before other hooks.
  await registerDshProxy(app)

  // CORS for cross-subdomain API calls from dsh instances (功能插件启停 section
  // runs in the browser on `<user>.<baseDomain>` and calls portal APIs on
  // `<baseDomain>`). Cookie is HttpOnly + SameSite=None (secure mode) with
  // Domain=.<baseDomain>, so credentials ride along; we only need to allow
  // the Origin. Restricted to the platform base domain and its subdomains.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (origin === undefined || origin === '') return
    if (!isAllowedOrigin(origin, config.baseDomain)) return
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Access-Control-Allow-Credentials', 'true')
    reply.header('Vary', 'Origin')
    if (request.raw.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'Content-Type')
      reply.header('Access-Control-Max-Age', '600')
      return reply.code(204).send()
    }
  })

  app.addHook('onClose', async () => {
    await supervisor.teardown()
    await db.close()
  })

  // Rate limiting first so auth/admin surfaces are covered by default.
  await app.register(rateLimit)

  // Domain-specific route groups (API).
  await app.register(authRoutes)
  await app.register(adminRoutes)
  // admin 视角的「用户服务 / 工作区文件」—— admin 在「服务管理」里管**任意用户**
  await app.register(adminUserOpsRoutes)
  await app.register(businessPluginRoutes)
  await app.register(desktopRoutes)
  await app.register(dshRoutes)
  await app.register(domainRoutes)
  await app.register(skillRoutes)
  await app.register(whitelistRoutes)

  // Static placeholder SPA last, so exact API routes take precedence over the
  // wildcard static handler.
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
  })

  return app
}
