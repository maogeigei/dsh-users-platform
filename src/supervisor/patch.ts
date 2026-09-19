/**
 * cordis patch rendering for a child DSH. Always mounts the runtime plugin
 * (`dsh-users-platform/runtime`) so every child injects the watchdog contract,
 * plus one row per enabled folder plugin (id doubles as package name). The real
 * harness loads this via `--patch <file>`.
 * @module dsh-users-platform/supervisor/patch
 */

/** The runtime plugin patch row, mounted in every child DSH. */
const RUNTIME_ROW = '    - id: dsh-users-platform-runtime\n      name: dsh-users-platform/runtime'

/** Render a patch YAML always enabling the runtime plugin plus `enabledPlugins`. */
export function renderPatch(enabledPlugins: readonly string[]): string {
  const rows = [RUNTIME_ROW, ...enabledPlugins.map((id) => `    - id: ${id}\n      name: ${id}`)]
  return `- insert:\n${rows.join('\n')}\n`
}
