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
      const msg = signalContext ? signalContext.trim() : undefined
      return { proceed: true, message: msg }
    }

    const holder = result.holder!
    const message = [
      `Resource ${resourceId} is currently claimed by ${holder.agentId}.`,
      `Agent intent: "${holder.intent}"`,
      `Conflict ID: ${result.conflictId}`,
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
  agentId: string
  busUrl?: string
  changeSummary?: ChangeSummaryPayload
}

export interface PostHookOutput {
  broadcasted: boolean
  warning?: string
}

export async function handlePostToolUse(input: PostHookInput): Promise<PostHookOutput> {
  const { toolName, toolInput, agentId, busUrl, changeSummary } = input
  const client = new GraftClient({ busUrl, agentId })

  const resourceId = extractResource(toolName, toolInput)
  if (!resourceId) return { broadcasted: false }

  try {
    if (READ_TOOLS.has(toolName)) {
      await client.release(resourceId)
      return { broadcasted: false }
    }

    if (WRITE_TOOLS.has(toolName)) {
      if (!changeSummary) {
        await client.heartbeat(resourceId).catch(() => {})
        return {
          broadcasted: false,
          warning:
            `Graft: change_summary not broadcast for ${resourceId}. ` +
            `Provide changeSummary (what, why, breakingChange, affectedResources) ` +
            `so other agents can decide how to respond.`,
        }
      }

      await Promise.all([
        client.heartbeat(resourceId).catch(() => {}),
        client.publish({
          type: 'change_summary',
          message: changeSummary.what,
          affectedResources: changeSummary.affectedResources,
          severity: changeSummary.breakingChange ? 'high' : 'low',
          changeContext: changeSummary,
        }).catch(() => {}),
      ])

      return { broadcasted: true }
    }
  } catch {
    // Bus unreachable — fail open
  }

  return { broadcasted: false }
}
