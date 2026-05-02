import Fastify from 'fastify'
import cors from '@fastify/cors'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { AuditLog, AuditEventType } from './audit'
import { ClaimRegistry } from './registry'
import { SignalBus } from './signals'
import { ResourcePool } from './pool'
import { DeadlockDetector } from './deadlock'

interface GraftConfig {
  bus: { port: number; backend: string; audit_max_entries: number; audit_enabled: boolean }
  agents: { heartbeat_interval: number; claim_ttl: number }
  pools: Record<string, { resources: string[] }>
  waves: Record<string, { agents: string[]; merge_gate: 'all_complete' | 'majority' | 'any' }>
}

interface WaveState {
  agents: string[]
  completed: Set<string>
  mergeGate: 'all_complete' | 'majority' | 'any'
}

function loadConfig(configPath?: string): GraftConfig {
  const defaults: GraftConfig = {
    bus: { port: 7433, backend: 'memory', audit_max_entries: 10_000, audit_enabled: true },
    agents: { heartbeat_interval: 30, claim_ttl: 120 },
    pools: {},
    waves: {},
  }

  const candidates = [
    configPath,
    path.join(process.cwd(), 'graft.config.yaml'),
    path.join(process.cwd(), 'graft.config.yml'),
  ].filter(Boolean) as string[]

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = yaml.load(fs.readFileSync(p, 'utf8')) as Partial<GraftConfig>
        return {
          bus: { ...defaults.bus, ...(raw.bus ?? {}) },
          agents: { ...defaults.agents, ...(raw.agents ?? {}) },
          pools: raw.pools ?? {},
          waves: raw.waves ?? {},
        }
      } catch {
        // fall through to defaults
      }
    }
  }

  return defaults
}

