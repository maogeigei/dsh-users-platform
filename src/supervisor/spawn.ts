/**
 * Child-process helpers for the supervisor: env scrubbing and free-port lookup.
 *
 * Env scrubbing mirrors the harness `scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN`
 * doctrine (packages/subprocess/subprocess/src/index.ts): build the child env
 * from a clean allowlist so no orchestrator secret leaks into a user DSH, then
 * inject only the resolved per-user values.
 * @module dsh-users-platform/supervisor/spawn
 */

import { createServer } from 'node:net'

const ALLOWED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'PATHEXT',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LANG',
  'LC_ALL',
  // Shared read-only skill dir; injected explicitly in baseEnv, allowlisted here
  // so it survives scrubEnv if ever set on the orchestrator process.
  'DSH_BUNDLED_SKILL_DIR',
  // 实例内权限档位（dsh-base 读 DSH_PERMISSION_MODE 决定 sandbox mode + approval policy）。
  // 只做 allowlist，实际值由 orchestrator.baseEnv 注入。
  'DSH_PERMISSION_MODE',
  // 冻结实例的基础运行时版本（Python / pip / node 一律用平台装的那份，禁止版本漂移）。
  // 这两条是**限制性** env（语义为收窄，不是扩大）：
  //   · PYTHONNOUSERSITE=1 —— 不把 `$HOME/.local/lib/python*/site-packages` 加进 sys.path
  //     （实测：一旦该目录被 pip 创建，它就在 sys.path 里且**优先于平台 site-packages** →
  //      用户装的同名包会盖住平台包，正是"版本差异导致插件功能不可用"的来源）；
  //   · PYTHONUSERBASE=<只读占位位> —— 让 `pip install --user` **明确失败**而不是静默无效。
  'PYTHONNOUSERSITE',
  'PYTHONUSERBASE',
])

/** Drop credential-shaped and unknown env vars; keep only a safe allowlist. */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWED_ENV.has(key) && value !== undefined) out[key] = value
  }
  return out
}

/** Reserve an ephemeral loopback port, release it, and return its number. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => {
        if (port !== undefined) resolve(port)
        else reject(new Error('could not reserve a free port'))
      })
    })
  })
}
