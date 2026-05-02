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
      signalContext =
        '\n\nPending signals from Graft bus:\n' +
        signals
          .map(s => `  [${s.type}] from ${s.from}: ${s.message}`)
          .join('\n')
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
}

export async function handlePostToolUse(input: PostHookInput): Promise<void> {
  const { toolName, toolInput, agentId, busUrl } = input
  const client = new GraftClient({ busUrl, agentId })

  const resourceId = extractResource(toolName, toolInput)
  if (!resourceId) return

  try {
    if (READ_TOOLS.has(toolName)) {
      await client.release(resourceId)
    } else if (WRITE_TOOLS.has(toolName)) {
      await client.heartbeat(resourceId)
    }
  } catch {
    // Bus unreachable — fail open
  }
}
