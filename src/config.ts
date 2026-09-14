/**
 * Deployment-varying configuration. Every tunable is a validated field here
 * (or read from env), never a hardcoded constant inside the app.
 * @module dsh-users-platform/config
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/** Isolation tier. `soft` = per-user home/workspace + sandbox (same OS user);
 * `account` = per-user OS account via a setuid wrapper (Linux, needs root). */
export type IsolationMode = 'soft' | 'account'

/** Deployment mode: a single host running per-user child processes (setuid/iptables). */
export type DeployMode = 'local'

/** Resolved, immutable runtime configuration. */
export interface ServerConfig {
  /** Bind host for the orchestrator HTTP server. */
  host: string
  /** Bind port; `0` requests an ephemeral port. */
  port: number
  /** SQLite database path. */
  dbPath: string
  /** Postgres connection string; when set, the DB backend is Postgres (shared HA). */
  dbUrl?: string
  /** Root under which per-user homes (`users/<id>/home`) and workspaces live. */
  dataRoot: string
  /** Shared read-only skill directory for all users (injected as
   * `DSH_BUNDLED_SKILL_DIR` into every spawned DSH); empty = feature off. */
  bundledSkillDir: string
  /** Argv used to launch a child DSH; first element is the executable. */
  dshCommand: string[]
  /** Pino log level. */
  logLevel: string
  /** Set the `Secure` flag on session cookies (enable behind HTTPS). */
  secureCookies: boolean
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number
  /** Max upload request body in bytes (base64 JSON; ~0.75× the file size). */
  maxUploadBytes: number
  /** Delay before auto-restarting a crashed child DSH, in milliseconds. */
  restartBackoffMs: number
  /** Upper bound for the exponential crash-restart backoff . */
  restartBackoffMaxMs: number
  /** Auto-restarts allowed inside `crashWindowMs` before the circuit opens. */
  crashMaxRestarts: number
  /** Rolling window used to count auto-restarts . */
  crashWindowMs: number
  /** Uptime after which a main counts as recovered and the backoff resets. */
  crashStableMs: number
  /** 熔断首次冷却时长（冷却期内拒绝隐式启动）。 */
  crashBreakerCooldownMs: number
  /** 熔断冷却上限（多次熔断后指数加长到此为止）。 */
  crashBreakerMaxCooldownMs: number
  /** Isolation tier (see {@link IsolationMode}); local mode only. */
  isolationMode: IsolationMode
  /** Argv prefix that drops privileges; `{UID}`/`{GID}` are substituted. Local mode only. */
  spawnAsUserCommand: string[]
  /** Base uid for the deterministic per-user uid. */
  baseUid: number
  /** Parent domain for per-user subdomains (`<username>.<baseDomain>`); empty = disabled. */
  baseDomain: string
  /** Cookie `Domain` value (e.g. `.example.com`) so the session reaches subdomains; empty = host-only. */
  cookieDomain: string
  /** Whether to pass `--patch` to child DSHs (needs a dsh CLI that supports it). */
  enablePatch: boolean
  /** Enable the loopback OUTPUT owner-match port guard (Linux + root). Local mode only. */
  portGuard: boolean
  /** Cap on resident main instances per host (0 = no cap). Local mode idle reap. */
  maxIdleInstances: number
  /** A main instance with no proxied/entered activity for this long is stopped
   * (0 = disabled). Local mode idle reap. */
  instanceIdleTtlSeconds: number
  /** Period between idle-reap scans (seconds). Local mode idle reap. */
  idleReapIntervalSeconds: number
  /** Secret used to encrypt per-user secrets at rest (from env or dataRoot/secret.key). */
  encryptionSecret: string
  /** Deployment mode (see {@link DeployMode}). */
  deployMode: DeployMode
}

