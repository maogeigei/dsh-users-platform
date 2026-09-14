/**
 * {@link UserFs} factory. Builds the single-machine per-user filesystem, the
 * same way {@link createDbAdapter} picks a DB backend and `buildServer` builds
 * a {@link Spawner}.
 * @module dsh-users-platform/fs/provider
 */

import type { ServerConfig } from '../config.js'
import { LocalUserFs } from './local-user-fs.js'
import type { UserFs } from './user-fs.js'
import { userRoot } from './workspace.js'

/**
 * Build the configured per-user filesystem. The single-machine backend
 * touches the users volume in-process.
 */
export function createUserFs(config: ServerConfig): UserFs {
  return new LocalUserFs((userId) => userRoot(config.dataRoot, userId))
}
