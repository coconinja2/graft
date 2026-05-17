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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
exports.startServer = startServer;
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("js-yaml"));
const audit_1 = require("./audit");
const registry_1 = require("./registry");
const signals_1 = require("./signals");
const pool_1 = require("./pool");
const deadlock_1 = require("./deadlock");
const metrics_1 = require("./metrics");
const healer_1 = require("./healer");
function loadConfig(configPath) {
    const defaults = {
        bus: { port: 7433, backend: 'memory', audit_max_entries: 10000, audit_enabled: true },
        agents: { heartbeat_interval: 30, claim_ttl: 120 },
        healer: { enabled: true, interval_ms: 15000, starvation_threshold_ms: 30000, auto_heal: true },
        pools: {},
        waves: {},
    };
    const candidates = [
        configPath,
        path.join(process.cwd(), 'graft.config.yaml'),
        path.join(process.cwd(), 'graft.config.yml'),
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                const raw = yaml.load(fs.readFileSync(p, 'utf8'));
                return {
                    bus: { ...defaults.bus, ...(raw.bus ?? {}) },
                    agents: { ...defaults.agents, ...(raw.agents ?? {}) },
                    healer: { ...defaults.healer, ...(raw.healer ?? {}) },
                    pools: raw.pools ?? {},
                    waves: raw.waves ?? {},
                };
            }
            catch {
                // fall through to defaults
            }
        }
    }
    return defaults;
}
async function createServer(configPath) {
    const config = loadConfig(configPath);
    const audit = new audit_1.AuditLog(config.bus.audit_max_entries, config.bus.audit_enabled);
    const registry = new registry_1.ClaimRegistry(audit, config.agents.claim_ttl);
    const signals = new signals_1.SignalBus(audit);
    const pool = new pool_1.ResourcePool(audit);
    const deadlock = new deadlock_1.DeadlockDetector(audit, registry);
    for (const [name, cfg] of Object.entries(config.pools)) {
        pool.register(name, { resources: cfg.resources.map(String) });
    }
    const waves = new Map();
    for (const [name, cfg] of Object.entries(config.waves)) {
        waves.set(name, {
            agents: cfg.agents,
            completed: new Set(),
            mergeGate: cfg.merge_gate,
        });
    }
    const startedAt = Date.now();
    const metrics = new metrics_1.MetricsCollector(audit, registry, signals, pool);
    const healer = new healer_1.SelfHealer(audit, registry, {
        enabled: config.healer.enabled,
        intervalMs: config.healer.interval_ms,
        starvationThresholdMs: config.healer.starvation_threshold_ms,
        autoHeal: config.healer.auto_heal,
    });
    const app = (0, fastify_1.default)({
        logger: {
            transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
        },
    });
    await app.register(cors_1.default);
    // ── Health ──────────────────────────────────────────────────────────────
    app.get('/health', async () => ({
        status: 'ok',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        claims: registry.list().length,
        ts: Date.now(),
    }));
    // ── Claims ───────────────────────────────────────────────────────────────
    app.post('/claims', async (req, reply) => {
        const { resource_id, agent_id, intent, ttl, claim_type, wait, line_start, line_end } = req.body;
        if (!resource_id || !agent_id || !intent) {
            return reply.code(400).send({ error: 'resource_id, agent_id, and intent are required' });
        }
        const lineRange = (line_start != null && line_end != null) ? { start: line_start, end: line_end } : undefined;
        const result = registry.claim({ resourceId: resource_id, agentId: agent_id, intent, ttl, claimType: claim_type, lineRange });
        if (!result.granted && wait) {
            deadlock.recordWait(agent_id, resource_id, result.holder.agentId);
        }
        return result;
    });
    app.delete('/claims/:resource_id', async (req, reply) => {
        const { resource_id } = req.params;
        const { agent_id, line_start, line_end } = req.query;
        if (!agent_id)
            return reply.code(400).send({ error: 'agent_id query param required' });
        deadlock.clearWait(agent_id);
        const lineRange = (line_start != null && line_end != null)
            ? { start: Number(line_start), end: Number(line_end) }
            : undefined;
        const released = registry.release(decodeURIComponent(resource_id), agent_id, lineRange);
        return { released };
    });
    // Release a specific claim by its UUID (more precise than by resource+agent)
    app.delete('/claim/:claim_id', async (req, reply) => {
        const { agent_id } = req.query;
        if (!agent_id)
            return reply.code(400).send({ error: 'agent_id query param required' });
        deadlock.clearWait(agent_id);
        const released = registry.releaseById(req.params.claim_id, agent_id);
        return { released };
    });
    app.get('/claims', async () => registry.list());
    // Returns all active claims on a resource as an array (multiple non-overlapping line-range claims possible)
    app.get('/claims/:resource_id', async (req) => {
        return registry.get(decodeURIComponent(req.params.resource_id));
    });
    app.get('/claims/:resource_id/wait', async (req, reply) => {
        const resourceId = decodeURIComponent(req.params.resource_id);
        const timeoutMs = Math.min(Number(req.query.timeout_ms ?? 30000), 300000);
        if (registry.get(resourceId).length === 0) {
            return { released: true, resourceId };
        }
        return new Promise((resolve) => {
            const cancel = registry.addWaiter(resourceId, () => {
                clearTimeout(timer);
                resolve({ released: true, resourceId });
            });
            const timer = setTimeout(() => {
                cancel();
                reply.code(408).send({ error: 'timeout waiting for release', resourceId });
            }, timeoutMs);
        });
    });
    app.post('/claims/:resource_id/heartbeat', async (req, reply) => {
        const ok = registry.heartbeat(decodeURIComponent(req.params.resource_id), req.body.agent_id);
        if (!ok)
            return reply.code(404).send({ error: 'Claim not found or not owned by agent' });
        return { ok };
    });
    // ── Agent liveness ───────────────────────────────────────────────────────
    app.delete('/agents/:agent_id/claims', async (req) => {
        const agentId = req.params.agent_id;
        const released = registry.forceReleaseAgent(agentId);
        return { agentId, released, count: released.length };
    });
    // ── Signals ───────────────────────────────────────────────────────────────
    app.post('/signals', async (req, reply) => {
        const { type, from, message, affected_resources, severity, change_context } = req.body;
        if (!type || !from || !message) {
            return reply.code(400).send({ error: 'type, from, and message are required' });
        }
        return signals.publish({ type, from, message, affectedResources: affected_resources, severity, changeContext: change_context });
    });
    app.get('/signals/pending', async (req, reply) => {
        const { agent_id, peek } = req.query;
        if (!agent_id)
            return reply.code(400).send({ error: 'agent_id query param required' });
        return peek === 'true' ? signals.peekPending(agent_id) : signals.getPending(agent_id);
    });
    app.post('/signals/subscribe', async (req, reply) => {
        const { agent_id, types } = req.body;
        if (!agent_id || !types)
            return reply.code(400).send({ error: 'agent_id and types are required' });
        signals.subscribe(agent_id, types);
        return { ok: true };
    });
    app.get('/signals/history', async (req) => signals.getHistory({ agentId: req.query.agent, from: req.query.from, type: req.query.type }));
    // ── Pool ─────────────────────────────────────────────────────────────────
    app.post('/pool/:pool_name/acquire', async (req, reply) => {
        try {
            const resource = await pool.acquire(req.params.pool_name, req.body.agent_id, req.body.timeout_ms);
            return { acquired: true, resource };
        }
        catch (err) {
            return reply.code(503).send({ acquired: false, error: err.message });
        }
    });
    app.delete('/pool/:pool_name/release', async (req, reply) => {
        const released = pool.release(req.params.pool_name, req.body.agent_id, req.body.resource);
        if (!released)
            return reply.code(404).send({ error: 'Resource not found or not owned by agent' });
        return { released };
    });
    app.get('/pool/:pool_name/status', async (req, reply) => {
        const status = pool.status(req.params.pool_name);
        if (!status)
            return reply.code(404).send({ error: `Pool '${req.params.pool_name}' not found` });
        return status;
    });
    // ── Wave ─────────────────────────────────────────────────────────────────
    app.post('/wave/register', async (req) => {
        const { name, agent_id, agents, merge_gate } = req.body;
        if (!waves.has(name)) {
            waves.set(name, {
                agents: agents ?? [agent_id],
                completed: new Set(),
                mergeGate: merge_gate ?? 'all_complete',
            });
        }
        else {
            const wave = waves.get(name);
            if (!wave.agents.includes(agent_id))
                wave.agents.push(agent_id);
        }
        return { ok: true };
    });
    app.post('/wave/complete', async (req, reply) => {
        const wave = waves.get(req.body.name);
        if (!wave)
            return reply.code(404).send({ error: `Wave '${req.body.name}' not found` });
        wave.completed.add(req.body.agent_id);
        return { ok: true, done: isWaveDone(wave) };
    });
    app.get('/wave/:name', async (req, reply) => {
        const wave = waves.get(req.params.name);
        if (!wave)
            return reply.code(404).send({ error: `Wave '${req.params.name}' not found` });
        return {
            name: req.params.name,
            agents: wave.agents,
            completed: Array.from(wave.completed),
            pending: wave.agents.filter(a => !wave.completed.has(a)),
            done: isWaveDone(wave),
        };
    });
    // ── Audit ─────────────────────────────────────────────────────────────────
    app.get('/audit', async (req) => {
        return audit.query({
            agentId: req.query.agent,
            resourceId: req.query.resource,
            type: req.query.type,
            since: req.query.since ? Number(req.query.since) : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
    });
    // ── Conflicts ─────────────────────────────────────────────────────────────
    app.get('/conflicts', async (req) => audit.queryConflicts({ agentId: req.query.agent, resourceId: req.query.resource }));
    app.get('/conflicts/:conflict_id', async (req, reply) => {
        const entry = audit.getConflict(req.params.conflict_id);
        if (!entry)
            return reply.code(404).send({ error: 'Conflict not found' });
        return entry;
    });
    // ── Deadlocks ─────────────────────────────────────────────────────────────
    app.get('/deadlocks', async () => audit.queryDeadlocks());
    app.get('/deadlocks/:deadlock_id', async (req, reply) => {
        const entry = audit.getDeadlock(req.params.deadlock_id);
        if (!entry)
            return reply.code(404).send({ error: 'Deadlock not found' });
        return entry;
    });
    // ── Timeline ──────────────────────────────────────────────────────────────
    app.get('/timeline/:agent_id', async (req) => {
        const entries = audit.getTimeline(req.params.agent_id, req.query.since ? Number(req.query.since) : undefined);
        if (entries.length === 0)
            return [];
        const sessionStart = { ...entries[0], type: 'session_start' };
        const sessionEnd = { ...entries[entries.length - 1], type: 'session_end' };
        return [sessionStart, ...entries, sessionEnd];
    });
    // ── Metrics ───────────────────────────────────────────────────────────────
    app.get('/metrics', async (req, reply) => {
        if (req.query.format === 'json') {
            return metrics.toJSON();
        }
        reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        return metrics.toPrometheus();
    });
    // ── Audit stream (SSE) ────────────────────────────────────────────────────
    app.get('/audit/stream', (req, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        reply.raw.write(':ok\n\n');
        const unsubscribe = audit.onAppend((entry) => {
            if (!reply.raw.destroyed) {
                reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
            }
        });
        reply.raw.on('close', () => unsubscribe());
    });
    // ── Contention heatmap ────────────────────────────────────────────────────
    app.get('/stats/contention', async (req) => metrics.computeContention(req.query.limit ? Number(req.query.limit) : 20));
    // ── Dependency graph ──────────────────────────────────────────────────────
    app.get('/graph', async () => metrics.computeGraph());
    // ── Coordination efficiency ───────────────────────────────────────────────
    app.get('/stats/efficiency', async () => metrics.computeEfficiency());
    // ── Agent roster ──────────────────────────────────────────────────────────
    app.get('/agents', async () => metrics.computeAgentRoster());
    // ── Dashboard UI ──────────────────────────────────────────────────────────
    app.get('/dashboard', async (_req, reply) => {
        const candidates = [
            path.join(__dirname, '..', 'dashboard', 'index.html'),
            path.join(process.cwd(), 'src', 'dashboard', 'index.html'),
        ];
        const dashPath = candidates.find(p => fs.existsSync(p));
        if (!dashPath)
            return reply.code(404).send('Dashboard not found — run npm run build first');
        reply.header('Content-Type', 'text/html; charset=utf-8');
        return fs.createReadStream(dashPath);
    });
    return { app, registry, signals, pool, deadlock, audit, metrics, healer, config };
}
function isWaveDone(wave) {
    switch (wave.mergeGate) {
        case 'all_complete':
            return wave.agents.every(a => wave.completed.has(a));
        case 'majority':
            return wave.completed.size > wave.agents.length / 2;
        case 'any':
            return wave.completed.size > 0;
    }
}
async function startServer(port, configPath) {
    const { app, registry, deadlock, healer, config } = await createServer(configPath);
    const listenPort = port ?? config.bus.port;
    await app.listen({ port: listenPort, host: '127.0.0.1' });
    console.log(`Graft bus listening on http://127.0.0.1:${listenPort}`);
    console.log(`Dashboard:    http://127.0.0.1:${listenPort}/dashboard`);
    healer.start();
    const shutdown = () => {
        healer.stop();
        registry.stop();
        deadlock.stop();
        app.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
//# sourceMappingURL=server.js.map