/** Untyped overrides collected from argv / env. */
export interface ConfigOverrides {
  host?: string
  port?: string | number
  dbPath?: string
  dbUrl?: string
  dataRoot?: string
  bundledSkillDir?: string
  dshCommand?: string[]
  logLevel?: string
  secureCookies?: boolean
  sessionTtlSeconds?: number | string
  maxUploadBytes?: number | string
  restartBackoffMs?: number | string
  restartBackoffMaxMs?: number | string
  crashMaxRestarts?: number | string
  crashWindowMs?: number | string
  crashStableMs?: number | string
  crashBreakerCooldownMs?: number | string
  crashBreakerMaxCooldownMs?: number | string
  isolationMode?: IsolationMode | string
  spawnAsUserCommand?: string[]
  baseUid?: number | string
  baseDomain?: string
  cookieDomain?: string
  enablePatch?: boolean
  portGuard?: boolean
  maxIdleInstances?: number | string
  instanceIdleTtlSeconds?: number | string
  idleReapIntervalSeconds?: number | string
  encryptionSecret?: string
  deployMode?: DeployMode | string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const DEFAULT_DSH_COMMAND = ['dsh']
const DEFAULT_LOG_LEVEL = 'info'
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const DEFAULT_RESTART_BACKOFF_MS = 1000
/** 崩溃自愈退避上限。 */
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30000
/** 熔断窗口内允许的自动重启次数。 */
const DEFAULT_CRASH_MAX_RESTARTS = 5
/** 熔断窗口长度。 */
const DEFAULT_CRASH_WINDOW_MS = 600000
/** 连续运行多久视为已恢复、重置退避步数。 */
const DEFAULT_CRASH_STABLE_MS = 60000
// 熔断冷却 —— 首次 10 分钟，指数加长，封顶 6 小时
const DEFAULT_CRASH_BREAKER_COOLDOWN_MS = 600000
const DEFAULT_CRASH_BREAKER_MAX_COOLDOWN_MS = 21600000
const DEFAULT_ISOLATION_MODE: IsolationMode = 'soft'
const DEFAULT_SPAWN_AS_USER_COMMAND = [
  'setpriv',
  '--reuid',
  '{UID}',
  '--regid',
  '{GID}',
  '--inh-caps=-all',
  '--clear-groups',
  '--',
]
const DEFAULT_BASE_UID = 100000
const DEFAULT_BASE_DOMAIN = ''
const DEFAULT_COOKIE_DOMAIN = ''
const DEFAULT_ENABLE_PATCH = false
const DEFAULT_MAX_IDLE_INSTANCES = 4
const DEFAULT_INSTANCE_IDLE_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_IDLE_REAP_INTERVAL_SECONDS = 60
const DEFAULT_DEPLOY_MODE: DeployMode = 'local'

/** Load the encryption secret from env, or persist a generated one at
 * `<dataRoot>/secret.key` (0600) so it survives restarts without setup. */
function resolveEncryptionSecret(dataRoot: string): string {
  const fromEnv = process.env.DSH_USERS_PLATFORM_SECRET
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const path = join(dataRoot, 'secret.key')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing !== '') return existing
  } catch {
    // fall through to generate
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path, secret, { mode: 0o600 })
  return secret
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}


/** Parse an isolation-mode value, rejecting anything outside `soft`/`account`
 * so a typo in the env var fails loudly at startup instead of silently
 * falling back to `soft` isolation. */
function toIsolationMode(value: string | undefined): IsolationMode | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'soft' || normalized === 'account') return normalized
  throw new Error(`invalid isolation mode "${value}" (expected "soft" or "account")`)
}

/** Parse a deploy-mode value, rejecting anything outside `local`. */
function toDeployMode(value: string | undefined): DeployMode | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'local') return normalized
  throw new Error(`invalid deploy mode "${value}" (expected "local")`)
}

/**
 * Fold argv/env overrides over defaults. `dataRoot` defaults to
 * `~/.dsh-users-platform` (always writable for dev); production sets
 * `DSH_USERS_PLATFORM_DATA_ROOT=/var/lib/dsh-users-platform`.
 */
