/**
 * Claude Code hook handlers for Graft.
 *
 * preToolUse  — claim the target resource; deliver pending signals.
 * postToolUse — refresh TTL for writes; release for reads.
 *
 * These are invoked by the `graft hook pre` and `graft hook post` CLI commands,
 * which are wired into Claude Code via .claude/settings.json.
 */

import * as path from 'path'
import { GraftClient } from '../../sdk/client'
import type { ChangeSummaryPayload } from '../../bus/signals'

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

function extractResource(toolName: string, toolInput: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Write':
    case 'Read':
      return (toolInput.file_path as string) ?? null
    case 'Edit':
      return (toolInput.file_path as string) ?? null
    case 'NotebookEdit':
      return (toolInput.notebook_path as string) ?? null
    case 'Bash': {
      // Best-effort: extract first file-like token from the command
      const cmd = toolInput.command as string
      if (!cmd) return null
      const match = cmd.match(/(?:^|\s)([\w./\-]+\.\w+)/)
      return match ? match[1] : null
    }
    default:
      return null
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

  const resourceId = extractResource(toolName, toolInput)
  if (!resourceId) {
    return { proceed: true, message: signalContext.trim() || undefined }
  }

  try {
    const result = await client.claim({ resourceId, intent: `${toolName} on ${resourceId}` })

    if (result.granted) {
      const lines = [`Graft: claimed ${resourceId}`]
      if (signalContext) lines.push(signalContext.trim())
      return { proceed: true, message: lines.join('\n') }
    }

    const holder = result.holder!
    const message = [
      `Graft has blocked this tool call. Another agent (${holder.agentId}) currently holds an exclusive write claim on this resource.`,
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

  const resourceId = extractResource(toolName, toolInput)
  if (!resourceId) return { broadcasted: false }

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
