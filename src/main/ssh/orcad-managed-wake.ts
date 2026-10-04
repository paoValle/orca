/**
 * Starting a managed orcad that is installed and activated but not running, most often one
 * that stopped itself after idling. A stopped server is just "not running": it is neither a
 * failure nor evidence about terminals, which the daemon owns and which outlive orcad.
 */
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { ServeReadiness } from '../server/serve-readiness'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { orcadActivationFenceExists, withOrcadActivationLock } from './orcad-activation-lock'
import { managedOrcadSlot } from './orcad-managed-runtime-context'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { resolveOrcadRemoteContext } from './orcad-remote-context'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotOptions
} from './orcad-recovery-slot'
import type { SshConnection } from './ssh-connection'

export type OrcadManagedWake =
  | { outcome: 'serving' | 'not-activated' | 'unverifiable' }
  /** An update, rollback or recovery holds the host; it owns which slot serves. */
  | { outcome: 'fenced' }
  | { outcome: 'started'; readiness: ServeReadiness }

const WAKE_PROBE_TIMEOUT_MS = 5_000

/** Launches the active slot only on proven exit; a live or unprovable process is left alone. */
export async function wakeStoppedManagedOrcad(
  options: OrcadSlotOptions
): Promise<OrcadManagedWake> {
  const before = await readOrcadActivationRecord(options)
  if (!before.active) {
    return { outcome: 'not-activated' }
  }
  const liveness = await slotLiveness(options, before.active)
  if (liveness !== 'DEAD') {
    return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
  }
  if (await orcadActivationFenceExists(options)) {
    return { outcome: 'fenced' }
  }
  return withOrcadActivationLock(options, async () => {
    // Re-read under the fence: another client may have activated or started a slot meanwhile.
    const active = (await readOrcadActivationRecord(options)).active
    if (!active) {
      return { outcome: 'not-activated' }
    }
    const identity = await resolveOrcadSlotIdentity(options, active)
    return { outcome: 'started', readiness: await ensureOrcadSlotServing(options, identity) }
  })
}

async function slotLiveness(
  options: OrcadSlotOptions,
  version: string
): Promise<'LIVE' | 'DEAD' | 'UNKNOWN'> {
  return parseOrcadLiveness(
    await execOrcadRemote(
      options,
      orcadLivenessProbeCommand(options.host, orcadSlotDir(options, version))
    )
  )
}

/**
 * Called once a fresh tunnel is up. A server that answers costs one round trip; only one that
 * does not is checked and, if proven stopped, started. Never throws: the connect still succeeds
 * and the server's status reports whatever this could not fix.
 */
export async function ensureManagedOrcadServing(input: {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: SshConnection
  remotePort: number
  probe: (environment: KnownRuntimeEnvironment, timeoutMs: number) => Promise<boolean>
}): Promise<void> {
  if (await input.probe(input.environment, WAKE_PROBE_TIMEOUT_MS)) {
    return
  }
  try {
    const context = await resolveOrcadRemoteContext(input.target, input.connection)
    const wake = await wakeStoppedManagedOrcad(managedOrcadSlot(context, input.remotePort))
    if (wake.outcome === 'started') {
      const idle = wake.readiness.health?.previousIdleStop
      const cause = idle
        ? `it had stopped after idling at ${idle.stoppedAt}`
        : 'it had stopped without an idle-stop record (crash, signal or host restart)'
      console.info(`[ssh] Started the managed Orca server on ${input.target.label}; ${cause}.`)
    } else {
      console.warn(
        `[ssh] The managed Orca server on ${input.target.label} is not answering (${wake.outcome}); it was not started.`
      )
    }
  } catch (error) {
    console.warn(`[ssh] Could not start the managed Orca server on ${input.target.label}:`, error)
  }
}
