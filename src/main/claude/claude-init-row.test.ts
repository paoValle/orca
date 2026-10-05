import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { claudeInitRowBody } from './claude-init-row'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: 'leaf-1' }
}

/** A frame as captured from the CLI: the session handshake, carrying its MCP server roster. */
function init(mcpServers: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    tools: ['Bash', 'Read'],
    mcp_servers: mcpServers,
    model: 'claude-opus-5-5[1m]',
    permissionMode: 'default',
    uuid: 'init-1',
    session_id: 'provider-1'
  }
}

const journals = createTrackedJournalOpener()
let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-init-'))
})

afterEach(async () => {
  // Why before the rm: the SQLite handle is still open, and Windows refuses to remove its directory.
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function itemsFor(frames: Record<string, unknown>[]) {
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => 1_700_000_000_000,
    mintEpoch: () => 'epoch-1'
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: vi.fn() })
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: '1' })
  for (const frame of frames) {
    translator.handle({ type: 'message', sessionId: 'orca-session', message: frame })
    await deferred.drained()
  }
  return journal.snapshot().items.map((item) => item.body)
}

describe('a Claude init frame', () => {
  it('writes no row for a handshake whose servers all connected', async () => {
    expect(await itemsFor([init([])])).toEqual([])
    expect(await itemsFor([init([{ name: 'github', status: 'connected' }])])).toEqual([])
  })

  it('writes one warning row, not an error card named after the opcode', async () => {
    // Regression (#25477): `hasProviderError` promoted the whole handshake to `error-surface` whenever
    // anything nested in it read as a failure, so the roster reached users as `claude · message:system:init`.
    const items = await itemsFor([
      init([
        { name: 'github', status: 'failed', error: 'auth expired' },
        { name: 'files', status: 'connected' }
      ])
    ])

    expect(items).toEqual([
      { kind: 'status', tone: 'warning', text: 'MCP server github: auth expired' }
    ])
  })

  it('names a failed server that reports no sentence of its own', async () => {
    const items = await itemsFor([init([{ name: 'github', status: 'failed' }])])

    expect(items).toEqual([
      { kind: 'status', tone: 'warning', text: 'MCP server github failed to start' }
    ])
  })
})

describe('claudeInitRowBody', () => {
  it('reads the status as well as the sentence', () => {
    const text = (server: Record<string, unknown>) =>
      claudeInitRowBody({ mcp_servers: [server] })?.text ?? null

    expect(text({ name: 'a', status: 'error' })).toBe('MCP server a failed to start')
    expect(text({ name: 'b', error: 'connection refused' })).toBe(
      'MCP server b: connection refused'
    )
    expect(text({ name: 'c', status: 'CONNECTED' })).toBeNull()
    expect(text({ name: 'd' })).toBeNull()
  })

  it('names the action a server that needs a login is missing', () => {
    expect(claudeInitRowBody({ mcp_servers: [{ name: 'jira', status: 'needs-auth' }] })?.text).toBe(
      'MCP server jira needs authentication'
    )
  })

  it('reports the shape the CLI actually captured', () => {
    // Verbatim from #25477: failed entries carry name, status and source, and no sentence of their own.
    const body = claudeInitRowBody({
      mcp_servers: [
        { name: 'MCP_DOCKER', status: 'failed', source: 'user' },
        { name: 'codegraph', status: 'connected', source: 'user' },
        { name: 'jira', status: 'failed', source: 'user' }
      ]
    })

    expect(body?.text).toBe(
      'MCP server MCP_DOCKER failed to start\nMCP server jira failed to start'
    )
  })

  it('reports every unavailable server, bounded', () => {
    const body = claudeInitRowBody({
      mcp_servers: [
        { name: 'a', status: 'failed' },
        { name: 'b', error: 'timed out' }
      ]
    })

    expect(body?.text).toBe('MCP server a failed to start\nMCP server b: timed out')
  })
})
