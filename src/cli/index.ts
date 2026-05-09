#!/usr/bin/env node

import { Command } from 'commander'
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'

const BUS_URL = process.env.GRAFT_BUS_URL ?? 'http://localhost:7433'
const PID_FILE = path.join(require('os').tmpdir(), 'graft-bus.pid')

const program = new Command()
program.name('graft').description('Shared resource coordination layer for parallel AI coding agents').version('1.0.0')

// ── Helpers ──────────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BUS_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((err as { error: string }).error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

function isBusRunning(): Promise<boolean> {
  return fetch(`${BUS_URL}/health`).then(() => true).catch(() => false)
}

function fmt(obj: unknown): string {
  return JSON.stringify(obj, null, 2)
}

function tsToLocal(ts: number): string {
  return new Date(ts).toLocaleString()
}

// ── start ─────────────────────────────────────────────────────────────────────

program
  .command('start')
  .description('Start the Graft bus')
  .option('-p, --port <port>', 'Port to listen on (default: 7433)')
  .option('-c, --config <path>', 'Path to graft.config.yaml')
  .action(async (opts) => {
    const running = await isBusRunning()
    if (running) {
      console.log(`Graft bus already running at ${BUS_URL}`)
      return
    }
    // Dynamic import to avoid loading Fastify at CLI startup
    const { startServer } = await import('../bus/server')
    await startServer(opts.port ? Number(opts.port) : undefined, opts.config)
  })

// ── stop ──────────────────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop the Graft bus (sends SIGTERM to the bus process)')
  .action(async () => {
    try {
      // The bus exposes no stop endpoint — send a request that triggers graceful shutdown
      await fetch(`${BUS_URL}/health`)
      console.log(`Send SIGTERM to the graft start process to stop the bus.`)
      console.log(`If running via graft start, press Ctrl+C in that terminal.`)
    } catch {
      console.log('Graft bus is not running.')
    }
  })

// ── status ────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show bus status, active claims, and pending signals')
  .option('--agent <id>', 'Show signals pending for a specific agent')
  .action(async (opts) => {
    try {
      const health = await api<{ status: string; uptime: number; claims: number; ts: number }>('GET', '/health')
      console.log(`Bus: ${health.status}  uptime: ${health.uptime}s  claims: ${health.claims}`)

      const claims = await api<unknown[]>('GET', '/claims')
      if (claims.length > 0) {
        console.log('\nActive claims:')
        for (const c of claims as Array<{ resourceId: string; agentId: string; intent: string; expiresAt: number }>) {
          const exp = Math.floor((c.expiresAt - Date.now()) / 1000)
          console.log(`  ${c.resourceId}  [${c.agentId}]  "${c.intent}"  expires in ${exp}s`)
        }
      } else {
        console.log('\nNo active claims.')
      }
    } catch (e) {
      console.error('Bus unreachable:', (e as Error).message)
      process.exit(1)
    }
  })

// ── claims ────────────────────────────────────────────────────────────────────

const claims = program.command('claims').description('Manage resource claims')

claims
  .command('list')
  .description('List all active claims')
  .action(async () => {
    const list = await api<unknown[]>('GET', '/claims')
    if (list.length === 0) { console.log('No active claims.'); return }
    console.log(fmt(list))
  })

claims
  .command('release <resource>')
  .description('Force-release a stuck claim')
  .option('--agent <id>', 'Agent ID (required unless using --force)')
  .option('--force', 'Force-release without agent check')
  .action(async (resource, opts) => {
    if (opts.force) {
      // Workaround: release via direct registry — not exposed as HTTP; use agent placeholder
      console.error('--force is not yet supported via CLI. Use the /claims/:id endpoint directly.')
      process.exit(1)
    }
    if (!opts.agent) { console.error('--agent <id> required'); process.exit(1) }
    const r = await api<{ released: boolean }>('DELETE', `/claims/${encodeURIComponent(resource)}?agent_id=${opts.agent}`)
    console.log(r.released ? `Released ${resource}` : 'Claim not found or not owned by that agent.')
  })

// ── signals ───────────────────────────────────────────────────────────────────

const signals = program.command('signals').description('Manage signals')

