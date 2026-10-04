/**
 * The dormant migration's terminal gate: a relay PTY cannot move into orcad, so the source must
 * prove that every terminal it ever leased on the target has exited. Loss of contact is never
 * exit: an unanswered relay, or a lease the relay cannot account for, blocks as `unverifiable`.
 */
import { isLiveSshPtyLease } from '../../shared/ssh-pty-lease-liveness'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import type { Store } from '../persistence'

export type OrcadMigrationTerminalVerdict =
  | { verdict: 'exited'; provenPtyIds: string[] }
  | { verdict: 'live' | 'unverifiable'; ptyIds: string[]; reason: string }

/**
 * The relay's own process list for the target; `null` when it did not answer. `previous` asks the
 * relays an earlier Orca build left running the same way, `null` when they cannot be asked.
 */
export type ListRelayPtyIds = (() => Promise<string[] | null>) & {
  previous?: () => Promise<string[] | null>
}

type LeaseStore = Pick<Store, 'getSshRemotePtyLeases'>

/** Taken before the fence, while the relay can still be asked. Read-only, so previews may ask. */
export async function assessOrcadMigrationTerminals(
  store: LeaseStore,
  targetId: string,
  listRelayPtyIds: ListRelayPtyIds | null
): Promise<OrcadMigrationTerminalVerdict> {
  const leases = store.getSshRemotePtyLeases(targetId)
  const attached = leases.filter((lease) => lease.state === 'attached')
  if (attached.length > 0) {
    return refuse('live', attached, 'terminals on this host are still running')
  }
  const relayPtyIds = await ask(listRelayPtyIds)
  if (relayPtyIds && relayPtyIds.length > 0) {
    return {
      verdict: 'live',
      ptyIds: [...relayPtyIds],
      reason: 'the SSH relay still runs terminals on this host'
    }
  }
  // A detached or expired lease may run on this relay or one an earlier build left; both answer.
  const unresolved = leases.filter(
    (lease) => lease.state === 'detached' || lease.state === 'expired'
  )
  if (unresolved.length === 0) {
    return { verdict: 'exited', provenPtyIds: leases.map((lease) => lease.ptyId) }
  }
  if (relayPtyIds === null) {
    return refuse(
      'unverifiable',
      unresolved,
      'the SSH relay could not confirm these terminals exited'
    )
  }
  const previousPtyIds = await ask(listRelayPtyIds?.previous)
  if (previousPtyIds === null) {
    return refuse('unverifiable', unresolved, 'Orca could not confirm its terminals here exited')
  }
  const held = new Set(previousPtyIds)
  const running = unresolved.filter((lease) => held.has(lease.ptyId))
  if (running.length > 0) {
    return refuse('live', running, 'an earlier Orca relay still runs terminals on this host')
  }
  return { verdict: 'exited', provenPtyIds: leases.map((lease) => lease.ptyId) }
}

/**
 * A move acting on an exited proof marks the detached leases it covers terminated, so the checks
 * after it (the fenced re-check, preflight's lease blocker) stop reading them as running.
 */
export function retireProvenDetachedLeases(
  store: Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease'>,
  targetId: string,
  proof: OrcadMigrationTerminalVerdict
): void {
  if (proof.verdict !== 'exited') {
    return
  }
  const proven = new Set(proof.provenPtyIds)
  for (const lease of store.getSshRemotePtyLeases(targetId)) {
    if (lease.state === 'detached' && proven.has(lease.ptyId)) {
      store.markSshRemotePtyLease(targetId, lease.ptyId, 'terminated')
    }
  }
}

async function ask(list: (() => Promise<string[] | null>) | null | undefined) {
  try {
    return list ? await list() : null
  } catch {
    return null
  }
}

/**
 * Re-checked under the fence, after the relay was let go: the fence stops new leases, so any
 * lease the earlier proof did not cover means a terminal started in between.
 */
export function confirmOrcadMigrationTerminalsUnderFence(
  store: LeaseStore,
  targetId: string,
  proof: OrcadMigrationTerminalVerdict
): OrcadMigrationTerminalVerdict {
  if (proof.verdict !== 'exited') {
    return proof
  }
  const proven = new Set(proof.provenPtyIds)
  const leases = store.getSshRemotePtyLeases(targetId)
  const live = leases.filter(isLiveSshPtyLease)
  if (live.length > 0) {
    return refuse('live', live, 'a terminal started on this host before the fence took hold')
  }
  const unproven = leases.filter((lease) => !proven.has(lease.ptyId))
  if (unproven.some((lease) => lease.state !== 'terminated')) {
    return refuse(
      'unverifiable',
      unproven,
      'a terminal lease appeared on this host that the relay was not asked about'
    )
  }
  return proof
}

function refuse(
  verdict: 'live' | 'unverifiable',
  leases: SshRemotePtyLease[],
  reason: string
): OrcadMigrationTerminalVerdict {
  return { verdict, ptyIds: leases.map((lease) => lease.ptyId), reason }
}
