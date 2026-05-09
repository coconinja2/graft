/**
 * Claude Code hook handlers for Graft.
 *
 * preToolUse  — claim the target resource; deliver pending signals.
 * postToolUse — refresh TTL for writes; release for reads.
 *
 * These are invoked by the `graft hook pre` and `graft hook post` CLI commands,
 * which are wired into Claude Code via .claude/settings.json.
 */

import * as fs from 'fs'
import * as path from 'path'
import { GraftClient } from '../../sdk/client'
import type { ChangeSummaryPayload } from '../../bus/signals'
import type { LineRange } from '../../bus/registry'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'Bash', 'NotebookEdit'])

async function ensureBusRunning(busUrl: string): Promise<void> {
  try {
    await fetch(`${busUrl}/health`, { signal: AbortSignal.timeout(500) })
    return
  } catch {
    // Bus not reachable — start it as a background daemon
    const { spawn } = await import('child_process')
    const cliPath = path.resolve(__dirname, '../../cli/index.js')
    spawn(process.execPath, [cliPath, 'start'], { detached: true, stdio: 'ignore' }).unref()
    // Wait up to 2.5s for the bus to bind
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 250))
      try {
        await fetch(`${busUrl}/health`, { signal: AbortSignal.timeout(200) })
        return
      } catch { /* still starting */ }
    }
  }
}
const READ_TOOLS = new Set(['Read'])

interface ResourceInfo {
  resourceId: string
  lineRange?: LineRange
}

function extractResource(toolName: string, toolInput: Record<string, unknown>): ResourceInfo | null {
  switch (toolName) {
    case 'Write':
    case 'Read': {
      const filePath = toolInput.file_path as string | undefined
      return filePath ? { resourceId: filePath } : null
    }
    case 'Edit': {
      const filePath = toolInput.file_path as string | undefined
      if (!filePath) return null
      const oldString = toolInput.old_string as string | undefined
      const lineRange = oldString ? resolveLineRange(filePath, oldString) : undefined
      return { resourceId: filePath, lineRange }
    }
    case 'NotebookEdit': {
      const notebookPath = toolInput.notebook_path as string | undefined
      return notebookPath ? { resourceId: notebookPath } : null
    }
    case 'Bash': {
      const cmd = toolInput.command as string | undefined
      if (!cmd) return null
      const match = cmd.match(/(?:^|\s)([\w./\-]+\.\w+)/)
      return match ? { resourceId: match[1] } : null
    }
    default:
      return null
  }
}

// Read the file before the edit executes and locate old_string to compute its line range.
// Returns undefined when the file doesn't exist, old_string isn't found, or it appears
// more than once (ambiguous — fall back to whole-file claim).
function resolveLineRange(filePath: string, oldString: string): LineRange | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const idx = content.indexOf(oldString)
    if (idx === -1) return undefined
    if (content.indexOf(oldString, idx + 1) !== -1) return undefined  // multiple matches
    const lineStart = content.slice(0, idx).split('\n').length
    const lineEnd = lineStart + oldString.split('\n').length - 1
    return { start: lineStart, end: lineEnd }
  } catch {
    return undefined
  }
}

export interface PreHookInput {
  toolName: string
  toolInput: Record<string, unknown>
  agentId: string
  busUrl?: string
}

export interface PreHookOutput {
  proceed: boolean
  message?: string
}

