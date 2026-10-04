/** Binds managed idle exit to this orcad's RPC server, PTY provider and terminal daemon. */
import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import type { OrcadIdleExitEvidence } from './orcad-idle-exit-monitor'
import {
  activationFenceExists,
  installOrcadManagedIdleExit,
  type OrcadManagedIdleExitConfig
} from './orcad-managed-idle-exit'
import { writeOrcadIdleStopRecord } from './orcad-idle-stop-record'

export type OrcadManagedIdleExitInstaller = (
  requestShutdown: (reason: string) => void
) => () => void

export async function prepareOrcadManagedIdleExit(input: {
  config: OrcadManagedIdleExitConfig
  userDataPath: string
  version: string
  rpc: { readClientActivity(): RuntimeRpcClientActivity }
  agentStates: () => readonly { state: string }[]
  hasStagedMigration: () => boolean
  /** Shutdown stops the monitor first, so a signal stop is never recorded as an idle one. */
  registerCleanup: (cleanup: () => void) => void
}): Promise<OrcadManagedIdleExitInstaller> {
  const { getLocalPtyProvider } = await import('../ipc/pty')
  const { getDaemonEndpointFacts } = await import('../daemon/daemon-init')
  const { countLiveOrcadDaemonSessions, retireOrcadDaemonIfIdle } =
    await import('./orcad-daemon-retirement')
  let dispose = (): void => {}
  input.registerCleanup(() => dispose())
  return (requestShutdown) => {
    dispose = installOrcadManagedIdleExit({
      config: input.config,
      ports: {
        readClientActivity: () => input.rpc.readClientActivity(),
        listTerminals: () => getLocalPtyProvider().listProcesses(),
        countDaemonSessions: countLiveOrcadDaemonSessions,
        hasDaemon: () => getDaemonEndpointFacts() !== null,
        agentStates: input.agentStates,
        hasStagedMigration: input.hasStagedMigration,
        activationFenceExists
      },
      stop: (evidence) => {
        void stopForIdle(input, evidence, retireOrcadDaemonIfIdle).finally(() =>
          requestShutdown('idle')
        )
      }
    })
    return dispose
  }
}

async function stopForIdle(
  input: { userDataPath: string; version: string },
  evidence: OrcadIdleExitEvidence,
  retireDaemon: () => Promise<{ retirement: string; reason: string | null }>
): Promise<void> {
  console.error(`[orcad] stopping: no client, terminal or job for ${evidence.timeoutMs}ms`)
  try {
    writeOrcadIdleStopRecord(input.userDataPath, evidence, input.version)
  } catch (error) {
    console.error('[orcad] could not record the idle stop:', error)
  }
  // The daemon leaves only if it proves itself empty; a busy one stays up with its terminals.
  const outcome = await retireDaemon().catch((error: unknown) => ({
    retirement: 'unverifiable',
    reason: String(error)
  }))
  console.error(
    `[orcad] terminal daemon on idle stop: ${outcome.retirement}${outcome.reason ? ` (${outcome.reason})` : ''}`
  )
}
