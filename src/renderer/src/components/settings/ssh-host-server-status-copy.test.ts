import { describe, expect, it } from 'vitest'
import { sshHostServerStatusLine } from './ssh-host-server-status-copy'

const plain = {}

describe('SSH host server status line', () => {
  it('says nothing for a plain host before any decision', () => {
    expect(sshHostServerStatusLine(plain, undefined)).toBeNull()
  })

  it('names the managed server, setup progress and why a host stays on the relay', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'managed', environmentId: 'e' } })
    ).toMatchObject({ tone: 'muted', text: 'Runs a managed Orca server' })
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'converting' } })
        ?.text
    ).toContain('Moving this host')
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_live', terminals: 3 }
      })?.text
    ).toContain('3 open terminals')
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'refused', detail: 'An automation runs here.' }
      })
    ).toMatchObject({
      tone: 'destructive',
      text: expect.stringContaining('An automation runs here.')
    })
  })

  it('shows a stopped server starting, and why one could not be started', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'starting' } })
        ?.text
    ).toBe('Starting managed server…')
    const detail = 'orcad did not become ready.\nLast lines of orcad.log:\nboom'
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: {
          kind: 'managed',
          environmentId: 'e',
          serving: { state: 'unverifiable', detail }
        }
      })
    ).toEqual({
      tone: 'warning',
      text: 'The managed Orca server isn’t running and couldn’t be started.',
      detail
    })
  })

  it('offers the move only while live relay terminals keep the host on the relay', () => {
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_live', terminals: 3 }
      })
    ).toMatchObject({ action: 'move', text: expect.stringContaining('3 open terminals') })
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_unverifiable' }
      })
    ).not.toHaveProperty('action')
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'managed', environmentId: 'e' } })
    ).not.toHaveProperty('action')
  })

  it('offers the setup failure, log tail included, beside a retry line', () => {
    const detail = 'No readiness line.\nLast lines of orcad.log:\nError: EADDRINUSE'
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'deferred', detail }
      })
    ).toMatchObject({ tone: 'muted', detail })
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'relay', reason: 'failed' } })
    ).not.toHaveProperty('detail')
  })

  it('shows a managed server being updated, and why it kept its version', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'updating' } })
        ?.text
    ).toBe('Updating managed server…')
    const managed = (update: { state: 'host-newer' | 'deferred' | 'failed'; detail?: string }) =>
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'managed', environmentId: 'e', update }
      })
    expect(managed({ state: 'host-newer' })?.text).toContain('from a newer Orca')
    expect(managed({ state: 'deferred', detail: '2 terminals are running.' })).toMatchObject({
      tone: 'muted',
      text: expect.stringContaining('2 terminals are running.')
    })
    expect(managed({ state: 'failed', detail: 'readiness timed out' })).toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('readiness timed out')
    })
  })

  it('keeps durable reasons visible without a live state', () => {
    expect(sshHostServerStatusLine({ orcadFence: { environmentId: 'e' } }, undefined)?.text).toBe(
      'Runs a managed Orca server'
    )
    expect(
      sshHostServerStatusLine(
        { orcadFence: { environmentId: 'e', sourceChangedAt: '2026-10-05T00:00:00Z' } },
        { managedServer: { kind: 'managed', environmentId: 'e' } }
      )
    ).toMatchObject({ tone: 'warning' })
    expect(
      sshHostServerStatusLine(
        { managedServerUnavailable: { reason: 'native_preflight', appVersion: '1.5.0' } },
        undefined
      )?.text
    ).toContain('native_preflight')
  })

  it('says plainly when neither port forwarding nor the SSH session reaches a managed server', () => {
    const live = sshHostServerStatusLine(plain, {
      managedServer: {
        kind: 'relay',
        reason: 'orcad_unavailable',
        detail: 'ssh_tunnel_unavailable'
      }
    })
    const recorded = sshHostServerStatusLine(
      { managedServerUnavailable: { reason: 'ssh_tunnel_unavailable', appVersion: '1.5.0' } },
      undefined
    )
    for (const line of [live, recorded]) {
      expect(line).toMatchObject({
        tone: 'warning',
        text: expect.stringContaining('doesn’t allow port forwarding')
      })
    }
  })

  it('reads an older build’s forwarding refusal as a host that moves on a later connect', () => {
    expect(
      sshHostServerStatusLine(
        { managedServerUnavailable: { reason: 'tcp_forwarding_refused', appVersion: '1.4.0' } },
        undefined
      )
    ).toMatchObject({ tone: 'muted', text: expect.stringContaining('later connect') })
  })
})
