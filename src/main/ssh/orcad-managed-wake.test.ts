import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'
import type * as InstallLock from './ssh-relay-install-lock'

vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: vi.fn()
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn()
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'
import { FakeOrcadHost, OLD } from './orcad-activation-host-test-harness'
import {
  ORCAD_E2E_IDLE_TIMEOUT_ENV,
  ORCAD_MANAGED_ACTIVATION_ROOT_ENV
} from '../../shared/orcad-idle-exit'

let host = new FakeOrcadHost()

const slot = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the connection is never used.
  conn: {} as SshConnection,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '/usr/bin/node',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 7777,
  readinessTimeoutMs: 50,
  sleep: async () => {}
}

function launches(): string[] {
  return host.commands.filter((command) => command.includes('nohup'))
}

/** The slot's process exited on its own, as an idle stop leaves it. */
function stoppedHost(): FakeOrcadHost {
  const stopped = FakeOrcadHost.deployedOld()
  stopped.alive.clear()
  return stopped
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
  vi.mocked(acquireInstallLock).mockImplementation(async () => host.acquireFence())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('wakeStoppedManagedOrcad', () => {
  it('starts a stopped active slot as a managed launch and releases the fence', async () => {
    host = stoppedHost()

    const wake = await wakeStoppedManagedOrcad(slot)

    expect(wake.outcome).toBe('started')
    expect([...host.alive]).toEqual([OLD])
    expect(host.fence).toBe(false)
    expect(launches()).toHaveLength(1)
    expect(launches()[0]).toContain(
      `${ORCAD_MANAGED_ACTIVATION_ROOT_ENV}='/home/u/.orca-remote/.orcad-activation-transaction'`
    )
    expect(launches()[0]).not.toContain(ORCAD_E2E_IDLE_TIMEOUT_ENV)
  })

  it('forwards the test-only idle timeout to the server it starts', async () => {
    vi.stubEnv(ORCAD_E2E_IDLE_TIMEOUT_ENV, '3000')
    host = stoppedHost()

    await wakeStoppedManagedOrcad(slot)

    expect(launches()[0]).toContain(`${ORCAD_E2E_IDLE_TIMEOUT_ENV}='3000'`)
  })

  it('leaves a running server alone', async () => {
    host = FakeOrcadHost.deployedOld()

    expect(await wakeStoppedManagedOrcad(slot)).toEqual({ outcome: 'serving' })
    expect(launches()).toEqual([])
    expect(acquireInstallLock).not.toHaveBeenCalled()
  })

  it('never starts a second process when the slot state is unprovable', async () => {
    host = stoppedHost()
    host.pidFiles.clear()

    expect(await wakeStoppedManagedOrcad(slot)).toEqual({ outcome: 'unverifiable' })
    expect(launches()).toEqual([])
  })

  it('defers to an update or recovery that holds the activation fence', async () => {
    host = stoppedHost()
    host.fence = true

    expect(await wakeStoppedManagedOrcad(slot)).toEqual({ outcome: 'fenced' })
    expect(launches()).toEqual([])
    expect(host.fence).toBe(true)
  })

  it('has nothing to start on a host with no activated server', async () => {
    host = new FakeOrcadHost()

    expect(await wakeStoppedManagedOrcad(slot)).toEqual({ outcome: 'not-activated' })
    expect(launches()).toEqual([])
  })
})