signals
  .command('list')
  .description('List pending signals for an agent')
  .requiredOption('--agent <id>', 'Agent ID')
  .option('--peek', 'Show without consuming')
  .action(async (opts) => {
    const url = `/signals/pending?agent_id=${opts.agent}${opts.peek ? '&peek=true' : ''}`
    const list = await api<unknown[]>('GET', url)
    if (list.length === 0) { console.log('No pending signals.'); return }
    console.log(fmt(list))
  })

signals
  .command('history')
  .description('Show signal history')
  .option('--agent <id>', 'Filter by receiving agent')
  .option('--from <id>', 'Filter by sending agent')
  .option('--type <type>', 'Filter by signal type')
  .action(async (opts) => {
    const params = new URLSearchParams()
    if (opts.agent) params.set('agent', opts.agent)
    if (opts.from) params.set('from', opts.from)
    if (opts.type) params.set('type', opts.type)
    const list = await api<unknown[]>('GET', `/signals/history?${params}`)
    if (list.length === 0) { console.log('No signal history.'); return }
    console.log(fmt(list))
  })

signals
  .command('publish')
  .description('Publish a signal manually')
  .requiredOption('--from <agent>', 'Sending agent ID')
  .requiredOption('--type <type>', 'Signal type')
  .requiredOption('--message <msg>', 'Signal message')
  .option('--severity <level>', 'low | medium | high | critical')
  .option('--resources <list>', 'Comma-separated affected resource IDs')
  .action(async (opts) => {
    const signal = await api<{ signalId: string }>('POST', '/signals', {
      type: opts.type,
      from: opts.from,
      message: opts.message,
      severity: opts.severity,
      affected_resources: opts.resources ? opts.resources.split(',').map((s: string) => s.trim()) : undefined,
    })
    console.log(`Published signal ${signal.signalId}`)
  })

// ── wave ──────────────────────────────────────────────────────────────────────

const wave = program.command('wave').description('Wave gate management')

wave
  .command('status <name>')
  .description('Show wave completion status')
  .action(async (name) => {
    const status = await api<{ name: string; agents: string[]; completed: string[]; pending: string[]; done: boolean }>(
      'GET', `/wave/${encodeURIComponent(name)}`
    )
    console.log(`Wave: ${status.name}  done: ${status.done}`)
    console.log(`  Completed: ${status.completed.join(', ') || 'none'}`)
    console.log(`  Pending:   ${status.pending.join(', ') || 'none'}`)
  })

// ── audit ─────────────────────────────────────────────────────────────────────

program
  .command('audit')
  .description('Query the audit log')
  .option('--agent <id>', 'Filter by agent')
  .option('--resource <path>', 'Filter by resource')
  .option('--type <type>', 'Filter by event type')
  .option('--since <ts>', 'Unix timestamp — events after this time')
  .option('--limit <n>', 'Max entries to return (default: 200)')
  .action(async (opts) => {
    const params = new URLSearchParams()
    if (opts.agent) params.set('agent', opts.agent)
    if (opts.resource) params.set('resource', opts.resource)
    if (opts.type) params.set('type', opts.type)
    if (opts.since) params.set('since', opts.since)
    if (opts.limit) params.set('limit', opts.limit)
    const entries = await api<Array<{ seq: number; ts: number; type: string; agentId: string; resourceId?: string; detail: unknown }>>(
      'GET', `/audit?${params}`
    )
    if (entries.length === 0) { console.log('No audit entries.'); return }
    for (const e of entries) {
      const res = e.resourceId ? `  ${e.resourceId}` : ''
      console.log(`#${e.seq}  ${tsToLocal(e.ts)}  [${e.type}]  ${e.agentId}${res}`)
    }
  })

// ── audit stream ──────────────────────────────────────────────────────────────

program
  .command('audit:stream')
  .description('Tail the audit log in real time (SSE stream, Ctrl+C to stop)')
  .action(async () => {
    try {
      const res = await fetch(`${BUS_URL}/audit/stream`)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      console.log('Streaming audit events (Ctrl+C to stop)...\n')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const e = JSON.parse(line.slice(6)) as { seq: number; ts: number; type: string; agentId: string; resourceId?: string }
            const res2 = e.resourceId ? `  ${e.resourceId}` : ''
            console.log(`#${e.seq}  ${tsToLocal(e.ts)}  [${e.type}]  ${e.agentId}${res2}`)
          } catch { /* ignore malformed */ }
        }
      }
    } catch (e) {
      console.error('Stream error:', (e as Error).message)
      process.exit(1)
    }
  })

