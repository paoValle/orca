/**
 * A managed orcad stops itself once nothing uses it, and the next connect starts it again, on a
 * real host: deploy on connect, quit the client, the server exits and records an idle stop, then
 * a relaunched client reconnects and the server is running again with that record consumed.
 *
 * Docker only. `ORCA_E2E_ORCAD_CONVERT_TEMPLATE` names the linux-x64-glibc orcad build, and the
 * client forwards a short test-only quiet period to the server it launches.
 */
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { reconnect } from './helpers/orcad-convert-flow'
import { ORCAD_CONVERT_HOST_ENV } from './helpers/orcad-convert-host'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { ORCAD_E2E_IDLE_TIMEOUT_ENV } from '../../src/shared/orcad-idle-exit'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
// Long enough that a connected client's own traffic never lets it lapse mid-test.
const IDLE_TIMEOUT_MS = 15_000
const RECORD = '/root/.orca/orcad-idle-stop.json'

/** PIDs of running orcad slots; empty once every slot has exited. */
function runningOrcadPids(target: DockerSshRelayTarget): string[] {
  return execDockerSshRelayTargetCommand(
    target,
    'for f in /root/.orca-remote/orcad-*/.orcad-pid; do pid=$(cat "$f" 2>/dev/null) && ' +
      'kill -0 "$pid" 2>/dev/null && echo "$pid"; done; true'
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function readIdleStopRecord(target: DockerSshRelayTarget): unknown {
  const raw = execDockerSshRelayTargetCommand(target, `cat ${RECORD} 2>/dev/null || true`).trim()
  return raw ? JSON.parse(raw) : null
}

test('a managed orcad stops after idling and starts again on the next connect', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(15 * 60_000)
  const target = startDockerSshRelayTarget(testInfo)
  const session = createRestartSession(testInfo, {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE!,
    [ORCAD_E2E_IDLE_TIMEOUT_ENV]: String(IDLE_TIMEOUT_MS)
  })
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    // A managed host is reached through its server, not a relay, so no relay repo is added.
    const remote = await first.page.evaluate(
      async (input) => {
        const { target: created } = await window.api.ssh.addTarget({ target: input })
        const state = await window.api.ssh.connect({ targetId: created.id })
        return { targetId: created.id, managedServer: state?.managedServer ?? null }
      },
      {
        label: `orcad idle E2E ${Date.now()}`,
        host: target.host,
        port: target.port,
        username: 'root',
        identityFile: target.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      }
    )
    expect(remote.managedServer).toMatchObject({ kind: 'managed' })
    expect(runningOrcadPids(target)).toHaveLength(1)

    // While the client is connected the server stays up past its quiet period.
    await first.page.waitForTimeout(IDLE_TIMEOUT_MS * 2)
    expect(runningOrcadPids(target)).toHaveLength(1)

    await session.close(app)
    app = null
    await expect
      .poll(() => runningOrcadPids(target), { timeout: 3 * 60_000 })
      .toEqual([])
      .catch((error: unknown) => {
        // The server logs what kept it up; without it a timeout explains nothing.
        console.error(
          execDockerSshRelayTargetCommand(target, 'tail -n 40 /root/.orca-remote/orcad-*/orcad.log')
        )
        throw error
      })
    expect(readIdleStopRecord(target)).toMatchObject({
      kind: 'orcad_idle_stop',
      idleTimeoutMs: IDLE_TIMEOUT_MS
    })

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    const connected = await reconnect(second.page, remote.targetId)
    expect(JSON.parse(connected)).toMatchObject({ kind: 'managed' })
    expect(runningOrcadPids(target)).toHaveLength(1)
    // The restarted server read the record, so a later crash cannot be mistaken for an idle stop.
    expect(readIdleStopRecord(target)).toBeNull()
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshRelayTarget(target)
  }
})
