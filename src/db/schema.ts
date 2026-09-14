/**
 * Schema migrations, dual-dialect. Each migration carries SQLite and Postgres
 * DDL; the active adapter runs only its own dialect. `schema_migrations` is
 * shared (same table shape), so a SQLite↔Postgres dump/restore round-trips the
 * applied-version marker too.
 *
 * Dialect notes (kept out of the route layer):
 * - timestamps are epoch **milliseconds** (Date.now()), which exceeds 32-bit
 *   `INTEGER`; SQLite `INTEGER` is 64-bit, Postgres uses `BIGINT`.
 * - `enabled`/`verified` are `INTEGER 0/1` in *both* dialects so the row mappers
 *   stay byte-identical across backends (no boolean/0/1 branch).
 * - `audit_log.id` uses SQLite `AUTOINCREMENT` vs Postgres `IDENTITY`.
 * @module dsh-users-platform/db/schema
 */

import type { Database } from './connection.js'
import type { Pool } from 'pg'

const SQLITE_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   INTEGER NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

-- 【2026-09-11 便宜版】该表仅被 enablePatch 分支使用
-- （src/web/routes/dsh.ts 的 findWorkspaceByPath），而 DEFAULT_ENABLE_PATCH=false 且生产 env 未覆盖
-- → 本部署不可达。保留以兼容 Postgres 路径；请勿在此表上新增功能。
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (user_id, rel_path)
);