// ── conflicts ─────────────────────────────────────────────────────────────────

const conflicts = program.command('conflicts').description('View conflict log')

conflicts
  .command('list')
  .description('List recorded conflicts')
  .option('--agent <id>', 'Filter by agent')
  .option('--resource <path>', 'Filter by resource')
  .action(async (opts) => {
    const params = new URLSearchParams()
    if (opts.agent) params.set('agent', opts.agent)
    if (opts.resource) params.set('resource', opts.resource)
    const list = await api<unknown[]>('GET', `/conflicts?${params}`)
    if (list.length === 0) { console.log('No conflicts recorded.'); return }
    console.log(fmt(list))
  })

conflicts
  .command('show <conflict_id>')
  .description('Show full conflict detail')
  .action(async (id) => {
    const entry = await api<unknown>('GET', `/conflicts/${encodeURIComponent(id)}`)
    console.log(fmt(entry))
  })

// ── deadlocks ─────────────────────────────────────────────────────────────────

const deadlocks = program.command('deadlocks').description('View deadlock log')

deadlocks
  .command('list')
  .description('List recorded deadlocks')
  .action(async () => {
    const list = await api<unknown[]>('GET', '/deadlocks')
    if (list.length === 0) { console.log('No deadlocks recorded.'); return }
    console.log(fmt(list))
  })

deadlocks
  .command('show <deadlock_id>')
  .description('Show full deadlock graph and resolution')
  .action(async (id) => {
    const entry = await api<unknown>('GET', `/deadlocks/${encodeURIComponent(id)}`)
    console.log(fmt(entry))
  })

// ── timeline ──────────────────────────────────────────────────────────────────

