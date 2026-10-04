import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import type { RelayEndpointIncumbent } from './ssh-relay-endpoint-incumbent'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const { execCommand, probeRelayEndpointIncumbent } = vi.hoisted(() => ({
  execCommand: vi.fn(),
  probeRelayEndpointIncumbent: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand }))
vi.mock('./ssh-relay-endpoint-incumbent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeRelayEndpointIncumbent
}))

import { censusHostRelayEndpoints } from './ssh-host-relay-endpoint-census'

// The census only hands the connection to the mocked exec and probe.
const conn: SshConnection = Object.create(null)
const linux = getRemoteHostPlatform('linux-x64')
const sock = (n: number) => `/home/dev/.orca-remote/relay-1.4.${n}/relay-abc.sock`

const husk = { pid: 10, matchesRelayArgv: true, childCount: 0, unrecognizedChildCount: 0 }
const working = { ...husk, childCount: 1, unrecognizedChildCount: 1 }

function incumbent(overrides: Partial<RelayEndpointIncumbent>): RelayEndpointIncumbent {
  return {
    sockPath: sock(1),
    verdict: 'live',
    evidence: 'accepted-connection',
    socketPresent: true,
    holders: [working],
    holdersEnumerable: true,
    ...overrides
  }
}

const census = (nodePath: () => Promise<string | null> = async () => '/usr/bin/node') =>
  censusHostRelayEndpoints(conn, { host: linux, remoteHome: '/home/dev', nodePath })

describe('the host-side relay endpoint census', () => {
  beforeEach(() => {
    execCommand.mockReset()
    probeRelayEndpointIncumbent.mockReset()
  })

  it('finds none when no relay endpoint exists, without resolving node', async () => {
    execCommand.mockResolvedValue('')
    const nodePath = vi.fn(async () => '/usr/bin/node')

    await expect(census(nodePath)).resolves.toEqual({ verdict: 'none', count: 0 })
    expect(nodePath).not.toHaveBeenCalled()
  })

  it('reads endpoints that hold no live work as idle', async () => {
    execCommand.mockResolvedValue(`${sock(1)}\n${sock(2)}\n`)
    probeRelayEndpointIncumbent
      .mockResolvedValueOnce(incumbent({ verdict: 'exited', socketPresent: true, holders: [] }))
      // A live relay holding no shell of its own is a husk.
      .mockResolvedValueOnce(incumbent({ holders: [husk] }))

    await expect(census()).resolves.toMatchObject({ verdict: 'idle' })
  })

  it('reports live work any endpoint still runs, including another desktop\u2019s', async () => {
    execCommand.mockResolvedValue(
      `${sock(1)}\n/home/dev/.orca-remote/relay-1.4.1/relay-other.sock\n`
    )
    probeRelayEndpointIncumbent
      .mockResolvedValueOnce(incumbent({ verdict: 'exited', holders: [] }))
      .mockResolvedValueOnce(incumbent({ holders: [working] }))

    await expect(census()).resolves.toEqual({ verdict: 'live', count: 1 })
  })

  it.each([
    ['the listing failed', () => execCommand.mockRejectedValue(new Error('channel closed'))],
    [
      'an endpoint could not be classified',
      () => {
        execCommand.mockResolvedValue(`${sock(1)}\n`)
        probeRelayEndpointIncumbent.mockResolvedValue(incumbent({ verdict: 'unverifiable' }))
      }
    ],
    [
      'a probe threw',
      () => {
        execCommand.mockResolvedValue(`${sock(1)}\n`)
        probeRelayEndpointIncumbent.mockRejectedValue(new Error('timeout'))
      }
    ],
    [
      'there were more endpoints than it probes',
      () => execCommand.mockResolvedValue(Array.from({ length: 33 }, (_, i) => sock(i)).join('\n'))
    ]
  ])('is unverifiable when %s', async (_label, arrange) => {
    arrange()
    await expect(census()).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  it('is unverifiable when endpoints exist but the host has no node to probe them', async () => {
    execCommand.mockResolvedValue(`${sock(1)}\n`)
    await expect(census(async () => null)).resolves.toEqual({ verdict: 'unverifiable', count: 1 })
  })

  it('cannot enumerate Windows named pipes', async () => {
    await expect(
      censusHostRelayEndpoints(conn, {
        host: getRemoteHostPlatform('win32-x64'),
        remoteHome: 'C:\\Users\\dev',
        nodePath: async () => 'node.exe'
      })
    ).resolves.toEqual({ verdict: 'unenumerable', count: 0 })
    expect(execCommand).not.toHaveBeenCalled()
  })
})
