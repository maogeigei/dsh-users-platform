/**
 * Synchronous SQLite data access. This is the raw layer behind
 * {@link SqliteAdapter}; the route layer must never import these functions
 * directly — it goes through {@link DbAdapter} so Postgres can be substituted.
 *
 * All access is parameterized (prepared statements). Functions take the
 * connection explicitly so they stay free of Fastify/app state and testable.
 * @module dsh-users-platform/db/repo
 */

import { randomUUID } from 'node:crypto'
import type { Database } from './connection.js'
import { prepare } from './prepared.js'
import {
  toBusinessPlugin,
  toDomain,
  toDshInstance,
  toPublicUser,
  toSession,
  toUser,
  toWorkspace,
  type BusinessPlugin,
  type CredentialKey,
  type CredentialKeyMeta,
  type CredentialLandingRow,
  type CreateSessionInput,
  type CreateUserInput,
  type Domain,
  type DshInstance,
  type DshInstanceRole,
  type DshInstanceStatus,
  type PublicUser,
  type SessionRow,
  type SessionUser,
  type UpsertBusinessPluginInput,
  type UpsertDshInstanceInput,
  type User,
  type UserRole,
  type Workspace,
} from './types.js'

const USER_COLS = 'id, username, pass_hash, role, home_dir, api_key_ref, created_at, approved_by, uid'
const DOMAIN_COLS = 'id, user_id, domain, verified, nginx_config, updated_at'
const BUSINESS_PLUGIN_COLS = 'id, name, description, version, tgz_path, file_size, uploaded_by, created_at, updated_at'
const INSTANCE_COLS =
  'id, user_id, workspace_id, role, pid, port, status, started_at, last_exit, exit_code, last_error, folder, patch'

export function createUser(db: Database, input: CreateUserInput, baseUid: number): User {
  const createdAt = Date.now()
  return db.transaction((): User => {
    const info = prepare(db,
      'INSERT INTO users (id, username, pass_hash, role, home_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(input.id, input.username, input.passHash, input.role, input.homeDir, createdAt)
    // SQLite's implicit rowid is the per-user incrementing integer; uid = baseUid + it.
    const uid = baseUid + Number(info.lastInsertRowid)
    prepare(db, 'UPDATE users SET uid = ? WHERE id = ?').run(uid, input.id)
    return {
      id: input.id,
      username: input.username,
      pass_hash: input.passHash,
      role: input.role,
      home_dir: input.homeDir,
      api_key_ref: null,
      created_at: createdAt,
      approved_by: null,
      uid,
    }
  })()
}

export function findUserByUsername(db: Database, username: string): User | undefined {
  const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE username = ?`).get(username)
  return row ? toUser(row as Record<string, unknown>) : undefined
}

/** Case-insensitive username lookup (for subdomain routing). */
export function findUserBySlug(db: Database, slug: string): User | undefined {
  const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE LOWER(username) = ?`).get(slug.toLowerCase())
  return row ? toUser(row as Record<string, unknown>) : undefined
}

export function findUserById(db: Database, id: string): User | undefined {
  const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id)
  return row ? toUser(row as Record<string, unknown>) : undefined
}