program
  .command('timeline <agent_id>')
  .description('Show chronological event stream for an agent session')
  .option('--since <ts>', 'Unix timestamp — events after this time')
  .action(async (agentId, opts) => {
    const params = opts.since ? `?since=${opts.since}` : ''
    const entries = await api<Array<{ seq: number; ts: number; type: string; agentId: string; detail: unknown }>>(
      'GET', `/timeline/${encodeURIComponent(agentId)}${params}`
    )
    if (entries.length === 0) { console.log('No timeline entries.'); return }
    for (const e of entries) {
      console.log(`${tsToLocal(e.ts)}  [${e.type}]`)
    }
  })

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Set up Graft in the current project — starts the bus and installs Claude Code hooks')
  .option('-p, --port <port>', 'Bus port (default: 7433)')
  .action(async (opts) => {
    const port = opts.port ? Number(opts.port) : 7433
    const cliPath = path.resolve(__dirname, 'index.js')

    // 1. Start bus as background daemon if not already running
    const running = await isBusRunning()
    if (running) {
      console.log(`✓ Graft bus already running at ${BUS_URL}`)
    } else {
      const { spawn } = await import('child_process')
      const proc = spawn(process.execPath, [cliPath, 'start', '--port', String(port)], {
        detached: true,
        stdio: 'ignore',
      })
      proc.unref()
      let started = false
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 300))
        if (await isBusRunning()) { started = true; break }
      }
      if (started) {
        console.log(`✓ Started Graft bus on port ${port}`)
      } else {
        console.error('✗ Bus did not start in time. Run "graft start" manually.')
        process.exit(1)
      }
    }

    // 2. Install hooks with absolute path to compiled CLI (no npx/ts-node needed)
    const hookCmd = (sub: string) =>
      `node ${cliPath} hook ${sub} --tool "$CLAUDE_TOOL_NAME" --input '$CLAUDE_TOOL_INPUT' --agent "\${GRAFT_AGENT_ID:-$CLAUDE_SESSION_ID}"`

    const settingsDir = path.join(process.cwd(), '.claude')
    const settingsPath = path.join(settingsDir, 'settings.json')
    const hookConfig = {
      hooks: {
        PreToolUse: [{ matcher: 'Write|Edit|Bash|NotebookEdit', hooks: [{ type: 'command', command: hookCmd('pre') }] }],
        PostToolUse: [{ matcher: 'Write|Edit|Bash|NotebookEdit', hooks: [{ type: 'command', command: hookCmd('post') }] }],
      },
    }
    fs.mkdirSync(settingsDir, { recursive: true })
    let existing: Record<string, unknown> = {}
    if (fs.existsSync(settingsPath)) {
      try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { /* ignore */ }
    }
    fs.writeFileSync(settingsPath, JSON.stringify({ ...existing, ...hookConfig }, null, 2))
    console.log(`✓ Installed hooks → ${settingsPath}`)
    console.log(`\nReady. Run agents with:\n  graft run "task one" "task two" "task three"`)
  })

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command('run [tasks...]')
  .description('Launch parallel Claude Code agents — one per task argument')
  .option('--agents <n>', 'Number of interactive terminals to open (no tasks required)', parseInt)
  .action(async (tasks: string[], opts) => {
    const cliPath = path.resolve(__dirname, 'index.js')

    // Ensure bus is running
    if (!await isBusRunning()) {
      console.log('Starting Graft bus...')
      const { spawn } = await import('child_process')
      spawn(process.execPath, [cliPath, 'start'], { detached: true, stdio: 'ignore' }).unref()
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 300))
        if (await isBusRunning()) break
      }
    }

    const { spawn } = await import('child_process')

    if (tasks.length > 0) {
      // Non-interactive: run claude -p "<task>" for each task in parallel
      console.log(`Launching ${tasks.length} agent(s)...\n`)
      const procs = tasks.map((task, i) => {
        const agentId = `agent-${String.fromCharCode(97 + i)}`
        console.log(`  ${agentId}: ${task}`)
        return spawn('claude', ['-p', task], {
          env: { ...process.env, GRAFT_AGENT_ID: agentId },
          stdio: 'inherit',
        })
      })
      console.log('')
      await Promise.all(procs.map(p => new Promise(r => p.on('close', r))))
      console.log('\nAll agents finished. Run "graft audit" to review what happened.')
    } else {
      // Interactive: open N terminal windows, each with GRAFT_AGENT_ID set
      const count = opts.agents ?? 2
      console.log(`Opening ${count} terminal window(s)...\n`)
      for (let i = 0; i < count; i++) {
        const agentId = `agent-${String.fromCharCode(97 + i)}`
        const script = `GRAFT_AGENT_ID=${agentId} claude`
        spawn('osascript', ['-e', `tell application "Terminal" to do script "${script}"`], { stdio: 'ignore' })
        console.log(`  Opened terminal for ${agentId}`)
      }
      console.log(`\nMonitor coordination:\n  graft status\n  graft conflicts list\n  graft audit`)
    }
  })

// ── install ───────────────────────────────────────────────────────────────────

program
  .command('install')
  .description('Install Graft hooks for your agent framework')
  .option('--claude-code', 'Install Claude Code preToolUse/postToolUse hooks')
  .option('--mcp', 'Print MCP server config snippet')
  .option('--openai', 'Print OpenAI Agents SDK usage snippet')
  .action(async (opts) => {
    if (opts.claudeCode) {
      const cliPath = path.resolve(__dirname, 'index.js')
      const hookCmd = (sub: string) =>
        `node ${cliPath} hook ${sub} --tool "$CLAUDE_TOOL_NAME" --input '$CLAUDE_TOOL_INPUT' --agent "\${GRAFT_AGENT_ID:-$CLAUDE_SESSION_ID}"`
      const settingsDir = path.join(process.cwd(), '.claude')
      const settingsPath = path.join(settingsDir, 'settings.json')
      const hookConfig = {
        hooks: {
          PreToolUse: [{ matcher: 'Write|Edit|Bash|NotebookEdit', hooks: [{ type: 'command', command: hookCmd('pre') }] }],
          PostToolUse: [{ matcher: 'Write|Edit|Bash|NotebookEdit', hooks: [{ type: 'command', command: hookCmd('post') }] }],
        },
      }
      fs.mkdirSync(settingsDir, { recursive: true })
      let existing: Record<string, unknown> = {}
      if (fs.existsSync(settingsPath)) {
        try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { /* ignore */ }
      }
      fs.writeFileSync(settingsPath, JSON.stringify({ ...existing, ...hookConfig }, null, 2))
      console.log(`Wrote hooks to ${settingsPath}`)
    }

    if (opts.mcp) {
      console.log(`Add to your Claude MCP config:\n\n${JSON.stringify({
        mcpServers: { graft: { url: 'http://localhost:7434/mcp' } }
      }, null, 2)}\n\nThen run: graft mcp --port 7434`)
    }

    if (opts.openai) {
      console.log(`import { graftTools } from 'graft/openai'\n\nconst agent = new Agent({\n  tools: [\n    ...graftTools({ busUrl: 'http://localhost:7433', agentId: 'agent-a' }),\n    ...yourOtherTools\n  ]\n})`)
    }
  })

