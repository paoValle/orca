/** The connect path's managed-server step: decide the host's server, and publish a managed connect. */
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  SshConnectionState,
  SshManagedServerServingNote,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from '../ssh/ssh-host-server-on-connect'
import { relayServerStatus, shouldToastManagedServerMove } from '../ssh/ssh-host-server-move-offer'
import { setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { trackSshHostServerMove } from '../ssh/ssh-host-server-telemetry'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState, getPublicSshState } from './ssh-renderer-broadcast'

/** Resolves null when the decision itself couldn't run; the caller then keeps today's relay path. */
export async function decideHostServer(
  target: SshTarget
): Promise<HostServerOnConnectResult | null> {
  try {
    // Why lazy: the managed-server graph (deploy, migration, tunnel) loads only when a host connects.
    const [{ resolveHostServerOnConnect }, { hostServerOnConnectDeps }] = await Promise.all([
      import('../ssh/ssh-host-server-on-connect'),
      import('./ssh-host-server-on-connect-wiring')
    ])
    return await resolveHostServerOnConnect(
      target,
      hostServerOnConnectDeps(getAppEnvironment().getPath('userData'))
    )
  } catch (error) {
    // A fenced host still refuses the relay below; any other host keeps today's relay path.
    console.warn('[ssh] Could not decide the managed Orca server for this host:', error)
    return null
  }
}

export function publishManagedServerConnect(
  targetId: string,
  environmentId: string,
  update?: SshManagedServerUpdateNote,
  serving?: SshManagedServerServingNote
): SshConnectionState {
  const managedServer = {
    kind: 'managed' as const,
    environmentId,
    ...(update ? { update } : {}),
    ...(serving ? { serving } : {})
  }
  setSshHostServerStatus(targetId, managedServer)
  const state: SshConnectionState = {
    ...(connectionManager!.getState(targetId) ?? { targetId, reconnectAttempt: 0 }),
    targetId,
    status: 'connected',
    error: null,
    managedServer
  }
  broadcastSshState(getCurrentMainWindow, targetId, state)
  return getPublicSshState(targetId) ?? state
}

/** Records why the host keeps the relay; the first live-terminals stop this version offers a move. */
export function recordRelayDecision(
  target: SshTarget,
  decision: Extract<HostServerOnConnectResult, { route: 'relay' }>
): void {
  const appVersion = getAppEnvironment().getVersion()
  const offerMove = shouldToastManagedServerMove(target, decision, appVersion)
  if (offerMove) {
    getSshTargetRegistryStore()!.updateTarget(target.id, {
      managedServerMoveOffered: { appVersion }
    })
    trackSshHostServerMove('offered', knownSshHostPlatform(target.id))
  }
  setSshHostServerStatus(target.id, relayServerStatus(decision, offerMove))
}