export async function createServer(configPath?: string) {
  const config = loadConfig(configPath)

  const audit = new AuditLog(config.bus.audit_max_entries, config.bus.audit_enabled)
  const registry = new ClaimRegistry(audit, config.agents.claim_ttl)
  const signals = new SignalBus(audit)
  const pool = new ResourcePool(audit)
  const deadlock = new DeadlockDetector(audit, registry)

  for (const [name, cfg] of Object.entries(config.pools)) {
    pool.register(name, { resources: cfg.resources.map(String) })
  }

  const waves: Map<string, WaveState> = new Map()
  for (const [name, cfg] of Object.entries(config.waves)) {
    waves.set(name, {
      agents: cfg.agents,
      completed: new Set(),
      mergeGate: cfg.merge_gate,
    })
  }

  const startedAt = Date.now()

  const app = Fastify({ logger: false })
  await app.register(cors)

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    claims: registry.list().length,
    ts: Date.now(),
  }))

  // ── Claims ───────────────────────────────────────────────────────────────

  app.post<{ Body: { resource_id: string; agent_id: string; intent: string; ttl?: number; claim_type?: 'write' | 'read' } }>(
    '/claims',
    async (req, reply) => {
      const { resource_id, agent_id, intent, ttl, claim_type } = req.body
      if (!resource_id || !agent_id || !intent) {
        return reply.code(400).send({ error: 'resource_id, agent_id, and intent are required' })
      }
      const result = registry.claim({ resourceId: resource_id, agentId: agent_id, intent, ttl, claimType: claim_type })
      if (!result.granted) {
        // Register the wait edge for deadlock detection
        deadlock.recordWait(agent_id, resource_id, result.holder!.agentId)
      }
      return result
    }
  )

  app.delete<{ Params: { resource_id: string }; Querystring: { agent_id: string } }>(
    '/claims/:resource_id',
    async (req, reply) => {
      const { resource_id } = req.params
      const { agent_id } = req.query
      if (!agent_id) return reply.code(400).send({ error: 'agent_id query param required' })
      deadlock.clearWait(agent_id)
      const released = registry.release(decodeURIComponent(resource_id), agent_id)
      return { released }
    }
  )

  app.get('/claims', async () => registry.list())

  app.get<{ Params: { resource_id: string } }>('/claims/:resource_id', async (req) => {
    return registry.get(decodeURIComponent(req.params.resource_id)) ?? null
  })

  app.post<{ Params: { resource_id: string }; Body: { agent_id: string } }>(
    '/claims/:resource_id/heartbeat',
    async (req, reply) => {
      const ok = registry.heartbeat(decodeURIComponent(req.params.resource_id), req.body.agent_id)
      if (!ok) return reply.code(404).send({ error: 'Claim not found or not owned by agent' })
      return { ok }
    }
  )

  // ── Signals ───────────────────────────────────────────────────────────────

  app.post<{ Body: { type: string; from: string; message: string; affected_resources?: string[]; severity?: 'low' | 'medium' | 'high' | 'critical' } }>(
    '/signals',
    async (req, reply) => {
      const { type, from, message, affected_resources, severity } = req.body
      if (!type || !from || !message) {
        return reply.code(400).send({ error: 'type, from, and message are required' })
      }
      return signals.publish({ type, from, message, affectedResources: affected_resources, severity })
    }
  )

  app.get<{ Querystring: { agent_id: string; peek?: string } }>(
    '/signals/pending',
    async (req, reply) => {
      const { agent_id, peek } = req.query
      if (!agent_id) return reply.code(400).send({ error: 'agent_id query param required' })
      return peek === 'true' ? signals.peekPending(agent_id) : signals.getPending(agent_id)
    }
  )

  app.post<{ Body: { agent_id: string; types: string[] } }>(
    '/signals/subscribe',
    async (req, reply) => {
      const { agent_id, types } = req.body
      if (!agent_id || !types) return reply.code(400).send({ error: 'agent_id and types are required' })
      signals.subscribe(agent_id, types)
      return { ok: true }
    }
  )

  app.get<{ Querystring: { agent?: string; from?: string; type?: string } }>(
    '/signals/history',
    async (req) => signals.getHistory({ agentId: req.query.agent, from: req.query.from, type: req.query.type })
  )

  // ── Pool ─────────────────────────────────────────────────────────────────

  app.post<{ Params: { pool_name: string }; Body: { agent_id: string; timeout_ms?: number } }>(
    '/pool/:pool_name/acquire',
    async (req, reply) => {
      try {
        const resource = await pool.acquire(req.params.pool_name, req.body.agent_id, req.body.timeout_ms)
        return { acquired: true, resource }
      } catch (err: unknown) {
        return reply.code(503).send({ acquired: false, error: (err as Error).message })
      }
    }
  )

  app.delete<{ Params: { pool_name: string }; Body: { agent_id: string; resource: string } }>(
    '/pool/:pool_name/release',
    async (req, reply) => {
      const released = pool.release(req.params.pool_name, req.body.agent_id, req.body.resource)
      if (!released) return reply.code(404).send({ error: 'Resource not found or not owned by agent' })
      return { released }
    }
  )

  app.get<{ Params: { pool_name: string } }>('/pool/:pool_name/status', async (req, reply) => {
    const status = pool.status(req.params.pool_name)
    if (!status) return reply.code(404).send({ error: `Pool '${req.params.pool_name}' not found` })
    return status
  })

  // ── Wave ─────────────────────────────────────────────────────────────────

  app.post<{ Body: { name: string; agent_id: string; agents?: string[]; merge_gate?: 'all_complete' | 'majority' | 'any' } }>(
    '/wave/register',
    async (req) => {
      const { name, agent_id, agents, merge_gate } = req.body
      if (!waves.has(name)) {
        waves.set(name, {
          agents: agents ?? [agent_id],
          completed: new Set(),
          mergeGate: merge_gate ?? 'all_complete',
        })
      } else {
        const wave = waves.get(name)!
        if (!wave.agents.includes(agent_id)) wave.agents.push(agent_id)
      }
      return { ok: true }
    }
  )

  app.post<{ Body: { name: string; agent_id: string } }>('/wave/complete', async (req, reply) => {
    const wave = waves.get(req.body.name)
    if (!wave) return reply.code(404).send({ error: `Wave '${req.body.name}' not found` })
    wave.completed.add(req.body.agent_id)
    return { ok: true, done: isWaveDone(wave) }
  })

  app.get<{ Params: { name: string } }>('/wave/:name', async (req, reply) => {
    const wave = waves.get(req.params.name)
    if (!wave) return reply.code(404).send({ error: `Wave '${req.params.name}' not found` })
    return {
      name: req.params.name,
      agents: wave.agents,
      completed: Array.from(wave.completed),
      pending: wave.agents.filter(a => !wave.completed.has(a)),
      done: isWaveDone(wave),
    }
  })

  // ── Audit ─────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { agent?: string; resource?: string; type?: string; since?: string; limit?: string } }>(
    '/audit',
    async (req) => {
      return audit.query({
        agentId: req.query.agent,
        resourceId: req.query.resource,
        type: req.query.type as AuditEventType | undefined,
        since: req.query.since ? Number(req.query.since) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      })
    }
  )

  // ── Conflicts ─────────────────────────────────────────────────────────────

  app.get<{ Querystring: { agent?: string; resource?: string } }>('/conflicts', async (req) =>
    audit.queryConflicts({ agentId: req.query.agent, resourceId: req.query.resource })
  )

  app.get<{ Params: { conflict_id: string } }>('/conflicts/:conflict_id', async (req, reply) => {
    const entry = audit.getConflict(req.params.conflict_id)
    if (!entry) return reply.code(404).send({ error: 'Conflict not found' })
    return entry
  })

  // ── Deadlocks ─────────────────────────────────────────────────────────────

  app.get('/deadlocks', async () => audit.queryDeadlocks())

  app.get<{ Params: { deadlock_id: string } }>('/deadlocks/:deadlock_id', async (req, reply) => {
    const entry = audit.getDeadlock(req.params.deadlock_id)
    if (!entry) return reply.code(404).send({ error: 'Deadlock not found' })
    return entry
  })

  // ── Timeline ──────────────────────────────────────────────────────────────

  app.get<{ Params: { agent_id: string }; Querystring: { since?: string } }>(
    '/timeline/:agent_id',
    async (req) => {
      const entries = audit.getTimeline(
        req.params.agent_id,
        req.query.since ? Number(req.query.since) : undefined
      )
      if (entries.length === 0) return []
      const sessionStart = { ...entries[0], type: 'session_start' as AuditEventType }
      const sessionEnd = { ...entries[entries.length - 1], type: 'session_end' as AuditEventType }
      return [sessionStart, ...entries, sessionEnd]
    }
  )

  return { app, registry, signals, pool, deadlock, audit, config }
}

function isWaveDone(wave: WaveState): boolean {
  switch (wave.mergeGate) {
    case 'all_complete':
      return wave.agents.every(a => wave.completed.has(a))
    case 'majority':
      return wave.completed.size > wave.agents.length / 2
    case 'any':
      return wave.completed.size > 0
  }
}

export async function startServer(port?: number, configPath?: string): Promise<void> {
  const { app, registry, deadlock, config } = await createServer(configPath)
  const listenPort = port ?? config.bus.port

  await app.listen({ port: listenPort, host: '127.0.0.1' })
  console.log(`Graft bus listening on http://127.0.0.1:${listenPort}`)

  const shutdown = () => {
    registry.stop()
    deadlock.stop()
    app.close().then(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
