/**
 * The per-user filesystem seam (manual/architecture.md).
 *
 * The control plane owns the users volume and touches it in-process
 * ({@link LocalUserFs}); routes depend only on this interface.
 *
 * All paths crossing this interface are **workspace-relative**; the
 * implementation resolves them against its own root via `resolveWithinRoot`.
 * @module dsh-users-platform/fs/user-fs
 */

import type { PluginInfo } from './plugins.js'
import type { FsEntry } from './workspace.js'

/** Wire-level failure codes. These are the exact `{error}` values the desktop
 * UI already switches on. */
export type UserFsErrorCode =
  | 'bad_path'
  | 'bad_name'
  | 'not_found'
  | 'exists'
  | 'parent_missing'
  | 'not_a_folder'
  // 下载/查看文件
  | 'not_a_file'
  | 'too_large'
  | 'unsupported'

/** HTTP status each code maps to (unchanged from the pre-seam routes). */
const STATUS: Record<UserFsErrorCode, number> = {
  bad_path: 400,
  bad_name: 400,
  not_found: 404,
  exists: 409,
  parent_missing: 404,
  not_a_folder: 400,
  not_a_file: 400,
  too_large: 413,
  unsupported: 501,
}

/**
 * A filesystem failure already reduced to its wire form. Routes rethrow it as
 * `reply.code(err.status).send({ error: err.code })` without inspecting errno,
 * which is what lets a thin implementation rebuild it from a wire response.
 */
export class UserFsError extends Error {
  readonly status: number

  constructor(readonly code: UserFsErrorCode) {
    super(code)
    this.name = 'UserFsError'
    this.status = STATUS[code]
  }
}

/** True when `code` is one this seam knows how to represent. */
export function isUserFsErrorCode(code: string): code is UserFsErrorCode {
  return code in STATUS
}

/** Per-user filesystem operations, as the route layer needs them. */
export interface UserFs {
  /** Create the user's home/workspace roots (`0700`). Idempotent.
   * `uid` (when provided) makes local mode chown the roots to the user's Linux
   * uid — the DSH child runs as that uid and would otherwise hit EACCES writing
   * `home/` (directories are created by the root control plane). */
  initUserRoot(userId: string, uid?: number): Promise<void>
  /** Absolute path of `relPath` **as the user's DSH process sees it** (pure path
   * math — the path as the user's own DSH process sees it). */
  resolvePath(userId: string, relPath: string): string
  listDir(userId: string, relPath: string): Promise<FsEntry[]>
  mkdir(userId: string, relPath: string): Promise<void>
  /** Create a file or directory under `relPath`; returns the sanitized name. */
  createEntry(userId: string, relPath: string, name: string, type: 'file' | 'dir'): Promise<string>
  /** Write `data` as `name` under `relPath`; returns the sanitized name. */
  upload(userId: string, relPath: string, name: string, data: Buffer): Promise<string>
  /** Whether `relPath` is a directory; throws `not_found` when absent. */
  isDirectory(userId: string, relPath: string): Promise<boolean>
  /** Read a workspace-relative **file** (供门户/实例页「我的文件」下载)。
   * 目录 → `not_a_file`；超过 `maxBytes` → `too_large`。
   * 注：部分实现可能抛 `unsupported`（尚无对应端点时）。 */
  readFile(userId: string, relPath: string, maxBytes?: number): Promise<{ name: string; data: Buffer }>
  listInstalledPlugins(userId: string): Promise<PluginInfo[]>
  /** Write the post-restart command handoff the watchdog reads. */
  writeHandoff(userId: string, content: string): Promise<void>
}
