// A `system`/`init` frame is the CLI's session handshake, not chat: its tools, model, permission mode
// and slash commands are chrome. The one thing in it a user needs is a dependency that did not start,
// so an unavailable MCP server earns a row in the CLI's own words and the handshake itself earns none.
//
// Why this reader is this tolerant: the captured init frame (Claude Code 2.1.289, #25477) reports a
// failed server as `{"name":"MCP_DOCKER","status":"failed","source":"user"}` — no `error` field — so
// the status arm is the one that actually fires and the sentence arm is tolerance for a provider that
// does send one.

import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

export const CLAUDE_INIT_FRAME_KIND = 'message:system:init'

/** A server the handshake reports as one this session could not use. */
function unavailableMcpServer(entry: unknown): string | null {
  const server = claudeRecord(entry)
  if (!server) {
    return null
  }
  const name = claudeText(server.name)?.trim() ?? 'unnamed'
  const sentence = claudeText(server.error)?.trim()
  if (sentence) {
    return `MCP server ${name}: ${sentence}`
  }
  const status = claudeText(server.status)?.toLowerCase()
  if (status?.startsWith('error') === true || status?.startsWith('fail') === true) {
    return `MCP server ${name} failed to start`
  }
  // Why: a server that needs a login is one the session cannot use either, and unlike a crash it is
  // the user's to fix — so it says which action is missing rather than that it failed.
  return status === 'needs-auth' ? `MCP server ${name} needs authentication` : null
}

/** The row a handshake writes for the MCP servers it reports unavailable; null when it reports none. */
export function claudeInitRowBody(message: Record<string, unknown>): AgentJournalStatusItem | null {
  const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : []
  const unavailable = servers.flatMap((entry) => {
    const text = unavailableMcpServer(entry)
    return text ? [text] : []
  })
  return unavailable.length > 0
    ? {
        kind: 'status',
        tone: 'warning',
        text: boundInlineText(unavailable.join('\n'), DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      }
    : null
}