export function listPublicUsers(db: Database): PublicUser[] {
  const rows = prepare(db, `SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toPublicUser(toUser(row)))
}

export function countAdmins(db: Database): number {
  const row = prepare(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }
  return row.n
}

export function setUserRole(db: Database, id: string, role: UserRole, approvedBy?: string): boolean {
  const info =
    approvedBy === undefined
      ? prepare(db, 'UPDATE users SET role = ? WHERE id = ?').run(role, id)
      : prepare(db, 'UPDATE users SET role = ?, approved_by = ? WHERE id = ?').run(role, approvedBy, id)
  return info.changes > 0
}

export function createSession(db: Database, input: CreateSessionInput): void {
  prepare(db,
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null)
}

export function findSession(db: Database, tokenHash: string): SessionRow | undefined {
  const row = prepare(db, 'SELECT token_hash, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE token_hash = ?')
    .get(tokenHash)
  return row ? toSession(row as Record<string, unknown>) : undefined
}

export function deleteSession(db: Database, tokenHash: string): void {
  prepare(db, 'DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

export function deleteUserSessions(db: Database, userId: string): void {
  prepare(db, 'DELETE FROM sessions WHERE user_id = ?').run(userId)
}

/** Append an audit entry. `actor` is a user id or `'system'`. */
export function audit(db: Database, actor: string | null, action: string, detail?: string | null): void {
  prepare(db, 'INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    Date.now(),
    actor,
    action,
    detail ?? null,
  )
}

export function findWorkspaceByPath(db: Database, userId: string, relPath: string): Workspace | undefined {
  const row = prepare(db, 'SELECT id, user_id, name, rel_path, created_at FROM workspaces WHERE user_id = ? AND rel_path = ?')
    .get(userId, relPath)
  return row ? toWorkspace(row as Record<string, unknown>) : undefined
}

/** Upsert a workspace row by (user, relPath); create with a derived name. */
export function getOrCreateWorkspace(db: Database, userId: string, relPath: string): Workspace {
  const existing = findWorkspaceByPath(db, userId, relPath)
  if (existing !== undefined) return existing
  const id = randomUUID()
  const segments = relPath.split('/').filter(Boolean)
  const name = segments.at(-1) ?? 'root'
  prepare(db, 'INSERT INTO workspaces (id, user_id, name, rel_path, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    userId,
    name,
    relPath,
    Date.now(),
  )
  return { id, userId, name, relPath, createdAt: Date.now() }
}

/** Replace a workspace's plugin selection (insert/delete in one transaction). */
export function setFolderPlugins(
  db: Database,
  workspaceId: string,
  selections: ReadonlyArray<{ id: string; enabled: boolean }>,
): void {
  const tx = db.transaction(() => {
    prepare(db, 'DELETE FROM folder_plugins WHERE workspace_id = ?').run(workspaceId)
    const insert = prepare(db,
      'INSERT INTO folder_plugins (workspace_id, plugin_id, enabled, updated_at) VALUES (?, ?, ?, ?)',
    )
    for (const selection of selections) {
      insert.run(workspaceId, selection.id, selection.enabled ? 1 : 0, Date.now())
    }
  })
  tx()
}

/** Enabled plugin ids for a workspace. */
export function getEnabledPluginIds(db: Database, workspaceId: string): string[] {
  const rows = prepare(db, 'SELECT plugin_id FROM folder_plugins WHERE workspace_id = ? AND enabled = 1')
    .all(workspaceId) as Array<{ plugin_id: string }>
  return rows.map((row) => row.plugin_id)
}

export function findDomainByUser(db: Database, userId: string): Domain | undefined {
  const row = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains WHERE user_id = ?`).get(userId)
  return row ? toDomain(row as Record<string, unknown>) : undefined
}

