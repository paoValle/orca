/**
 * Whether any Orca relay on an SSH host still runs work, asked over the bootstrap connection
 * before a relay session exists. Local leases only cover this desktop's terminals; the host's own
 * relay endpoints also show terminals another desktop opened there.
 *
 * Loss of contact is never evidence of exit (docs/reference/ssh-execution-boundary.md): a listing
 * that failed, ran out of room, or an endpoint the probe could not classify is `unverifiable`.
 */
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from './relay-socket-path-limit'
import { execCommand } from './ssh-relay-deploy-helpers'
import { probeRelayEndpointIncumbent } from './ssh-relay-endpoint-incumbent'
import { classifySupersededRelay } from './ssh-relay-superseded-endpoints'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

/** `unenumerable`: Windows named pipes cannot be listed, so the caller keeps today's path. */
export type HostRelayEndpointVerdict = 'none' | 'idle' | 'live' | 'unverifiable' | 'unenumerable'

export type HostRelayEndpointCensus = { verdict: HostRelayEndpointVerdict; count: number }

const MAX_CENSUS_ENDPOINTS = 32

/**
 * Every relay socket under this user's relay directories, whichever target or desktop bound it:
 * the socket name hashes the target id, and another desktop's target id is not ours to know.
 */
export function hostRelayEndpointListCommand(remoteHome: string): string {
  return [
    `base=${shellEscape(`${remoteHome}/${RELAY_REMOTE_DIR}`)}`,
    `short_base="${SHORT_RELAY_SOCKET_DIR_PREFIX}$(id -u 2>/dev/null)"`,
    'for sock in "$base"/relay-*/relay*.sock "$short_base"/relay-*/relay*.sock; do',
    '  [ -S "$sock" ] && printf \'%s\\n\' "$sock"',
    'done',
    'true'
  ].join('\n')
}

export async function censusHostRelayEndpoints(
  conn: SshConnection,
  args: {
    host: RemoteHostPlatform
    remoteHome: string
    /** Resolved only when there are endpoints to probe; null when the host has no node. */
    nodePath: () => Promise<string | null>
    signal?: AbortSignal
  }
): Promise<HostRelayEndpointCensus> {
  if (isWindowsRemoteHost(args.host)) {
    return { verdict: 'unenumerable', count: 0 }
  }
  let listing: string
  try {
    listing = await execCommand(conn, hostRelayEndpointListCommand(args.remoteHome), {
      wrapCommand: true,
      signal: args.signal
    })
  } catch {
    return { verdict: 'unverifiable', count: 0 }
  }
  const endpoints = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
  if (endpoints.length === 0) {
    return { verdict: 'none', count: 0 }
  }
  const nodePath =
    endpoints.length > MAX_CENSUS_ENDPOINTS ? null : await args.nodePath().catch(() => null)
  if (!nodePath) {
    return { verdict: 'unverifiable', count: endpoints.length }
  }
  let live = 0
  let unverifiable = 0
  for (const endpoint of endpoints) {
    let outcome: ReturnType<typeof classifySupersededRelay>
    try {
      outcome = classifySupersededRelay(
        await probeRelayEndpointIncumbent(conn, args.host, nodePath, endpoint, {
          signal: args.signal
        })
      )
    } catch {
      outcome = 'unverifiable'
    }
    if (outcome === 'retained-live-work') {
      live += 1
    } else if (outcome === 'unverifiable') {
      unverifiable += 1
    }
  }
  if (live > 0) {
    return { verdict: 'live', count: live }
  }
  return unverifiable > 0
    ? { verdict: 'unverifiable', count: unverifiable }
    : { verdict: 'idle', count: 0 }
}
