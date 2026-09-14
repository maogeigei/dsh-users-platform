/**
 * Postgres backend for {@link DbAdapter} via node-postgres (`pg`). Used when
 * a `DSH_USERS_PLATFORM_DB_URL` is set. All methods are
 * genuinely async; transactions use {@link withTx}.
 * @module dsh-users-platform/db/pg
 */

import { randomUUID } from 'node:crypto'
import { Pool, types, type PoolClient } from 'pg'
import type { DbAdapter } from './adapter.js'
import { mapPgError } from './errors.js'
import { runPgMigrations } from './schema.js'
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

// Postgres returns int8 (BIGINT) as a string to avoid JS 53-bit precision loss.
// Our only BIGINT columns are epoch-*milliseconds*, which stay well below 2^53,
// so parse them back to numbers — the shared row mappers then read numbers in
// both backends. This is process-global and idempotent.
types.setTypeParser(20, (value: string) => Number(value))

const USER_COLS = 'id, username, pass_hash, role, home_dir, api_key_ref, created_at, approved_by, uid'
const DOMAIN_COLS = 'id, user_id, domain, verified, nginx_config, updated_at'
const BUSINESS_PLUGIN_COLS = 'id, name, description, version, tgz_path, file_size, uploaded_by, created_at, updated_at'
const INSTANCE_COLS =
  'id, user_id, workspace_id, role, pid, port, status, started_at, last_exit, exit_code, last_error, folder, patch'

/** Run `fn` on a dedicated client inside a BEGIN/COMMIT/ROLLBACK transaction. */
export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * 凭据行的列清单与映射—— 与 `repo.ts` 里同名的一组**逐字对应**：
 * 两个后端必须选出同一批列，否则就是"SQLite 上好好的、Postgres 上少字段"这种
 * 只在生产才出现的偏差。（**不**从 `repo.ts` 导入：那会把 better-sqlite3 原生依赖
 * 拖进 pg 模式。）
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

export class PgAdapter implements DbAdapter {
  constructor(private readonly pool: Pool, private readonly baseUid: number) {}

  async createUser(input: CreateUserInput): Promise<User> {
    const createdAt = Date.now()
    try {
      return await withTx(this.pool, async (client) => {
        const { rows } = await client.query(
          'INSERT INTO users (id, username, pass_hash, role, home_dir, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING row_id',
          [input.id, input.username, input.passHash, input.role, input.homeDir, createdAt],
        )
        const uid = this.baseUid + Number((rows[0] as { row_id: number }).row_id)
        await client.query('UPDATE users SET uid = $1 WHERE id = $2', [uid, input.id])
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
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE username = $1`, [username])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  async findUserBySlug(slug: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE LOWER(username) = $1`, [
      slug.toLowerCase(),
    ])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  async findUserById(id: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  async listPublicUsers(): Promise<PublicUser[]> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`)
    return rows.map((row) => toPublicUser(toUser(row as Record<string, unknown>)))
  }

  async countAdmins(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`)
    return (rows[0] as { n: number }).n
  }

  async setUserRole(id: string, role: UserRole, approvedBy?: string): Promise<boolean> {
    const result =
      approvedBy === undefined
        ? await this.pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id])
        : await this.pool.query('UPDATE users SET role = $1, approved_by = $2 WHERE id = $3', [role, approvedBy, id])
    return (result.rowCount ?? 0) > 0
  }

  async setUserUid(userId: string, uid: number): Promise<void> {
    await this.pool.query('UPDATE users SET uid = $1 WHERE id = $2', [uid, userId])
  }

