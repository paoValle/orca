/**
 * Starting a managed orcad that is installed and activated but not running, most often one
 * that stopped itself after idling. A stopped server is just "not running": it is neither a
 * failure nor evidence about terminals, which the daemon owns and which outlive orcad.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { orcadActivationFenceExists, withOrcadActivationLock } from './orcad-activation-lock'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotOptions
} from './orcad-recovery-slot'

export type OrcadManagedWake =
  | { outcome: 'serving' | 'not-activated' | 'unverifiable' }
  /** An update, rollback or recovery holds the host; it owns which slot serves. */
  | { outcome: 'fenced' }
  | { outcome: 'started'; readiness: ServeReadiness }

/** Launches the active slot only on proven exit; a live or unprovable process is left alone. */
export async function wakeStoppedManagedOrcad(
  options: OrcadSlotOptions,
  onStarting: () => void = () => {}
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
    onStarting()
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
