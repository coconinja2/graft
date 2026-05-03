#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const BUS_URL = process.env.GRAFT_BUS_URL ?? 'http://localhost:7433';
const PID_FILE = path.join(require('os').tmpdir(), 'graft-bus.pid');
const program = new commander_1.Command();
program.name('graft').description('Shared resource coordination layer for parallel AI coding agents').version('1.0.0');
// ── Helpers ──────────────────────────────────────────────────────────────────
async function api(method, path, body) {
    const res = await fetch(`${BUS_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
    }
    return res.json();
}
function isBusRunning() {
    return fetch(`${BUS_URL}/health`).then(() => true).catch(() => false);
}
function fmt(obj) {
    return JSON.stringify(obj, null, 2);
}
function tsToLocal(ts) {
    return new Date(ts).toLocaleString();
}
// ── start ─────────────────────────────────────────────────────────────────────
program
    .command('start')
    .description('Start the Graft bus')
    .option('-p, --port <port>', 'Port to listen on (default: 7433)')
    .option('-c, --config <path>', 'Path to graft.config.yaml')
    .action(async (opts) => {
    const running = await isBusRunning();
    if (running) {
        console.log(`Graft bus already running at ${BUS_URL}`);
        return;
    }
    // Dynamic import to avoid loading Fastify at CLI startup
    const { startServer } = await Promise.resolve().then(() => __importStar(require('../bus/server')));
    await startServer(opts.port ? Number(opts.port) : undefined, opts.config);
});
// ── stop ──────────────────────────────────────────────────────────────────────
program
    .command('stop')
    .description('Stop the Graft bus (sends SIGTERM to the bus process)')
    .action(async () => {
    try {
        // The bus exposes no stop endpoint — send a request that triggers graceful shutdown
        await fetch(`${BUS_URL}/health`);
        console.log(`Send SIGTERM to the graft start process to stop the bus.`);
        console.log(`If running via graft start, press Ctrl+C in that terminal.`);
    }
    catch {
        console.log('Graft bus is not running.');
    }
});
// ── status ────────────────────────────────────────────────────────────────────
program
    .command('status')
    .description('Show bus status, active claims, and pending signals')
    .option('--agent <id>', 'Show signals pending for a specific agent')
    .action(async (opts) => {
    try {
        const health = await api('GET', '/health');
        console.log(`Bus: ${health.status}  uptime: ${health.uptime}s  claims: ${health.claims}`);
        const claims = await api('GET', '/claims');
        if (claims.length > 0) {
            console.log('\nActive claims:');
            for (const c of claims) {
                const exp = Math.floor((c.expiresAt - Date.now()) / 1000);
                console.log(`  ${c.resourceId}  [${c.agentId}]  "${c.intent}"  expires in ${exp}s`);
            }
        }
        else {
            console.log('\nNo active claims.');
        }
    }
    catch (e) {
        console.error('Bus unreachable:', e.message);
        process.exit(1);
    }
});
// ── claims ────────────────────────────────────────────────────────────────────
const claims = program.command('claims').description('Manage resource claims');
claims
    .command('list')
    .description('List all active claims')
    .action(async () => {
    const list = await api('GET', '/claims');
    if (list.length === 0) {
        console.log('No active claims.');
        return;
    }
    console.log(fmt(list));
});
claims
    .command('release <resource>')
    .description('Force-release a stuck claim')
    .option('--agent <id>', 'Agent ID (required unless using --force)')
    .option('--force', 'Force-release without agent check')
    .action(async (resource, opts) => {
    if (opts.force) {
        // Workaround: release via direct registry — not exposed as HTTP; use agent placeholder
        console.error('--force is not yet supported via CLI. Use the /claims/:id endpoint directly.');
        process.exit(1);
    }
    if (!opts.agent) {
        console.error('--agent <id> required');
        process.exit(1);
    }
    const r = await api('DELETE', `/claims/${encodeURIComponent(resource)}?agent_id=${opts.agent}`);
    console.log(r.released ? `Released ${resource}` : 'Claim not found or not owned by that agent.');
});
// ── signals ───────────────────────────────────────────────────────────────────
const signals = program.command('signals').description('Manage signals');
signals
    .command('list')
    .description('List pending signals for an agent')
    .requiredOption('--agent <id>', 'Agent ID')
    .option('--peek', 'Show without consuming')
    .action(async (opts) => {
    const url = `/signals/pending?agent_id=${opts.agent}${opts.peek ? '&peek=true' : ''}`;
    const list = await api('GET', url);
    if (list.length === 0) {
        console.log('No pending signals.');
        return;
    }
    console.log(fmt(list));
});
signals
    .command('history')
    .description('Show signal history')
    .option('--agent <id>', 'Filter by receiving agent')
    .option('--from <id>', 'Filter by sending agent')
    .option('--type <type>', 'Filter by signal type')
    .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.agent)
        params.set('agent', opts.agent);
    if (opts.from)
        params.set('from', opts.from);
    if (opts.type)
        params.set('type', opts.type);
    const list = await api('GET', `/signals/history?${params}`);
    if (list.length === 0) {
        console.log('No signal history.');
        return;
    }
    console.log(fmt(list));
});
signals
    .command('publish')
    .description('Publish a signal manually')
    .requiredOption('--from <agent>', 'Sending agent ID')
    .requiredOption('--type <type>', 'Signal type')
    .requiredOption('--message <msg>', 'Signal message')
    .option('--severity <level>', 'low | medium | high | critical')
    .option('--resources <list>', 'Comma-separated affected resource IDs')
    .action(async (opts) => {
    const signal = await api('POST', '/signals', {
        type: opts.type,
        from: opts.from,
        message: opts.message,
        severity: opts.severity,
        affected_resources: opts.resources ? opts.resources.split(',').map((s) => s.trim()) : undefined,
    });
    console.log(`Published signal ${signal.signalId}`);
});
// ── wave ──────────────────────────────────────────────────────────────────────
const wave = program.command('wave').description('Wave gate management');
wave
    .command('status <name>')
    .description('Show wave completion status')
    .action(async (name) => {
    const status = await api('GET', `/wave/${encodeURIComponent(name)}`);
    console.log(`Wave: ${status.name}  done: ${status.done}`);
    console.log(`  Completed: ${status.completed.join(', ') || 'none'}`);
    console.log(`  Pending:   ${status.pending.join(', ') || 'none'}`);
});
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
    const params = new URLSearchParams();
    if (opts.agent)
        params.set('agent', opts.agent);
    if (opts.resource)
        params.set('resource', opts.resource);
    if (opts.type)
        params.set('type', opts.type);
    if (opts.since)
        params.set('since', opts.since);
    if (opts.limit)
        params.set('limit', opts.limit);
    const entries = await api('GET', `/audit?${params}`);
    if (entries.length === 0) {
        console.log('No audit entries.');
        return;
    }
    for (const e of entries) {
        const res = e.resourceId ? `  ${e.resourceId}` : '';
        console.log(`#${e.seq}  ${tsToLocal(e.ts)}  [${e.type}]  ${e.agentId}${res}`);
    }
});
// ── conflicts ─────────────────────────────────────────────────────────────────
const conflicts = program.command('conflicts').description('View conflict log');
conflicts
    .command('list')
    .description('List recorded conflicts')
    .option('--agent <id>', 'Filter by agent')
    .option('--resource <path>', 'Filter by resource')
    .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.agent)
        params.set('agent', opts.agent);
    if (opts.resource)
        params.set('resource', opts.resource);
    const list = await api('GET', `/conflicts?${params}`);
    if (list.length === 0) {
        console.log('No conflicts recorded.');
        return;
    }
    console.log(fmt(list));
});
conflicts
    .command('show <conflict_id>')
    .description('Show full conflict detail')
    .action(async (id) => {
    const entry = await api('GET', `/conflicts/${encodeURIComponent(id)}`);
    console.log(fmt(entry));
});
// ── deadlocks ─────────────────────────────────────────────────────────────────
const deadlocks = program.command('deadlocks').description('View deadlock log');
deadlocks
    .command('list')
    .description('List recorded deadlocks')
    .action(async () => {
    const list = await api('GET', '/deadlocks');
    if (list.length === 0) {
        console.log('No deadlocks recorded.');
        return;
    }
    console.log(fmt(list));
});
deadlocks
    .command('show <deadlock_id>')
    .description('Show full deadlock graph and resolution')
    .action(async (id) => {
    const entry = await api('GET', `/deadlocks/${encodeURIComponent(id)}`);
    console.log(fmt(entry));
});
// ── timeline ──────────────────────────────────────────────────────────────────
program
    .command('timeline <agent_id>')
    .description('Show chronological event stream for an agent session')
    .option('--since <ts>', 'Unix timestamp — events after this time')
    .action(async (agentId, opts) => {
    const params = opts.since ? `?since=${opts.since}` : '';
    const entries = await api('GET', `/timeline/${encodeURIComponent(agentId)}${params}`);
    if (entries.length === 0) {
        console.log('No timeline entries.');
        return;
    }
    for (const e of entries) {
        console.log(`${tsToLocal(e.ts)}  [${e.type}]`);
    }
});
// ── init ──────────────────────────────────────────────────────────────────────
program
    .command('init')
    .description('Set up Graft in the current project — starts the bus and installs Claude Code hooks')
    .option('-p, --port <port>', 'Bus port (default: 7433)')
    .action(async (opts) => {
    const port = opts.port ? Number(opts.port) : 7433;
    const cliPath = path.resolve(__dirname, 'index.js');
    // 1. Start bus as background daemon if not already running
    const running = await isBusRunning();
    if (running) {
        console.log(`✓ Graft bus already running at ${BUS_URL}`);
    }
    else {
        const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
        const proc = spawn(process.execPath, [cliPath, 'start', '--port', String(port)], {
            detached: true,
            stdio: 'ignore',
        });
        proc.unref();
        let started = false;
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 300));
            if (await isBusRunning()) {
                started = true;
                break;
            }
        }
        if (started) {
            console.log(`✓ Started Graft bus on port ${port}`);
        }
        else {
            console.error('✗ Bus did not start in time. Run "graft start" manually.');
            process.exit(1);
        }
    }
    // 2. Install hooks with absolute path to compiled CLI (no npx/ts-node needed)
    const hookCmd = (sub) => `node ${cliPath} hook ${sub} --tool "$CLAUDE_TOOL_NAME" --input '$CLAUDE_TOOL_INPUT' --agent "\${GRAFT_AGENT_ID:-$CLAUDE_SESSION_ID}"`;
    const settingsDir = path.join(process.cwd(), '.claude');
    const settingsPath = path.join(settingsDir, 'settings.json');
    const hookConfig = {
        hooks: {
            PreToolUse: [{ matcher: 'Write|Edit|Bash|NotebookEdit', hooks: [{ type: 'command', command: hookCmd('pre') }] }],
            PostToolUse: [{ matcher: 'Write|Edit|Bash|NotebookEdit', hooks: [{ type: 'command', command: hookCmd('post') }] }],
        },
    };
    fs.mkdirSync(settingsDir, { recursive: true });
    let existing = {};
    if (fs.existsSync(settingsPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
        catch { /* ignore */ }
    }
    fs.writeFileSync(settingsPath, JSON.stringify({ ...existing, ...hookConfig }, null, 2));
    console.log(`✓ Installed hooks → ${settingsPath}`);
    console.log(`\nReady. Run agents with:\n  graft run "task one" "task two" "task three"`);
});
// ── run ───────────────────────────────────────────────────────────────────────
program
    .command('run [tasks...]')
    .description('Launch parallel Claude Code agents — one per task argument')
    .option('--agents <n>', 'Number of interactive terminals to open (no tasks required)', parseInt)
    .action(async (tasks, opts) => {
    const cliPath = path.resolve(__dirname, 'index.js');
    // Ensure bus is running
    if (!await isBusRunning()) {
        console.log('Starting Graft bus...');
        const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
        spawn(process.execPath, [cliPath, 'start'], { detached: true, stdio: 'ignore' }).unref();
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 300));
            if (await isBusRunning())
                break;
        }
    }
    const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
    if (tasks.length > 0) {
        // Non-interactive: run claude -p "<task>" for each task in parallel
        console.log(`Launching ${tasks.length} agent(s)...\n`);
        const procs = tasks.map((task, i) => {
            const agentId = `agent-${String.fromCharCode(97 + i)}`;
            console.log(`  ${agentId}: ${task}`);
            return spawn('claude', ['-p', task], {
                env: { ...process.env, GRAFT_AGENT_ID: agentId },
                stdio: 'inherit',
            });
        });
        console.log('');
        await Promise.all(procs.map(p => new Promise(r => p.on('close', r))));
        console.log('\nAll agents finished. Run "graft audit" to review what happened.');
    }
    else {
        // Interactive: open N terminal windows, each with GRAFT_AGENT_ID set
        const count = opts.agents ?? 2;
        console.log(`Opening ${count} terminal window(s)...\n`);
        for (let i = 0; i < count; i++) {
            const agentId = `agent-${String.fromCharCode(97 + i)}`;
            const script = `GRAFT_AGENT_ID=${agentId} claude`;
            spawn('osascript', ['-e', `tell application "Terminal" to do script "${script}"`], { stdio: 'ignore' });
            console.log(`  Opened terminal for ${agentId}`);
        }
        console.log(`\nMonitor coordination:\n  graft status\n  graft conflicts list\n  graft audit`);
    }
});
// ── install ───────────────────────────────────────────────────────────────────
program
    .command('install')
    .description('Install Graft hooks for your agent framework')
    .option('--claude-code', 'Install Claude Code preToolUse/postToolUse hooks')
    .option('--mcp', 'Print MCP server config snippet')
    .option('--openai', 'Print OpenAI Agents SDK usage snippet')
    .action(async (opts) => {
    if (opts.claudeCode) {
        const cliPath = path.resolve(__dirname, 'index.js');
        const hookCmd = (sub) => `node ${cliPath} hook ${sub} --tool "$CLAUDE_TOOL_NAME" --input '$CLAUDE_TOOL_INPUT' --agent "\${GRAFT_AGENT_ID:-$CLAUDE_SESSION_ID}"`;
        const settingsDir = path.join(process.cwd(), '.claude');
        const settingsPath = path.join(settingsDir, 'settings.json');
        const hookConfig = {
            hooks: {
                PreToolUse: [{ matcher: 'Write|Edit|Bash|NotebookEdit', hooks: [{ type: 'command', command: hookCmd('pre') }] }],
                PostToolUse: [{ matcher: 'Write|Edit|Bash|NotebookEdit', hooks: [{ type: 'command', command: hookCmd('post') }] }],
            },
        };
        fs.mkdirSync(settingsDir, { recursive: true });
        let existing = {};
        if (fs.existsSync(settingsPath)) {
            try {
                existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            }
            catch { /* ignore */ }
        }
        fs.writeFileSync(settingsPath, JSON.stringify({ ...existing, ...hookConfig }, null, 2));
        console.log(`Wrote hooks to ${settingsPath}`);
    }
    if (opts.mcp) {
        console.log(`Add to your Claude MCP config:\n\n${JSON.stringify({
            mcpServers: { graft: { url: 'http://localhost:7434/mcp' } }
        }, null, 2)}\n\nThen run: graft mcp --port 7434`);
    }
    if (opts.openai) {
        console.log(`import { graftTools } from 'graft/openai'\n\nconst agent = new Agent({\n  tools: [\n    ...graftTools({ busUrl: 'http://localhost:7433', agentId: 'agent-a' }),\n    ...yourOtherTools\n  ]\n})`);
    }
});
// ── hook (called by Claude Code hooks) ────────────────────────────────────────
const hook = program.command('hook').description('Internal: called by Claude Code hooks').addHelpText('before', '(internal — called by hook config, not directly by users)');
hook
    .command('pre')
    .description('preToolUse handler')
    .requiredOption('--tool <name>', 'Tool name')
    .requiredOption('--input <json>', 'Tool input JSON')
    .requiredOption('--agent <id>', 'Agent ID')
    .option('--bus <url>', 'Bus URL')
    .action(async (opts) => {
    const { handlePreToolUse } = await Promise.resolve().then(() => __importStar(require('../adapters/claude-code/hooks')));
    let toolInput = {};
    try {
        toolInput = JSON.parse(opts.input);
    }
    catch { /* ignore */ }
    const result = await handlePreToolUse({
        toolName: opts.tool,
        toolInput,
        agentId: opts.agent,
        busUrl: opts.bus,
    });
    if (!result.proceed) {
        if (result.message)
            process.stdout.write(result.message + '\n');
        process.exit(2); // exit 2 = block the tool call
    }
    if (result.message)
        process.stdout.write(result.message + '\n');
});
hook
    .command('post')
    .description('postToolUse handler')
    .requiredOption('--tool <name>', 'Tool name')
    .requiredOption('--input <json>', 'Tool input JSON')
    .requiredOption('--agent <id>', 'Agent ID')
    .option('--bus <url>', 'Bus URL')
    .action(async (opts) => {
    const { handlePostToolUse } = await Promise.resolve().then(() => __importStar(require('../adapters/claude-code/hooks')));
    let toolInput = {};
    try {
        toolInput = JSON.parse(opts.input);
    }
    catch { /* ignore */ }
    await handlePostToolUse({
        toolName: opts.tool,
        toolInput,
        agentId: opts.agent,
        busUrl: opts.bus,
    });
});
// ── mcp ───────────────────────────────────────────────────────────────────────
program
    .command('mcp')
    .description('Start Graft as an MCP server')
    .option('--port <port>', 'HTTP port (default: 7434; omit for stdio)')
    .option('--bus <url>', 'Graft bus URL (default: http://localhost:7433)')
    .option('--agent <id>', 'Agent ID for this MCP session')
    .action(async (opts) => {
    const { startMcpServer } = await Promise.resolve().then(() => __importStar(require('../adapters/mcp/server')));
    await startMcpServer({
        busUrl: opts.bus,
        agentId: opts.agent,
        transport: opts.port ? 'http' : 'stdio',
        httpPort: opts.port ? Number(opts.port) : undefined,
    });
});
program.parseAsync(process.argv).catch((e) => {
    console.error(e.message);
    process.exit(1);
});
//# sourceMappingURL=index.js.map