  async listUsersWithoutUid(): Promise<string[]> {
    const { rows } = await this.pool.query('SELECT id FROM users WHERE uid IS NULL')
    return (rows as Array<{ id: string }>).map((row) => row.id)
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
        [input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null],
      )
    } catch (e) {
      mapPgError(e)
    }
  }

  async findSession(tokenHash: string): Promise<SessionRow | undefined> {
    const { rows } = await this.pool.query(
      'SELECT token_hash, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE token_hash = $1',
      [tokenHash],
    )
    return rows.length > 0 ? toSession(rows[0] as Record<string, unknown>) : undefined
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId])
  }

  async hasActiveSession(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM sessions WHERE user_id = $1 AND expires_at > $2 LIMIT 1',
      [userId, Date.now()],
    )
    return rows.length > 0
  }

  async findSessionWithUser(tokenHash: string): Promise<SessionUser | undefined> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.api_key_ref, u.created_at, u.approved_by, u.uid,
              s.expires_at
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = $1`,
      [tokenHash],
    )
    if (rows.length === 0) return undefined
    const row = rows[0] as Record<string, unknown>
    return { expiresAt: row.expires_at as number, user: toUser(row) }
  }

  async audit(actor: string | null, action: string, detail?: string | null): Promise<void> {
    await this.pool.query('INSERT INTO audit_log (ts, actor, action, detail) VALUES ($1, $2, $3, $4)', [
      Date.now(),
      actor,
      action,
      detail ?? null,
    ])
  }

  async findWorkspaceByPath(userId: string, relPath: string): Promise<Workspace | undefined> {
    const { rows } = await this.pool.query(
      'SELECT id, user_id, name, rel_path, created_at FROM workspaces WHERE user_id = $1 AND rel_path = $2',
      [userId, relPath],
    )
    return rows.length > 0 ? toWorkspace(rows[0] as Record<string, unknown>) : undefined
  }

  async getOrCreateWorkspace(userId: string, relPath: string): Promise<Workspace> {
    const existing = await this.findWorkspaceByPath(userId, relPath)
    if (existing !== undefined) return existing
    const id = randomUUID()
    const segments = relPath.split('/').filter(Boolean)
    const name = segments.at(-1) ?? 'root'
    try {
      await this.pool.query(
        'INSERT INTO workspaces (id, user_id, name, rel_path, created_at) VALUES ($1, $2, $3, $4, $5)',
        [id, userId, name, relPath, Date.now()],
      )
    } catch (e) {
      mapPgError(e)
    }
    return { id, userId, name, relPath, createdAt: Date.now() }
  }

  async setFolderPlugins(
    workspaceId: string,
    selections: ReadonlyArray<{ id: string; enabled: boolean }>,
  ): Promise<void> {
    try {
      await withTx(this.pool, async (client) => {
        await client.query('DELETE FROM folder_plugins WHERE workspace_id = $1', [workspaceId])
        for (const selection of selections) {
          await client.query(
            'INSERT INTO folder_plugins (workspace_id, plugin_id, enabled, updated_at) VALUES ($1, $2, $3, $4)',
            [workspaceId, selection.id, selection.enabled ? 1 : 0, Date.now()],
          )
        }
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  async getEnabledPluginIds(workspaceId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      'SELECT plugin_id FROM folder_plugins WHERE workspace_id = $1 AND enabled = 1',
      [workspaceId],
    )
    return (rows as Array<{ plugin_id: string }>).map((row) => row.plugin_id)
  }

  async listBusinessPlugins(): Promise<BusinessPlugin[]> {
    const { rows } = await this.pool.query(`SELECT ${BUSINESS_PLUGIN_COLS} FROM business_plugins ORDER BY name ASC`)
    return rows.map((row) => toBusinessPlugin(row as Record<string, unknown>))
  }

  async findBusinessPlugin(id: string): Promise<BusinessPlugin | undefined> {
    const { rows } = await this.pool.query(`SELECT ${BUSINESS_PLUGIN_COLS} FROM business_plugins WHERE id = $1`, [id])
    return rows.length > 0 ? toBusinessPlugin(rows[0] as Record<string, unknown>) : undefined
  }

  async upsertBusinessPlugin(input: UpsertBusinessPluginInput): Promise<BusinessPlugin> {
    await this.pool.query(
      `
      INSERT INTO business_plugins (id, name, description, version, tgz_path, file_size, uploaded_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        version = excluded.version,
        tgz_path = excluded.tgz_path,
        file_size = excluded.file_size,
        uploaded_by = excluded.uploaded_by,
        updated_at = excluded.updated_at
      `,
      [
        input.id,
        input.name,
        input.description ?? null,
        input.version ?? null,
        input.tgzPath,
        input.fileSize,
        input.uploadedBy,
        Date.now(),
      ],
    )
    return (await this.findBusinessPlugin(input.id))!
  }

  async deleteBusinessPlugin(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM business_plugins WHERE id = $1', [id])
    return (result.rowCount ?? 0) > 0
  }

  async findDomainByUser(userId: string): Promise<Domain | undefined> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains WHERE user_id = $1`, [userId])
    return rows.length > 0 ? toDomain(rows[0] as Record<string, unknown>) : undefined
  }

  async findDomainById(id: string): Promise<Domain | undefined> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains WHERE id = $1`, [id])
    return rows.length > 0 ? toDomain(rows[0] as Record<string, unknown>) : undefined
  }

  async listDomains(): Promise<Domain[]> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains ORDER BY updated_at DESC`)
    return rows.map((row) => toDomain(row as Record<string, unknown>))
  }

  async upsertDomain(userId: string, domain: string, nginxConfig: string): Promise<Domain> {
    try {
      await this.pool.query(
        `
        INSERT INTO domains (id, user_id, domain, verified, nginx_config, updated_at)
        VALUES ($1, $2, $3, 0, $4, $5)
        ON CONFLICT(user_id) DO UPDATE SET
          domain = excluded.domain,
          verified = 0,
          nginx_config = excluded.nginx_config,
          updated_at = excluded.updated_at
        `,
        [randomUUID(), userId, domain, nginxConfig, Date.now()],
      )
    } catch (e) {
      mapPgError(e)
    }
    return (await this.findDomainByUser(userId))!
  }

  async setDomainVerified(id: string, verified: boolean): Promise<boolean> {
    const result = await this.pool.query('UPDATE domains SET verified = $1, updated_at = $2 WHERE id = $3', [
      verified ? 1 : 0,
      Date.now(),
      id,
    ])
    return (result.rowCount ?? 0) > 0
  }

  async listCredentialKeys(userId: string): Promise<CredentialKey[]> {
    const { rows } = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credential_vault WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    )
    return (rows as CredentialRow[]).map(toCredentialKey)
  }

  async listEnabledCredentialKeys(userId: string): Promise<CredentialKey[]> {
    const { rows } = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credential_vault WHERE user_id = $1 AND enabled = 1 ORDER BY updated_at DESC`,
      [userId],
    )
    return (rows as CredentialRow[]).map(toCredentialKey)
  }

  /** 落地层专用：多返回 `secret_ref`（密文）—— 与 `listEnabledCredentialKeys` 的唯一差别。 */
  async listCredentialLandingRows(userId: string): Promise<CredentialLandingRow[]> {
    const { rows } = await this.pool.query(
      'SELECT key_name, route, base_url, api, models, secret_ref FROM credential_vault WHERE user_id = $1 AND enabled = 1 ORDER BY updated_at DESC',
      [userId],
    )
    return (
      rows as Array<{
        key_name: string
        route: string | null
        base_url: string | null
        api: string | null
        models: string | null
        secret_ref: string
      }>
    ).map((r) => ({
      name: r.key_name,
      route: r.route,
      baseUrl: r.base_url,
      api: r.api,
      models: r.models,
      encryptedRef: r.secret_ref,
    }))
  }

  /**
   * **内置 DeepSeek 条目**的 encrypted ref（语义重定义）。
   * 互斥被删之后 `enabled = 1` 可能命中多行 ⇒ 必须钉死"内置 + 最新一条"，
   * 否则调用方会随机拿到某一个厂家的 key（详见 `repo.ts` 同名函数的注释）。
   */
  async getEnabledCredentialKeyRef(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT secret_ref FROM credential_vault WHERE user_id = $1 AND enabled = 1 AND (base_url IS NULL OR base_url = '') ORDER BY updated_at DESC, id DESC LIMIT 1",
      [userId],
    )
    const row = rows[0] as { secret_ref: string } | undefined
    return row?.secret_ref ?? null
  }

  /** Upsert by `name` 并启用它 —— **不动**其它条目（互斥已删）。 */
  async setCredentialKey(
    userId: string,
    name: string,
    encryptedRef: string,
    meta?: CredentialKeyMeta,
  ): Promise<CredentialKey> {
    const route = meta?.route ?? null
    const baseUrl = meta?.baseUrl ?? null
    const api = meta?.api ?? null
    const models = meta?.models ?? null
    try {
      return await withTx(this.pool, async (client) => {
        const existing = await client.query('SELECT id FROM credential_vault WHERE user_id = $1 AND key_name = $2', [
          userId,
          name,
        ])
        let id: string
        if (existing.rows.length > 0) {
          id = (existing.rows[0] as { id: string }).id
          await client.query(
            'UPDATE credential_vault SET secret_ref = $1, route = $2, base_url = $3, api = $4, models = $5, enabled = 1, updated_at = $6 WHERE id = $7',
            [encryptedRef, route, baseUrl, api, models, Date.now(), id],
          )
        } else {
          id = randomUUID()
          await client.query(
            'INSERT INTO credential_vault (id, user_id, key_name, secret_ref, route, base_url, api, models, enabled, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)',
            [id, userId, name, encryptedRef, route, baseUrl, api, models, Date.now()],
          )
        }
        return { id, name, enabled: true, updatedAt: Date.now(), route, baseUrl, api, models }
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  /** 启用一个条目（**非互斥**，不再先全关）。 */
  async selectCredentialKey(userId: string, id: string): Promise<boolean> {
    return await this.toggleCredentialKey(userId, id, true)
  }

  async toggleCredentialKey(userId: string, id: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE credential_vault SET enabled = $1, updated_at = $2 WHERE id = $3 AND user_id = $4',
      [enabled ? 1 : 0, Date.now(), id, userId],
    )
    return (result.rowCount ?? 0) > 0
  }

  /** 该用户是否启用「平台共享模型」—— 缺失行按 `true`（默认值）。 */
  async getSharedModelEnabled(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT shared_model_enabled FROM users WHERE id = $1', [userId])
    const row = rows[0] as { shared_model_enabled: number } | undefined
    return row === undefined ? true : Number(row.shared_model_enabled) !== 0
  }

  async setSharedModelEnabled(userId: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query('UPDATE users SET shared_model_enabled = $1 WHERE id = $2', [
      enabled ? 1 : 0,
      userId,
    ])
    return (result.rowCount ?? 0) > 0
  }

  async deleteCredentialKey(userId: string, id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM credential_vault WHERE id = $1 AND user_id = $2', [id, userId])
    return (result.rowCount ?? 0) > 0
  }

  async deleteUser(userId: string): Promise<boolean> {
    return await withTx(this.pool, async (client) => {
      await client.query('DELETE FROM credential_vault WHERE user_id = $1', [userId])
      await client.query('DELETE FROM domains WHERE user_id = $1', [userId])
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId])
      await client.query('DELETE FROM dsh_instances WHERE user_id = $1', [userId])
      await client.query('DELETE FROM audit_log WHERE actor = $1', [userId])
      await client.query(
        'DELETE FROM folder_plugins WHERE workspace_id IN (SELECT id FROM workspaces WHERE user_id = $1)',
        [userId],
      )
      await client.query('DELETE FROM workspaces WHERE user_id = $1', [userId])
      const result = await client.query('DELETE FROM users WHERE id = $1', [userId])
      return (result.rowCount ?? 0) > 0
    })
  }

  async upsertInstance(input: UpsertDshInstanceInput): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO dsh_instances (id, user_id, workspace_id, role, pid, port, status, started_at, folder, patch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           pid = excluded.pid,
           port = excluded.port,
           status = excluded.status,
           started_at = excluded.started_at,
           folder = excluded.folder,
           patch = excluded.patch`,
        [
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
        ],
      )
    } catch (e) {
      mapPgError(e)
    }
  }

  async findInstance(id: string): Promise<DshInstance | undefined> {
    const { rows } = await this.pool.query(`SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE id = $1`, [id])
    return rows.length > 0 ? toDshInstance(rows[0] as Record<string, unknown>) : undefined
  }

  async findUserInstance(userId: string, role: DshInstanceRole): Promise<DshInstance | undefined> {
    const { rows } = await this.pool.query(
      `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE user_id = $1 AND role = $2`,
      [userId, role],
    )
    return rows.length > 0 ? toDshInstance(rows[0] as Record<string, unknown>) : undefined
  }

  async listInstancesByRole(role: DshInstanceRole): Promise<DshInstance[]> {
    const { rows } = await this.pool.query(
      `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE role = $1 ORDER BY started_at ASC`,
      [role],
    )
    return rows.map((row) => toDshInstance(row as Record<string, unknown>))
  }

  async setInstanceStatus(
    id: string,
    status: DshInstanceStatus,
    outcome?: { exitCode?: number; lastError?: string },
  ): Promise<boolean> {
    const result =
      outcome === undefined
        ? await this.pool.query('UPDATE dsh_instances SET status = $1 WHERE id = $2', [status, id])
        : await this.pool.query(
            'UPDATE dsh_instances SET status = $1, last_exit = $2, exit_code = $3, last_error = $4 WHERE id = $5',
            [status, Date.now(), outcome.exitCode ?? null, outcome.lastError ?? null, id],
          )
    return (result.rowCount ?? 0) > 0
  }

  async deleteInstance(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM dsh_instances WHERE id = $1', [id])
    return (result.rowCount ?? 0) > 0
  }

  async deleteUserInstances(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM dsh_instances WHERE user_id = $1', [userId])
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** Open a Postgres adapter: connect, run migrations, then wrap the pool. */
export async function openPgAdapter(connectionString: string, baseUid: number): Promise<PgAdapter> {
  const pool = new Pool({ connectionString })
  await runPgMigrations(pool)
  return new PgAdapter(pool, baseUid)
}
