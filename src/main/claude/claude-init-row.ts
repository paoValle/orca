// A `system`/`init` frame is the CLI's session handshake, not chat: its tools, model, permission mode
// and slash commands are chrome. The one thing in it a user needs is a dependency that did not start,
// so an unavailable MCP server earns a row in the CLI's own words and the handshake itself earns none.

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
  const sentence = claudeText(server.error)?.trim()
  const status = claudeText(server.status)?.toLowerCase()
  const failed = sentence
    ? true
    : status?.startsWith('error') === true || status?.startsWith('fail') === true
  if (!failed) {
    return null
  }
  const name = claudeText(server.name)?.trim() ?? 'unnamed'
  return sentence ? `MCP server ${name}: ${sentence}` : `MCP server ${name} failed to start`
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
