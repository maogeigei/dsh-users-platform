/**
 * {@link UserFs} factory. Builds the single-machine per-user filesystem, the
 * same way {@link createDbAdapter} picks a DB backend and `buildServer` builds
 * a {@link Spawner}.
 * @module dsh-users-platform/fs/provider
 */

import type { ServerConfig } from '../config.js'
import { LocalUserFs } from './local-user-fs.js'
import { RemoteUserFs } from './remote-user-fs.js'
import type { UserFs } from './user-fs.js'
import { userRoot } from './workspace.js'

/** cluster 模式下的按用户路由（由 `server.ts` 注入；见 RemoteUserFsOptions 的说明）。 */
export interface ClusterFsRouting {
  hostIdFor?: (userId: string) => Promise<string | undefined>
  agentFor?: (hostId: string) => { agentUrl: string; token: string } | undefined
}

/**
 * Build the configured per-user filesystem.
 * - `local`   ：控制面**在本进程内**直接碰用户卷（单机形态）。
 * - `cluster` ：用户卷在 **worker** 上 ⇒ 走 agent 的 `/fs/*`（T08 S5）——
 *   远端实现复用同一份路径安全逻辑，`resolvePath` 按 **worker 的 dataRoot** 做路径数学。
 */
export function createUserFs(config: ServerConfig, routing: ClusterFsRouting = {}): UserFs {
  if (config.deployMode === 'cluster') {
    return new RemoteUserFs({
      agentUrl: config.clusterAgentUrl,
      token: config.clusterAgentToken,
      workerDataRoot: config.clusterWorkerDataRoot === '' ? config.dataRoot : config.clusterWorkerDataRoot,
      hostIdFor: routing.hostIdFor,
      agentFor: routing.agentFor,
    })
  }
  return new LocalUserFs((userId) => userRoot(config.dataRoot, userId))
}