// ── hook (called by Claude Code hooks) ────────────────────────────────────────

const hook = program.command('hook').description('Internal: called by Claude Code hooks').addHelpText('before', '(internal — called by hook config, not directly by users)')

hook
  .command('pre')
  .description('preToolUse handler')
  .option('--tool <name>', 'Tool name (overrides stdin)')
  .option('--input <json>', 'Tool input JSON (overrides stdin)')
  .option('--agent <id>', 'Agent ID (overrides stdin session_id)')
  .option('--bus <url>', 'Bus URL')
  .action(async (opts) => {
    const { handlePreToolUse } = await import('../adapters/claude-code/hooks')

    // Read hook data from stdin (Claude Code sends JSON) then apply any CLI overrides
    let stdinData: Record<string, unknown> = {}
    if (!process.stdin.isTTY) {
      const raw = await new Promise<string>(res => {
        let buf = ''
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', d => { buf += d })
        process.stdin.on('end', () => res(buf))
      })
      try { stdinData = JSON.parse(raw) } catch { /* ignore */ }
    }

    const toolName: string = opts.tool ?? (stdinData.tool_name as string) ?? ''
    const agentId: string = opts.agent ?? process.env.GRAFT_AGENT_ID ?? (stdinData.session_id as string) ?? 'unknown'
    let toolInput: Record<string, unknown> = (stdinData.tool_input as Record<string, unknown>) ?? {}
    if (opts.input) try { toolInput = JSON.parse(opts.input) } catch { /* ignore */ }

    const result = await handlePreToolUse({ toolName, toolInput, agentId, busUrl: opts.bus })
    if (!result.proceed) {
      if (result.message) process.stderr.write(result.message + '\n')
      process.exit(2)
    }
    if (result.message) process.stdout.write(result.message + '\n')
  })

hook
  .command('post')
  .description('postToolUse handler')
  .option('--tool <name>', 'Tool name (overrides stdin)')
  .option('--input <json>', 'Tool input JSON (overrides stdin)')
  .option('--agent <id>', 'Agent ID (overrides stdin session_id)')
  .option('--bus <url>', 'Bus URL')
  .option('--output <json>', 'Tool output JSON (overrides stdin)')
  .action(async (opts) => {
    const { handlePostToolUse } = await import('../adapters/claude-code/hooks')

    let stdinData: Record<string, unknown> = {}
    if (!process.stdin.isTTY) {
      const raw = await new Promise<string>(res => {
        let buf = ''
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', d => { buf += d })
        process.stdin.on('end', () => res(buf))
      })
      try { stdinData = JSON.parse(raw) } catch { /* ignore */ }
    }

    const toolName: string = opts.tool ?? (stdinData.tool_name as string) ?? ''
    const agentId: string = opts.agent ?? process.env.GRAFT_AGENT_ID ?? (stdinData.session_id as string) ?? 'unknown'
    let toolInput: Record<string, unknown> = (stdinData.tool_input as Record<string, unknown>) ?? {}
    if (opts.input) try { toolInput = JSON.parse(opts.input) } catch { /* ignore */ }
    let toolOutput: Record<string, unknown> | undefined = stdinData.tool_output as Record<string, unknown> | undefined
    if (opts.output) try { toolOutput = JSON.parse(opts.output) } catch { /* ignore */ }

    const result = await handlePostToolUse({ toolName, toolInput, toolOutput, agentId, busUrl: opts.bus })
    if (result.message) process.stdout.write(result.message + '\n')
    if (result.warning) process.stdout.write(result.warning + '\n')
  })

// ── metrics ───────────────────────────────────────────────────────────────────