-- 【2026-09-11 便宜版】该表在本部署已废弃：folder_plugins 无任何业务/路由调用
-- （grep 实证：仅 src/db/* 自引用；平台已宣布 folder 级插件废弃）。
-- 保留表结构仅为兼容 Postgres 路径——请勿在此表上新增功能。
CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped')),
  started_at   INTEGER,
  last_exit    INTEGER,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id            TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE REFERENCES users(id),
  domain        TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  nginx_config  TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, key_name)
);
`

const SQLITE_V2 = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

const PG_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   BIGINT NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

-- 【2026-09-11 便宜版】该表仅被 enablePatch 分支使用
-- （src/web/routes/dsh.ts 的 findWorkspaceByPath），而 DEFAULT_ENABLE_PATCH=false 且生产 env 未覆盖
-- → 本部署不可达。保留以兼容 Postgres 路径；请勿在此表上新增功能。
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE (user_id, rel_path)
);

-- 【2026-09-11 便宜版】该表在本部署已废弃：folder_plugins 无任何业务/路由调用
-- （grep 实证：仅 src/db/* 自引用；平台已宣布 folder 级插件废弃）。
-- 保留表结构仅为兼容 Postgres 路径——请勿在此表上新增功能。
CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped')),
  started_at   BIGINT,
  last_exit    BIGINT,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts           BIGINT NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id            TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE REFERENCES users(id),
  domain        TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  nginx_config  TEXT,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (user_id, key_name)
);
`

const PG_V2 = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

// v3: per-user Linux uid (non-colliding for new users via an identity column).
// SQLite reuses its implicit `rowid` for the incrementing integer, so only the
// `uid` column is added here; Postgres adds an explicit identity `row_id`.
const SQLITE_V3 = `
ALTER TABLE users ADD COLUMN uid INTEGER;
`

const PG_V3 = `
ALTER TABLE users ADD COLUMN row_id BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE users ADD COLUMN uid BIGINT;
`

// v4: desired-state columns on `dsh_instances`. The table has existed since v1
// but was never read or written; it holds the launch folder and the rendered
// Cordis patch, which is what a relaunch needs to rebuild an instance that
// went missing.
const SQLITE_V4 = `
ALTER TABLE dsh_instances ADD COLUMN folder TEXT;
ALTER TABLE dsh_instances ADD COLUMN patch TEXT;
`

const PG_V4 = `
ALTER TABLE dsh_instances ADD COLUMN folder TEXT;
ALTER TABLE dsh_instances ADD COLUMN patch TEXT;
`

// v5: business-plugin candidate pool (系统外插件 = 功能插件). Admin uploads a
// tgz bundle into the pool; users enable it per-instance from the dsh settings
// section . Same-name upload REPLACES the row (not overwrite — the old
// tgz file is removed first, so deleted files cannot survive).
const SQLITE_V5 = `
CREATE TABLE IF NOT EXISTS business_plugins (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  version      TEXT,
  tgz_path     TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  uploaded_by  TEXT REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
`

const PG_V5 = `
CREATE TABLE IF NOT EXISTS business_plugins (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  version      TEXT,
  tgz_path     TEXT NOT NULL,
  file_size    BIGINT NOT NULL,
  uploaded_by  TEXT REFERENCES users(id),
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);
`

// v6: 用户自配「模型厂家」支持。
// 原先 `credential_vault` 只存一把 key（`key_name` 兼作展示名）；用户要按**厂家**配模型，
// 平台还需要知道：**route**（= settings.yaml 里 `llm-pi-ai.providers` 的 dict 键）、
// **endpoint**（`baseURL`）、**协议**（`api`）、**模型清单**（`models`）—— spawn 时按这四样写
// `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<route>` 与
// `$DSH_HOME/.credentials.yaml` 的 `refs.<REF>`。
//   · `base_url` 为空 = **内置 DeepSeek**（只写 refs，不写 settings.yaml）。
//   · REF 命名：内置 = `DEEPSEEK_API_KEY`；自定义 = `<ROUTE 大写化>_API_KEY`
//     （须匹配 `@deepseek-ai/dsh-credentials` 的 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`）。
//   · `api` 的合法值只有三个（`dsh-llm-pi-ai` 的 `PROTOCOLS` 键，顺序即默认优先级）：
//     `openai-completions` / `openai-responses` / `anthropic-messages`。
//   · ⚠️ 字段名是 **`api` 不是 `protocol`**；`apiKeyEnv`（不是 `apiKey`）；且该 profile
//     **不接受** `provider` / `maxRetries` / `maxRetryDelayMs`（会直接抛错）。
//     以上全部为 2026-09-13 读官方包 `dsh-llm-pi-ai@0.1.2-rc.1` 的 `lib/index.js`
//     （`const NS = "llm-pi-ai"` / `profile` schema / `PROTOCOLS`）实测结论。
// 另：`users.shared_model_enabled` = 用户**要不要用平台共享模型**（admin 配的那把）——
// 属于用户侧偏好，开关它**不动** admin 的配置（用户口径：条目各自开关，都能同时启用；
// 具体用哪个模型是在 dsh 对话框的模型选择器里挑）。
const SQLITE_V6 = `
ALTER TABLE credential_vault ADD COLUMN route TEXT;
ALTER TABLE credential_vault ADD COLUMN base_url TEXT;
ALTER TABLE credential_vault ADD COLUMN api TEXT;
ALTER TABLE credential_vault ADD COLUMN models TEXT;
ALTER TABLE users ADD COLUMN shared_model_enabled INTEGER NOT NULL DEFAULT 1;
`

const PG_V6 = `
ALTER TABLE credential_vault ADD COLUMN route TEXT;
ALTER TABLE credential_vault ADD COLUMN base_url TEXT;
ALTER TABLE credential_vault ADD COLUMN api TEXT;
ALTER TABLE credential_vault ADD COLUMN models TEXT;
ALTER TABLE users ADD COLUMN shared_model_enabled INTEGER NOT NULL DEFAULT 1;
`

interface Migration {
  version: number
  name: string
  sqlite: string
  pg: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sqlite: SQLITE_V1, pg: PG_V1 },
  { version: 2, name: 'credential vault enabled flag', sqlite: SQLITE_V2, pg: PG_V2 },
  { version: 3, name: 'per-user uid', sqlite: SQLITE_V3, pg: PG_V3 },
  { version: 4, name: 'instance desired state', sqlite: SQLITE_V4, pg: PG_V4 },
  { version: 5, name: 'business plugin candidate pool', sqlite: SQLITE_V5, pg: PG_V5 },
  { version: 6, name: 'user model providers', sqlite: SQLITE_V6, pg: PG_V6 },
]

/** Apply unapplied SQLite migrations inside a single transaction. */
export function runSqliteMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
  const applied = new Set(rows.map((row) => row.version))

  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      db.exec(migration.sqlite)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      )
    }
  })
  apply()
}

/** Apply unapplied Postgres migrations inside a single transaction. */
export async function runPgMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
    `)
    const { rows } = await client.query('SELECT version FROM schema_migrations')
    const applied = new Set(rows.map((row) => row.version as number))
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      await client.query(migration.pg)
      await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        Date.now(),
      ])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
