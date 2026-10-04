import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./orcad-remote-context', () => ({
  resolveOrcadRemoteContext: vi.fn(async () => ({
    connection: {},
    host: {},
    remoteHome: '/home/u',
    userDataDir: '/home/u/.orca'
  }))
}))
vi.mock('./orcad-managed-wake', () => ({ wakeStoppedManagedOrcad: vi.fn() }))

import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import {
  ensureManagedOrcadServing,
  resetManagedOrcadServingForTests,
  setManagedOrcadStartListener,
  type OrcadManagedServingInput
} from './orcad-managed-serving'

const listener = { starting: vi.fn(), settled: vi.fn() }

function input(probe: () => Promise<boolean>): OrcadManagedServingInput {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the id is read.
    environment: { id: 'env-1' } as never,
    target: { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the remote context is mocked.
    connection: {} as never,
    remotePort: 6768,
    probe: vi.fn(probe)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetManagedOrcadServingForTests()
  setManagedOrcadStartListener(listener)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('ensureManagedOrcadServing', () => {
  it('costs one round trip when the server answers', async () => {
    expect(await ensureManagedOrcadServing(input(async () => true))).toEqual({ state: 'serving' })
    expect(wakeStoppedManagedOrcad).not.toHaveBeenCalled()
    expect(listener.starting).not.toHaveBeenCalled()
  })

  it('starts a stopped server from its slot and shows the start on the status line', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting) => {
      onStarting?.()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only health is read.
      return { outcome: 'started', readiness: { health: { previousIdleStop: null } } as never }
    })

    expect(await ensureManagedOrcadServing(input(async () => false))).toEqual({ state: 'started' })
    expect(vi.mocked(wakeStoppedManagedOrcad).mock.calls[0]?.[0]).toMatchObject({ port: 6768 })
    expect(listener.starting).toHaveBeenCalledOnce()
    expect(listener.settled).toHaveBeenCalledWith(expect.anything(), 'env-1', { state: 'started' })
  })

  it('stays unverifiable with the reason when the start fails, never a terminal verdict', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting) => {
      onStarting?.()
      throw new Error('orcad did not become ready.\nLast lines of orcad.log:\nboom')
    })

    const serving = await ensureManagedOrcadServing(input(async () => false))
    expect(serving).toEqual({
      state: 'unverifiable',
      detail: 'orcad did not become ready.\nLast lines of orcad.log:\nboom'
    })
    expect(listener.settled).toHaveBeenCalledWith(expect.anything(), 'env-1', serving)
  })

  it('leaves a live process that did not answer alone', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockResolvedValue({ outcome: 'serving' })
    expect(await ensureManagedOrcadServing(input(async () => false))).toEqual({ state: 'serving' })
    expect(listener.starting).not.toHaveBeenCalled()
  })

  it.each(['fenced', 'unverifiable', 'not-activated'] as const)(
    'does not start a server whose host says %s',
    async (outcome) => {
      vi.mocked(wakeStoppedManagedOrcad).mockResolvedValue({ outcome })
      const serving = await ensureManagedOrcadServing(input(async () => false))
      expect(serving.state).toBe('unverifiable')
      expect(listener.starting).not.toHaveBeenCalled()
    }
  )

  it('shares one check between a fresh tunnel and the connect right after it', async () => {
    let now = 0
    const probe = vi.fn(async () => true)
    const first = input(probe)
    await Promise.all([
      ensureManagedOrcadServing(first, () => now),
      ensureManagedOrcadServing(first, () => now)
    ])
    now = 10_000
    await ensureManagedOrcadServing(first, () => now)
    expect(probe).toHaveBeenCalledOnce()
    now = 30_000
    await ensureManagedOrcadServing(first, () => now)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
