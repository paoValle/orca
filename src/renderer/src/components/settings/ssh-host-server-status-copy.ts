/** User-facing words for which server an SSH host runs; every string goes through the catalog. */
import type {
  SSH_MANAGED_SERVER_PHASES,
  SshConnectionState,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

export type SshHostServerStatusLine = {
  text: string
  tone: 'muted' | 'warning' | 'destructive'
  /** Offers "Move to managed server", which restarts the live relay terminals. */
  action?: 'move'
  /** Why setup stopped, with the host's orcad.log tail when there is one; shown on request. */
  detail?: string
}

export function sshHostServerStatusLine(
  target: Pick<SshTarget, 'orcadFence' | 'managedServerUnavailable'>,
  state: Pick<SshConnectionState, 'managedServer'> | undefined
): SshHostServerStatusLine | null {
  const status = state?.managedServer
  if (target.orcadFence?.sourceChangedAt) {
    return {
      tone: 'warning',
      text: translate(
        'auto.components.settings.sshHostServer.sourceChanged',
        'Changed on an older Orca: runs the relay until it is moved to its managed server again.'
      )
    }
  }
  if (status?.kind === 'managed' && status.serving) {
    return {
      tone: 'warning',
      text: translate(
        'auto.components.settings.sshHostServer.notServing',
        'The managed Orca server isn’t running and couldn’t be started.'
      ),
      detail: status.serving.detail
    }
  }
  if (status?.kind === 'managed' && status.update) {
    return managedUpdateLine(status.update)
  }
  if (status?.kind === 'managed' || (!status && target.orcadFence)) {
    return {
      tone: 'muted',
      text: translate(
        'auto.components.settings.sshHostServer.managed',
        'Runs a managed Orca server'
      )
    }
  }
  if (status?.kind === 'setting-up') {
    return { tone: 'muted', text: settingUpLabel(status.phase) }
  }
  if (status?.kind === 'relay') {
    return relayLine(status)
  }
  if (target.managedServerUnavailable) {
    const { reason } = target.managedServerUnavailable
    if (reason === TUNNEL_UNAVAILABLE) {
      return tunnelUnavailableLine()
    }
    // An older build's verdict; this one reaches such hosts and retries on the next connect.
    if (reason === LEGACY_FORWARDING_REFUSED) {
      return retryLine()
    }
    return {
      tone: 'muted',
      text: translate(
        'auto.components.settings.sshHostServer.unavailable',
        'Runs the relay: a managed Orca server can’t run on this host ({{reason}}).',
        { reason }
      )
    }
  }
  return null
}

// Mirror main's ORCAD_TUNNEL_UNAVAILABLE_REASON and LEGACY_TCP_FORWARDING_REFUSED_REASON.
const TUNNEL_UNAVAILABLE = 'ssh_tunnel_unavailable'
const LEGACY_FORWARDING_REFUSED = 'tcp_forwarding_refused'

function tunnelUnavailableLine(): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.tunnelUnavailable',
      'Runs the relay: this host’s SSH server doesn’t allow port forwarding, and Orca couldn’t reach a managed server through the SSH session either.'
    )
  }
}

function retryLine(): SshHostServerStatusLine {
  return {
    tone: 'muted',
    text: translate(
      'auto.components.settings.sshHostServer.retry',
      'Runs the relay this session; it moves to a managed server on a later connect.'
    )
  }
}

function managedUpdateLine(update: SshManagedServerUpdateNote): SshHostServerStatusLine {
  switch (update.state) {
    case 'host-newer':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.hostNewer',
          'Runs a managed Orca server from a newer Orca; it keeps that version.'
        )
      }
    case 'deferred':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.updateDeferred',
          'Runs a managed Orca server; it updates on a later connect: {{reason}}',
          { reason: update.detail ?? '' }
        )
      }
    case 'failed':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.updateFailed',
          'Runs a managed Orca server on its previous version; updating it failed: {{reason}}',
          { reason: update.detail ?? '' }
        )
      }
  }
}

function settingUpLabel(phase: (typeof SSH_MANAGED_SERVER_PHASES)[number]): string {
  switch (phase) {
    case 'deploying':
      return translate(
        'auto.components.settings.sshHostServer.deploying',
        'Setting up a managed Orca server…'
      )
    case 'converting':
      return translate(
        'auto.components.settings.sshHostServer.converting',
        'Moving this host’s projects to its managed Orca server…'
      )
    case 'connecting':
      return translate(
        'auto.components.settings.sshHostServer.connecting',
        'Connecting to the managed Orca server…'
      )
    case 'updating':
      return translate(
        'auto.components.settings.sshHostServer.updating',
        'Updating managed server…'
      )
    case 'starting':
      return translate(
        'auto.components.settings.sshHostServer.starting',
        'Starting managed server…'
      )
  }
}

function relayLine(
  status: Extract<NonNullable<SshConnectionState['managedServer']>, { kind: 'relay' }>
): SshHostServerStatusLine {
  switch (status.reason) {
    case 'relay_terminals_live':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.terminalsLive',
          'Runs the relay until its {{count}} open terminals are closed, then moves to a managed server.',
          { count: status.terminals ?? 0 }
        ),
        action: 'move'
      }
    case 'relay_terminals_unverifiable':
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.terminalsUnverifiable',
          'Runs the relay: Orca couldn’t confirm its terminals are closed. It moves on a later connect.'
        )
      }
    case 'orcad_unavailable':
      if (status.detail === TUNNEL_UNAVAILABLE) {
        return tunnelUnavailableLine()
      }
      return {
        tone: 'muted',
        text: translate(
          'auto.components.settings.sshHostServer.unavailable',
          'Runs the relay: a managed Orca server can’t run on this host ({{reason}}).',
          { reason: status.detail ?? '' }
        )
      }
    case 'source_changed':
      return {
        tone: 'warning',
        text: translate(
          'auto.components.settings.sshHostServer.sourceChanged',
          'Changed on an older Orca: runs the relay until it is moved to its managed server again.'
        )
      }
    case 'refused':
      return {
        tone: 'destructive',
        text: translate(
          'auto.components.settings.sshHostServer.refused',
          'Not moved to a managed server: {{blocker}}',
          { blocker: status.detail ?? '' }
        )
      }
    case 'deferred':
    case 'failed':
      return { ...retryLine(), ...(status.detail ? { detail: status.detail } : {}) }
  }
}
