/**
 * Making sure a managed orcad is serving before a client relies on it: a server that answers
 * costs one round trip; one that does not is checked on the host and, only if proven stopped
 * (an idle stop, a kill, a host reboot), started from its activated slot. A daemon that survived
 * is adopted by the new orcad with its terminals; after a reboot both start fresh.
 *
 * Never throws. A server that cannot be started stays `unverifiable` with the reason, and is
 * never read as evidence that its terminals exited.
 */
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import { orcadBoundPort } from './orcad-managed-bound-port'
import { managedOrcadSlot } from './orcad-managed-runtime-context'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { resolveOrcadRemoteContext } from './orcad-remote-context'
import type { SshConnection } from './ssh-connection'

export type OrcadManagedServing =
  | { state: 'serving' }
  /** `boundPort` is the port the restarted server bound, which a forward must follow. */
  | { state: 'started'; boundPort: number | null }
  | { state: 'unverifiable'; detail: string }

export type OrcadManagedServingInput = {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: SshConnection
  remotePort: number
  probe: (environment: KnownRuntimeEnvironment, timeoutMs: number) => Promise<boolean>
}

const PROBE_TIMEOUT_MS = 5_000
// Why: a connect checks right after its fresh tunnel did; one verdict serves both, on that
// transport and port only, so a kill, reboot or rebind is never answered from cache.
const VERDICT_REUSE_MS = 5_000

const inFlight = new Map<string, Promise<OrcadManagedServing>>()
type RecentVerdict = {
  at: number
  connection: SshConnection
  generation: number
  remotePort: number
  serving: OrcadManagedServing
}
const recent = new Map<string, RecentVerdict>()
export type ManagedOrcadStartListener = {
  /** Shows "Starting managed server…" for the host. */
  starting: (target: SshTarget) => void
  /** The start finished; an `unverifiable` result carries why, with orcad.log's tail. */
  settled: (target: SshTarget, environmentId: string, serving: OrcadManagedServing) => void
}

let startListener: ManagedOrcadStartListener | null = null

/** The SSH status wiring registers where a start is shown. */
export function setManagedOrcadStartListener(listener: ManagedOrcadStartListener | null): void {
  startListener = listener
}

export function ensureManagedOrcadServing(
  input: OrcadManagedServingInput,
  now: () => number = Date.now
): Promise<OrcadManagedServing> {
  const id = input.environment.id
  const generation = input.connection.getTransportGeneration()
  const cached = recent.get(id)
  if (
    cached &&
    cached.connection === input.connection &&
    cached.generation === generation &&
    cached.remotePort === input.remotePort &&
    now() - cached.at < VERDICT_REUSE_MS
  ) {
    return Promise.resolve(cached.serving)
  }
  const pending = inFlight.get(id)
  if (pending) {
    return pending
  }
  const operation = checkAndStart(input).then((serving) => {
    recent.set(id, {
      at: now(),
      connection: input.connection,
      generation,
      remotePort: input.remotePort,
      serving
    })
    return serving
  })
  const settled = operation.finally(() => inFlight.delete(id))
  inFlight.set(id, settled)
  return settled
}

/** Test-only: forget cached verdicts. */
export function resetManagedOrcadServingForTests(): void {
  inFlight.clear()
  recent.clear()
}

async function checkAndStart(input: OrcadManagedServingInput): Promise<OrcadManagedServing> {
  if (await input.probe(input.environment, PROBE_TIMEOUT_MS)) {
    return { state: 'serving' }
  }
  let starting = false
  const serving = await wakeIfStopped(input, () => {
    starting = true
    startListener?.starting(input.target)
  })
  if (starting) {
    startListener?.settled(input.target, input.environment.id, serving)
  }
  return serving
}

async function wakeIfStopped(
  input: OrcadManagedServingInput,
  onStarting: () => void
): Promise<OrcadManagedServing> {
  const label = input.target.label
  try {
    const context = await resolveOrcadRemoteContext(input.target, input.connection)
    const wake = await wakeStoppedManagedOrcad(
      managedOrcadSlot(context, input.remotePort),
      onStarting
    )
    if (wake.outcome === 'started') {
      const idle = wake.readiness.health?.previousIdleStop
      const cause = idle
        ? `it had stopped after idling at ${idle.stoppedAt}`
        : 'it had stopped without an idle-stop record (crash, signal or host restart)'
      console.info(`[ssh] Started the managed Orca server on ${label}; ${cause}.`)
      return { state: 'started', boundPort: orcadBoundPort(wake.readiness) }
    }
    // A live process that did not answer may still be starting; it is not restarted.
    if (wake.outcome === 'serving') {
      return { state: 'serving' }
    }
    const detail = wakeRefusal(wake.outcome)
    console.warn(`[ssh] The managed Orca server on ${label} is not answering: ${detail}`)
    return { state: 'unverifiable', detail }
  } catch (error) {
    console.warn(`[ssh] Could not start the managed Orca server on ${label}:`, error)
    return { state: 'unverifiable', detail: error instanceof Error ? error.message : String(error) }
  }
}

function wakeRefusal(outcome: 'not-activated' | 'unverifiable' | 'fenced'): string {
  switch (outcome) {
    case 'fenced':
      return 'An update, rollback or recovery holds this host; it was not started.'
    case 'not-activated':
      return 'This host has no activated managed server to start.'
    case 'unverifiable':
      return 'Whether the server process is still running could not be proven, so it was not started.'
  }
}