export function resolveConfig(overrides: ConfigOverrides = {}): ServerConfig {
  const dataRoot =
    overrides.dataRoot ?? process.env.DSH_USERS_PLATFORM_DATA_ROOT ?? join(homedir(), '.dsh-users-platform')
  const port = overrides.port ?? process.env.DSH_USERS_PLATFORM_PORT ?? DEFAULT_PORT
  const dshBin = process.env.DSH_USERS_PLATFORM_DSH_BIN
  const isolationMode =
    toIsolationMode(overrides.isolationMode) ??
    toIsolationMode(process.env.DSH_USERS_PLATFORM_ISOLATION_MODE) ??
    DEFAULT_ISOLATION_MODE
  const deployMode =
    toDeployMode(overrides.deployMode) ??
    toDeployMode(process.env.DSH_USERS_PLATFORM_DEPLOY_MODE) ??
    DEFAULT_DEPLOY_MODE
  return {
    host: overrides.host ?? DEFAULT_HOST,
    port: typeof port === 'number' ? port : Number(port),
    dbPath: overrides.dbPath ?? join(dataRoot, 'dsh-users-platform.db'),
    dbUrl: overrides.dbUrl ?? process.env.DSH_USERS_PLATFORM_DB_URL,
    dataRoot,
    bundledSkillDir:
      overrides.bundledSkillDir ??
      process.env.DSH_USERS_PLATFORM_BUNDLED_SKILL_DIR ??
      join(dataRoot, 'bundled-skills'),
    dshCommand: overrides.dshCommand ?? (dshBin !== undefined ? [dshBin] : DEFAULT_DSH_COMMAND),
    logLevel: overrides.logLevel ?? DEFAULT_LOG_LEVEL,
    secureCookies:
      overrides.secureCookies ?? toBool(process.env.DSH_USERS_PLATFORM_SECURE_COOKIES, false),
    sessionTtlSeconds: Number(
      overrides.sessionTtlSeconds ?? process.env.DSH_USERS_PLATFORM_SESSION_TTL ?? DEFAULT_SESSION_TTL_SECONDS,
    ),
    maxUploadBytes: Number(
      overrides.maxUploadBytes ?? process.env.DSH_USERS_PLATFORM_MAX_UPLOAD ?? DEFAULT_MAX_UPLOAD_BYTES,
    ),
    restartBackoffMs: Number(
      overrides.restartBackoffMs ?? process.env.DSH_USERS_PLATFORM_RESTART_BACKOFF ?? DEFAULT_RESTART_BACKOFF_MS,
    ),
    restartBackoffMaxMs: Number(
      overrides.restartBackoffMaxMs ??
        process.env.DSH_USERS_PLATFORM_RESTART_BACKOFF_MAX ??
        DEFAULT_RESTART_BACKOFF_MAX_MS,
    ),
    crashMaxRestarts: Number(
      overrides.crashMaxRestarts ??
        process.env.DSH_USERS_PLATFORM_CRASH_MAX_RESTARTS ??
        DEFAULT_CRASH_MAX_RESTARTS,
    ),
    crashWindowMs: Number(
      overrides.crashWindowMs ?? process.env.DSH_USERS_PLATFORM_CRASH_WINDOW ?? DEFAULT_CRASH_WINDOW_MS,
    ),
    crashStableMs: Number(
      overrides.crashStableMs ?? process.env.DSH_USERS_PLATFORM_CRASH_STABLE ?? DEFAULT_CRASH_STABLE_MS,
    ),
    crashBreakerCooldownMs: Number(
      overrides.crashBreakerCooldownMs ??
        process.env.DSH_USERS_PLATFORM_CRASH_BREAKER_COOLDOWN ??
        DEFAULT_CRASH_BREAKER_COOLDOWN_MS,
    ),
    crashBreakerMaxCooldownMs: Number(
      overrides.crashBreakerMaxCooldownMs ??
        process.env.DSH_USERS_PLATFORM_CRASH_BREAKER_MAX_COOLDOWN ??
        DEFAULT_CRASH_BREAKER_MAX_COOLDOWN_MS,
    ),
    isolationMode,
    spawnAsUserCommand: overrides.spawnAsUserCommand ?? DEFAULT_SPAWN_AS_USER_COMMAND,
    baseUid: Number(overrides.baseUid ?? process.env.DSH_USERS_PLATFORM_BASE_UID ?? DEFAULT_BASE_UID),
    baseDomain: overrides.baseDomain ?? process.env.DSH_USERS_PLATFORM_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN,
    cookieDomain: overrides.cookieDomain ?? process.env.DSH_USERS_PLATFORM_COOKIE_DOMAIN ?? DEFAULT_COOKIE_DOMAIN,
    enablePatch: overrides.enablePatch ?? toBool(process.env.DSH_USERS_PLATFORM_ENABLE_PATCH, DEFAULT_ENABLE_PATCH),
    portGuard: overrides.portGuard ?? toBool(process.env.DSH_USERS_PLATFORM_PORT_GUARD, false),
    maxIdleInstances: Number(
      overrides.maxIdleInstances ?? process.env.DSH_USERS_PLATFORM_MAX_IDLE_INSTANCES ?? DEFAULT_MAX_IDLE_INSTANCES,
    ),
    instanceIdleTtlSeconds: Number(
      overrides.instanceIdleTtlSeconds ??
        process.env.DSH_USERS_PLATFORM_INSTANCE_IDLE_TTL ??
        DEFAULT_INSTANCE_IDLE_TTL_SECONDS,
    ),
    idleReapIntervalSeconds: Number(
      overrides.idleReapIntervalSeconds ??
        process.env.DSH_USERS_PLATFORM_IDLE_REAP_INTERVAL ??
        DEFAULT_IDLE_REAP_INTERVAL_SECONDS,
    ),
    encryptionSecret:
      overrides.encryptionSecret ?? resolveEncryptionSecret(dataRoot),
    deployMode,
  }
}