export function findDomainById(db: Database, id: string): Domain | undefined {
  const row = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains WHERE id = ?`).get(id)
  return row ? toDomain(row as Record<string, unknown>) : undefined
}

export function listDomains(db: Database): Domain[] {
  const rows = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains ORDER BY updated_at DESC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toDomain(row))
}

/** Upsert a user's custom domain (resetting `verified` to 0). */
export function upsertDomain(db: Database, userId: string, domain: string, nginxConfig: string): Domain {
  prepare(db, `
    INSERT INTO domains (id, user_id, domain, verified, nginx_config, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      domain = excluded.domain,
      verified = 0,
      nginx_config = excluded.nginx_config,
      updated_at = excluded.updated_at
  `).run(randomUUID(), userId, domain, nginxConfig, Date.now())
  return findDomainByUser(db, userId)!
}

/**
 * 两个凭据列表共用的列清单与行映射—— 抽出来是为了**两处不可能漂**：
 * 之前 `listCredentialKeys` 与 `listEnabledCredentialKeys` 各写一份 SELECT，
 * 加一次列就要改两处，漏一处就是"一个列表有 route、另一个没有"。
 */
const CREDENTIAL_COLS = 'id, key_name, enabled, updated_at, route, base_url, api, models'

interface CredentialRow {
  id: string
  key_name: string
  enabled: number
  updated_at: number
  route: string | null
  base_url: string | null
  api: string | null
  models: string | null
}

function toCredentialKey(r: CredentialRow): CredentialKey {
  return {
    id: r.id,
    name: r.key_name,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
    route: r.route,
    baseUrl: r.base_url,
    api: r.api,
    models: r.models,
  }
}

/** List a user's named credential keys (metadata only). */
export function listCredentialKeys(db: Database, userId: string): CredentialKey[] {
  const rows = prepare(
    db,
    `SELECT ${CREDENTIAL_COLS} FROM credential_vault WHERE user_id = ? ORDER BY updated_at DESC`,
  ).all(userId) as CredentialRow[]
  return rows.map(toCredentialKey)
}

/**
 * **内置 DeepSeek 条目**的 encrypted ref（**语义重定义**，必须读这一条）。
 *
 * 老语义是「那一把启用的 key」—— 当时 `setCredentialKey` 会先 `SET enabled = 0` 全关，
 * 所以 `enabled = 1` **最多一行**，不带 ORDER BY 也唯一。
 * 用户口径改成「条目各自开关、都能同时启用」后，互斥被删（见 `setCredentialKey`）⇒
 * `WHERE enabled = 1` 可能命中**多行**，而**没有 ORDER BY 就是"任取一条"** ——
 * `auth.ts` 的 `keySourceOf()` 与 `server.ts` 的 `resolveApiKey()` 会因此**随机飘**。
 *
 * ⇒ 这里把语义钉死为：**已启用、且是内置 DeepSeek（`base_url` 为空）的最新一条**。
 * 自定义厂家**不算**"自己的 DeepSeek key"（它们各自有自己的 ref 与 settings 段）。
 * @returns 该 ref，或 `null`（用户没有任何启用的内置条目）。
 */
export function getEnabledCredentialKeyRef(db: Database, userId: string): string | null {
  const row = prepare(
    db,
    "SELECT secret_ref FROM credential_vault WHERE user_id = ? AND enabled = 1 AND (base_url IS NULL OR base_url = '') ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).get(userId) as { secret_ref: string } | undefined
  return row?.secret_ref ?? null
}

/**
 * Upsert a named key by `name` and enable it —— **不动**其它条目。
 *
 * ⚠️ 老行为是「先 `SET enabled = 0` 全关，再开这一个」（单选）。用户口径已改为
 * 「条目各自开关、都能同时启用」，所以那一行**已删**：否则用户每加一把 key，
 * 别的厂家就被静默关掉。要"只开这一个"请显式先关别的（`toggleCredentialKey`）。
 * @param meta - 模型厂家元数据（route / endpoint / 协议 / 模型清单），见 {@link CredentialKeyMeta}。
 */
export function setCredentialKey(
  db: Database,
  userId: string,
  name: string,
  encryptedRef: string,
  meta: CredentialKeyMeta = {},
): CredentialKey {
  const route = meta.route ?? null
  const baseUrl = meta.baseUrl ?? null
  const api = meta.api ?? null
  const models = meta.models ?? null
  const id = db.transaction(() => {
    const existing = prepare(db, 'SELECT id FROM credential_vault WHERE user_id = ? AND key_name = ?').get(
      userId,
      name,
    ) as { id: string } | undefined
    if (existing !== undefined) {
      prepare(
        db,
        'UPDATE credential_vault SET secret_ref = ?, route = ?, base_url = ?, api = ?, models = ?, enabled = 1, updated_at = ? WHERE id = ?',
      ).run(encryptedRef, route, baseUrl, api, models, Date.now(), existing.id)
      return existing.id
    }
    const newId = randomUUID()
    prepare(
      db,
      'INSERT INTO credential_vault (id, user_id, key_name, secret_ref, route, base_url, api, models, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    ).run(newId, userId, name, encryptedRef, route, baseUrl, api, models, Date.now())
    return newId
  })()
  return { id, name, enabled: true, updatedAt: Date.now(), route, baseUrl, api, models }
}

/**
 * 启用某一个条目（**改为非互斥**）。
 *
 * 老语义是「单选」：先 `SET enabled = 0` 把该用户所有条目关掉，再开这一个。
 * 用户口径改成「各自开关、可同时启用」之后，那一步会**悄悄关掉别的已启用条目**
 * （用户看不出为什么换了个厂家另一个就不生效了），所以这里退化成
 * `toggleCredentialKey(id, true)` 的同义实现 —— **保留函数名只为接口兼容**。
 */
export function selectCredentialKey(db: Database, userId: string, id: string): boolean {
  return toggleCredentialKey(db, userId, id, true)
}

/**
 * 打开/关闭**单个**条目（用户口径：条目各自开关、可同时启用）。
 * 与 `selectCredentialKey`（名字带"单选"但已改为非互斥）的差别：这里**只碰这一行**。
 * @returns 是否命中了该用户下的这一行（false = 不存在或不属于他）。
 */
export function toggleCredentialKey(db: Database, userId: string, id: string, enabled: boolean): boolean {
  const info = prepare(db, 'UPDATE credential_vault SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    enabled ? 1 : 0,
    Date.now(),
    id,
    userId,
  )
  return info.changes > 0
}

/** 该用户**所有已启用**的条目（含 route / base_url / api / models）—— spawn 时按它们写实例配置。 */
export function listEnabledCredentialKeys(db: Database, userId: string): CredentialKey[] {
  const rows = prepare(
    db,
    `SELECT ${CREDENTIAL_COLS} FROM credential_vault WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC`,
  ).all(userId) as CredentialRow[]
  return rows.map(toCredentialKey)
}

/**
 * 该用户**所有已启用**的条目 + 各自 encrypted ref —— **仅供落地层**。
 * 与 `listEnabledCredentialKeys` 的差别只有一个：多返回 `secret_ref`。
 * 单独一个函数是为了让"密文"这件事**不可能**顺着 `/api/me/keys` 漏出去。
 */
export function listCredentialLandingRows(db: Database, userId: string): CredentialLandingRow[] {
  const rows = prepare(
    db,
    'SELECT key_name, route, base_url, api, models, secret_ref FROM credential_vault WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC',
  ).all(userId) as Array<{
    key_name: string
    route: string | null
    base_url: string | null
    api: string | null
    models: string | null
    secret_ref: string
  }>
  return rows.map((r) => ({
    name: r.key_name,
    route: r.route,
    baseUrl: r.base_url,
    api: r.api,
    models: r.models,
    encryptedRef: r.secret_ref,
  }))
}

/**
 * 该用户是否启用「平台共享模型」—— **用户侧偏好**，开关它**不动** admin 的配置。
 *
 * 缺失行一律按 `true` 处理：V6 迁移给所有老用户填了默认 1，而"查不到这个人"时
 * 也不该因为一个开关把共享 key 断掉（宁可多给，不可少给）。
 */
export function getSharedModelEnabled(db: Database, userId: string): boolean {
  const row = prepare(db, 'SELECT shared_model_enabled FROM users WHERE id = ?').get(userId) as
    | { shared_model_enabled: number }
    | undefined
  return row === undefined ? true : row.shared_model_enabled !== 0
}

/** 打开/关闭「平台共享模型」。@returns 是否命中该用户。 */
export function setSharedModelEnabled(db: Database, userId: string, enabled: boolean): boolean {
  const info = prepare(db, 'UPDATE users SET shared_model_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, userId)
  return info.changes > 0
}

/** Delete a named key (by id, scoped to the user). */
export function deleteCredentialKey(db: Database, userId: string, id: string): boolean {
  const info = prepare(db, 'DELETE FROM credential_vault WHERE id = ? AND user_id = ?').run(id, userId)
  return info.changes > 0
}

/**
 * Permanently delete a user and all owned rows. Child tables are removed
 * explicitly (in dependency order) rather than relying on FK cascade, so the
 * cleanup works even when `PRAGMA foreign_keys` is off. Returns false when the
 * user does not exist.
 */
export function deleteUser(db: Database, userId: string): boolean {
  const deleted = db.transaction(() => {
    prepare(db, 'DELETE FROM credential_vault WHERE user_id = ?').run(userId)
    prepare(db, 'DELETE FROM domains WHERE user_id = ?').run(userId)
    prepare(db, 'DELETE FROM sessions WHERE user_id = ?').run(userId)
    prepare(db, 'DELETE FROM dsh_instances WHERE user_id = ?').run(userId)
    prepare(db, 'DELETE FROM audit_log WHERE actor = ?').run(userId)
    prepare(
      db,
      'DELETE FROM folder_plugins WHERE workspace_id IN (SELECT id FROM workspaces WHERE user_id = ?)',
    ).run(userId)
    prepare(db, 'DELETE FROM workspaces WHERE user_id = ?').run(userId)
    const info = prepare(db, 'DELETE FROM users WHERE id = ?').run(userId)
    return info.changes > 0
  })()
  return deleted as boolean
}

/** Set the verified flag on a domain. */
export function setDomainVerified(db: Database, id: string, verified: boolean): boolean {
  const info = prepare(db, 'UPDATE domains SET verified = ?, updated_at = ? WHERE id = ?')
    .run(verified ? 1 : 0, Date.now(), id)
  return info.changes > 0
}

/** Whether any of a user's sessions is still unexpired. */
export function hasActiveSession(db: Database, userId: string): boolean {
  const row = prepare(db, 'SELECT 1 FROM sessions WHERE user_id = ? AND expires_at > ? LIMIT 1')
    .get(userId, Date.now()) as { 1: number } | undefined
  return row !== undefined
}

/** Look up a session and its user in a single join. */
export function findSessionWithUser(db: Database, tokenHash: string): SessionUser | undefined {
  const row = prepare(
    db,
    `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.api_key_ref, u.created_at, u.approved_by, u.uid,
            s.expires_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = ?`,
  ).get(tokenHash) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return { expiresAt: row.expires_at as number, user: toUser(row) }
}

/** Assign a Linux uid to a user (legacy backfill). */
export function setUserUid(db: Database, userId: string, uid: number): void {
  prepare(db, 'UPDATE users SET uid = ? WHERE id = ?').run(uid, userId)
}

/** Ids of users whose uid is still null (legacy rows awaiting backfill). */
export function listUsersWithoutUid(db: Database): string[] {
  const rows = prepare(db, 'SELECT id FROM users WHERE uid IS NULL').all() as Array<{ id: string }>
  return rows.map((row) => row.id)
}

/** Record (or re-record) an instance's desired state. Keyed on the caller's
 * deterministic id, so a relaunch overwrites rather than duplicating. */
export function upsertInstance(db: Database, input: UpsertDshInstanceInput): void {
  prepare(db, `
    INSERT INTO dsh_instances (id, user_id, workspace_id, role, pid, port, status, started_at, folder, patch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      pid = excluded.pid,
      port = excluded.port,
      status = excluded.status,
      started_at = excluded.started_at,
      folder = excluded.folder,
      patch = excluded.patch
  `).run(
    input.id,
    input.userId,
    input.workspaceId ?? null,
    input.role,
    input.pid ?? null,
    input.port ?? null,
    input.status,
    Date.now(),
    input.folder ?? null,
    input.patch ?? null,
  )
}

export function findInstance(db: Database, id: string): DshInstance | undefined {
  const row = prepare(db, `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE id = ?`).get(id)
  return row ? toDshInstance(row as Record<string, unknown>) : undefined
}

export function findUserInstance(db: Database, userId: string, role: DshInstanceRole): DshInstance | undefined {
  const row = prepare(db, `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE user_id = ? AND role = ?`).get(userId, role)
  return row ? toDshInstance(row as Record<string, unknown>) : undefined
}

export function listInstancesByRole(db: Database, role: DshInstanceRole): DshInstance[] {
  const rows = prepare(db, `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE role = ? ORDER BY started_at ASC`)
    .all(role) as Array<Record<string, unknown>>
  return rows.map((row) => toDshInstance(row))
}

/** Record a state transition; an `outcome` also stamps `last_exit`. */
export function setInstanceStatus(
  db: Database,
  id: string,
  status: DshInstanceStatus,
  outcome?: { exitCode?: number; lastError?: string },
): boolean {
  const info =
    outcome === undefined
      ? prepare(db, 'UPDATE dsh_instances SET status = ? WHERE id = ?').run(status, id)
      : prepare(db, 'UPDATE dsh_instances SET status = ?, last_exit = ?, exit_code = ?, last_error = ? WHERE id = ?')
          .run(status, Date.now(), outcome.exitCode ?? null, outcome.lastError ?? null, id)
  return info.changes > 0
}

export function deleteInstance(db: Database, id: string): boolean {
  const info = prepare(db, 'DELETE FROM dsh_instances WHERE id = ?').run(id)
  return info.changes > 0
}

export function deleteUserInstances(db: Database, userId: string): void {
  prepare(db, 'DELETE FROM dsh_instances WHERE user_id = ?').run(userId)
}

// ── business plugins (系统外插件候选池) ────────────────────────────────

export function listBusinessPlugins(db: Database): BusinessPlugin[] {
  const rows = prepare(db, `SELECT ${BUSINESS_PLUGIN_COLS} FROM business_plugins ORDER BY name ASC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toBusinessPlugin(row))
}

export function findBusinessPlugin(db: Database, id: string): BusinessPlugin | undefined {
  const row = prepare(db, `SELECT ${BUSINESS_PLUGIN_COLS} FROM business_plugins WHERE id = ?`).get(id)
  return row ? toBusinessPlugin(row as Record<string, unknown>) : undefined
}

/**
 * Upsert a candidate-pool row keyed on the bundle package name (`id`). Same-name
 * upload REPLACES the row — the caller removes the previous tgz file first so no
 * stale artifact survives.
 */
export function upsertBusinessPlugin(db: Database, input: UpsertBusinessPluginInput): BusinessPlugin {
  prepare(db, `
    INSERT INTO business_plugins (id, name, description, version, tgz_path, file_size, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      version = excluded.version,
      tgz_path = excluded.tgz_path,
      file_size = excluded.file_size,
      uploaded_by = excluded.uploaded_by,
      updated_at = excluded.updated_at
  `).run(
    input.id,
    input.name,
    input.description ?? null,
    input.version ?? null,
    input.tgzPath,
    input.fileSize,
    input.uploadedBy,
    Date.now(),
    Date.now(),
  )
  return findBusinessPlugin(db, input.id)!
}

export function deleteBusinessPlugin(db: Database, id: string): boolean {
  const info = prepare(db, 'DELETE FROM business_plugins WHERE id = ?').run(id)
  return info.changes > 0
}