program
  .command('metrics')
  .description('Show bus metrics (Prometheus format by default)')
  .option('--json', 'Output as JSON instead of Prometheus text')
  .action(async (opts) => {
    try {
      if (opts.json) {
        const data = await api<unknown>('GET', '/metrics?format=json')
        console.log(fmt(data))
      } else {
        const res = await fetch(`${BUS_URL}/metrics`)
        if (!res.ok) throw new Error(res.statusText)
        console.log(await res.text())
      }
    } catch (e) {
      console.error('Bus unreachable:', (e as Error).message)
      process.exit(1)
    }
  })

// ── agents ────────────────────────────────────────────────────────────────────

program
  .command('agents')
  .description('Show agent roster — who has been active, what they hold, their signal queue depth')
  .option('--active', 'Show only active agents (holding claims or seen < 5 min ago)')
  .action(async (opts) => {
    try {
      let roster = await api<Array<{
        agentId: string; firstSeen: number; lastSeen: number
        claimsGranted: number; claimsDenied: number
        signalsPublished: number; signalsReceived: number
        currentClaims: string[]; pendingSignals: number; active: boolean
      }>>('GET', '/agents')

      if (opts.active) roster = roster.filter(a => a.active)
      if (roster.length === 0) { console.log('No agents recorded.'); return }

      for (const a of roster) {
        const status = a.active ? 'ACTIVE' : 'idle'
        console.log(`${a.agentId}  [${status}]  last seen: ${tsToLocal(a.lastSeen)}`)
        console.log(`  claims: ${a.claimsGranted} granted, ${a.claimsDenied} denied  signals: ${a.signalsPublished} sent, ${a.signalsReceived} received`)
        if (a.currentClaims.length > 0) console.log(`  holding: ${a.currentClaims.join(', ')}`)
        if (a.pendingSignals > 0) console.log(`  pending signals: ${a.pendingSignals}`)
      }
    } catch (e) {
      console.error('Bus unreachable:', (e as Error).message)
      process.exit(1)
    }
  })

// ── stats ─────────────────────────────────────────────────────────────────────

const stats = program.command('stats').description('Aggregated coordination statistics')

stats
  .command('contention')
  .description('Show contention heatmap — most contested resources')
  .option('--limit <n>', 'Max resources to show (default: 20)')
  .action(async (opts) => {
    try {
      const params = opts.limit ? `?limit=${opts.limit}` : ''
      const list = await api<Array<{
        resourceId: string; denials: number; lastDeniedAt: number
        topRequestingAgents: Array<{ agentId: string; count: number }>
        topBlockingAgents: Array<{ agentId: string; count: number }>
      }>>('GET', `/stats/contention${params}`)

      if (list.length === 0) { console.log('No contention recorded.'); return }

      console.log(`${'Resource'.padEnd(50)} ${'Denials'.padStart(8)}  Last denied`)
      console.log('─'.repeat(75))
      for (const entry of list) {
        const res = entry.resourceId.length > 48 ? '…' + entry.resourceId.slice(-47) : entry.resourceId
        console.log(`${res.padEnd(50)} ${String(entry.denials).padStart(8)}  ${tsToLocal(entry.lastDeniedAt)}`)
        if (entry.topBlockingAgents.length > 0) {
          console.log(`  blocked by: ${entry.topBlockingAgents.map(a => `${a.agentId}(${a.count})`).join(', ')}`)
        }
        if (entry.topRequestingAgents.length > 0) {
          console.log(`  requested by: ${entry.topRequestingAgents.map(a => `${a.agentId}(${a.count})`).join(', ')}`)
        }
      }
    } catch (e) {
      console.error('Bus unreachable:', (e as Error).message)
      process.exit(1)
    }
  })

// ── mcp ───────────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Start Graft as an MCP server')
  .option('--port <port>', 'HTTP port (default: 7434; omit for stdio)')
  .option('--bus <url>', 'Graft bus URL (default: http://localhost:7433)')
  .option('--agent <id>', 'Agent ID for this MCP session')
  .action(async (opts) => {
    const { startMcpServer } = await import('../adapters/mcp/server')
    await startMcpServer({
      busUrl: opts.bus,
      agentId: opts.agent,
      transport: opts.port ? 'http' : 'stdio',
      httpPort: opts.port ? Number(opts.port) : undefined,
    })
  })

program.parseAsync(process.argv).catch((e) => {
  console.error(e.message)
  process.exit(1)
})