export async function handlePreToolUse(input: PreHookInput): Promise<PreHookOutput> {
  const { toolName, toolInput, agentId, busUrl } = input

  const client = new GraftClient({ busUrl, agentId })
  await ensureBusRunning(client.busUrl).catch(() => { /* fail open */ })

  // Ensure this agent has a signal queue. Idempotent — safe to call every hook.
  // Subscribing here means agent B automatically receives change_summary signals
  // from agent A even if B was blocked and moved on to other work.
  await client.subscribe(['change_summary', 'interface_change', 'schema_change', 'security_finding', 'new_utility', 'resource_conflict']).catch(() => {})

  // Always deliver pending signals, regardless of whether we claim
  let signalContext = ''
  try {
    const signals = await client.getPendingSignals()
    if (signals.length > 0) {
      const formatted = signals.map(s => {
        const lines: string[] = [`  [${s.type}] from ${s.from}: ${s.message}`]
        if (s.affectedResources?.length) {
          lines.push(`    affected: ${s.affectedResources.join(', ')}`)
        }
        if (s.changeContext) {
          lines.push(`    what: ${s.changeContext.what}`)
          if (s.changeContext.why) lines.push(`    why: ${s.changeContext.why}`)
          if (s.changeContext.breakingChange) lines.push(`    breaking: yes`)
          if (s.changeContext.diff) lines.push(`    diff:\n${s.changeContext.diff.split('\n').map(l => `      ${l}`).join('\n')}`)
        }
        return lines.join('\n')
      })
      signalContext =
        '\n\nChanges broadcast by other agents — review and decide how to proceed:\n' +
        formatted.join('\n') +
        '\n\nIf any of these changes affect what you are currently working on, incorporate them before continuing. If they are unrelated to your current task, continue as planned.'
    }
  } catch {
    // Bus unreachable — fail open
  }

  if (!WRITE_TOOLS.has(toolName)) {
    if (signalContext) {
      return { proceed: true, message: signalContext.trim() }
    }
    return { proceed: true }
  }

  const resource = extractResource(toolName, toolInput)
  if (!resource) {
    return { proceed: true, message: signalContext.trim() || undefined }
  }

  const { resourceId, lineRange } = resource
  const rangeDesc = lineRange ? ` lines ${lineRange.start}–${lineRange.end}` : ''

  try {
    const result = await client.claim({ resourceId, lineStart: lineRange?.start, lineEnd: lineRange?.end, intent: `${toolName} on ${resourceId}${rangeDesc}` })

    if (result.granted) {
      const lines = [`Graft: claimed ${resourceId}${rangeDesc}`]
      if (signalContext) lines.push(signalContext.trim())
      return { proceed: true, message: lines.join('\n') }
    }

    const holder = result.holder!
    const holderRange = holder.lineRange ? ` (lines ${holder.lineRange.start}–${holder.lineRange.end})` : ''
    const message = [
      `Graft has blocked this tool call. Another agent (${holder.agentId}) holds an exclusive write claim on ${resourceId}${holderRange}.`,
      `Holder intent: "${holder.intent}"`,
      `Conflict ID: ${result.conflictId}`,
      `This is not a file or tool error — it is a coordination signal. Do not retry. Either work on something else or let the user know you are waiting.`,
      signalContext,
    ]
      .filter(Boolean)
      .join('\n')

    return { proceed: false, message }
  } catch {
    // Bus unreachable — fail open
    return { proceed: true, message: signalContext.trim() || undefined }
  }
}

export interface PostHookInput {
  toolName: string
  toolInput: Record<string, unknown>
  toolOutput?: Record<string, unknown>
  agentId: string
  busUrl?: string
  changeSummary?: ChangeSummaryPayload
}

export interface PostHookOutput {
  broadcasted: boolean
  message?: string
  warning?: string
}

export async function handlePostToolUse(input: PostHookInput): Promise<PostHookOutput> {
  const { toolName, toolInput, toolOutput, agentId, busUrl, changeSummary } = input
  const client = new GraftClient({ busUrl, agentId })

  const resource = extractResource(toolName, toolInput)
  if (!resource) return { broadcasted: false }
  const { resourceId } = resource

  try {
    if (READ_TOOLS.has(toolName)) {
      await client.release(resourceId)
      return { broadcasted: false }
    }

    if (WRITE_TOOLS.has(toolName)) {
      const payload: ChangeSummaryPayload = changeSummary ?? {
        what: `${agentId} modified ${resourceId}`,
        why: 'No summary provided — inspect the file for details.',
        breakingChange: false,
        affectedResources: [resourceId],
        diff: typeof toolOutput?.patch === 'string' ? toolOutput.patch : undefined,
      }

      await Promise.all([
        client.heartbeat(resourceId).catch(() => {}),
        client.publish({
          type: 'change_summary',
          message: payload.what,
          affectedResources: payload.affectedResources,
          severity: payload.breakingChange ? 'high' : 'low',
          changeContext: payload,
        }).catch(() => {}),
      ])

      return { broadcasted: true, message: `Graft: released ${resourceId} — change_summary broadcast to other agents` }
    }
  } catch {
    // Bus unreachable — fail open
  }

  return { broadcasted: false }
}
