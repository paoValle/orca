/**
 * The connect path's terminal verdict for a host that may convert to a managed server. This
 * desktop's leases answer first; when they claim nothing and no relay session can be asked, the
 * host's own relay endpoints decide, so terminals another desktop opened there still block.
 */
import type { Store } from '../persistence'
import type { HostServerTerminalVerdict } from './ssh-host-server-on-connect'
import {
  censusHostRelayEndpoints,
  type HostRelayEndpointCensus
} from './ssh-host-relay-endpoint-census'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { readRemoteHomeCommand } from './ssh-remote-commands'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'
import { isWindowsRemoteHost, normalizeRemoteHome, validateRemoteHome } from './ssh-remote-platform'
import {
  assessOrcadMigrationTerminals,
  type ListRelayPtyIds
} from './orcad-migration-terminal-gate'

export async function relayTerminalsOnConnect(args: {
  store: Pick<Store, 'getSshRemotePtyLeases'>
  targetId: string
  /** Null when no relay session is connected, as on a connect that has not registered one yet. */
  listRelayPtyIds: ListRelayPtyIds | null
  censusHost: () => Promise<HostRelayEndpointCensus>
}): Promise<HostServerTerminalVerdict> {
  const proof = await assessOrcadMigrationTerminals(args.store, args.targetId, args.listRelayPtyIds)
  if (proof.verdict !== 'exited') {
    return { verdict: proof.verdict, count: proof.ptyIds.length }
  }
  if (args.listRelayPtyIds) {
    return { verdict: 'exited', count: 0 }
  }
  let census: HostRelayEndpointCensus
  try {
    census = await args.censusHost()
  } catch {
    return { verdict: 'unverifiable', count: 0 }
  }
  // Windows pipes cannot be listed (`unenumerable`); those hosts keep deciding from the leases.
  return census.verdict === 'live' || census.verdict === 'unverifiable'
    ? { verdict: census.verdict, count: census.count }
    : { verdict: 'exited', count: 0 }
}

/** The census over the connect's bootstrap connection, before any relay session exists. */
export async function censusSshHostRelaysBeforeSession(
  conn: SshConnection,
  signal?: AbortSignal
): Promise<HostRelayEndpointCensus> {
  const host = await detectRemoteHostPlatform(conn, { signal })
  if (!host) {
    return { verdict: 'unverifiable', count: 0 }
  }
  if (isWindowsRemoteHost(host)) {
    return { verdict: 'unenumerable', count: 0 }
  }
  const remoteHome = normalizeRemoteHome(
    await execCommand(conn, readRemoteHomeCommand(host), { signal }),
    host
  )
  if (!validateRemoteHome(remoteHome, host)) {
    return { verdict: 'unverifiable', count: 0 }
  }
  return censusHostRelayEndpoints(conn, {
    host,
    remoteHome,
    nodePath: () => resolveRemoteNodePath(conn, host, { signal }),
    signal
  })
}
