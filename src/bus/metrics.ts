import type { AuditLog, AuditEntry } from './audit'
import type { ClaimRegistry } from './registry'
import type { SignalBus } from './signals'
import type { ResourcePool } from './pool'

export interface ContentionEntry {
  resourceId: string
  denials: number
  topRequestingAgents: Array<{ agentId: string; count: number }>
  topBlockingAgents: Array<{ agentId: string; count: number }>
  lastDeniedAt: number
}

export interface AgentRosterEntry {
  agentId: string
  firstSeen: number
  lastSeen: number
  claimsGranted: number
  claimsDenied: number
  signalsPublished: number
  signalsReceived: number
  currentClaims: string[]
  pendingSignals: number
  active: boolean
}

export interface HistogramSummary {
  count: number
  sum: number
  min: number
  max: number
  p50: number
  p95: number
  p99: number
  buckets: Array<{ le: number | '+Inf'; count: number }>
}

export interface MetricsSummary {
  counters: Record<string, number>
  gauges: Record<string, number>
  histograms: Record<string, HistogramSummary>
}

export interface GraphNode {
  id: string
  type: 'agent' | 'resource'
  label: string
}

export interface GraphEdge {
  from: string
  to: string
  type: 'holds' | 'waiting_for'
  intent?: string
  claimType?: string
}

export interface DependencyGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  generatedAt: number
}

export interface AgentEfficiency {
  agentId: string
  claimsGranted: number
  claimsDenied: number
  blockRate: number
  avgBlockedMs: number
  efficiencyScore: number
}

const CLAIM_HOLD_BUCKETS = [100, 500, 1000, 5000, 10000, 30000, 60000, 120000]
const SIGNAL_LATENCY_BUCKETS = [10, 50, 100, 500, 1000, 5000, 10000]
const ACTIVE_WINDOW_MS = 5 * 60 * 1000

function histogramSummary(values: number[], upperBounds: number[]): HistogramSummary {
  if (values.length === 0) {
    return {
      count: 0, sum: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0,
      buckets: [...upperBounds.map(le => ({ le: le as number | '+Inf', count: 0 })), { le: '+Inf' as const, count: 0 }],
    }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const pct = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)]
  const buckets: Array<{ le: number | '+Inf'; count: number }> = upperBounds.map(le => ({
    le,
    count: sorted.filter(v => v <= le).length,
  }))
  buckets.push({ le: '+Inf', count: sorted.length })
  return { count: sorted.length, sum, min: sorted[0], max: sorted[sorted.length - 1], p50: pct(50), p95: pct(95), p99: pct(99), buckets }
}

export class MetricsCollector {
  constructor(
    private audit: AuditLog,
    private registry: ClaimRegistry,
    private signals: SignalBus,
    private pool: ResourcePool,
  ) {}

  private entries(): AuditEntry[] {
    return this.audit.getAll()
  }

  computeCounters(): Record<string, number> {
    const counts: Record<string, number> = {
      claims_granted_total: 0,
      claims_denied_total: 0,
      claims_expired_total: 0,
      claims_released_total: 0,
      signals_published_total: 0,
      signals_delivered_total: 0,
      pool_acquired_total: 0,
      pool_released_total: 0,
      deadlocks_detected_total: 0,
      deadlocks_resolved_total: 0,
    }
    for (const e of this.entries()) {
      switch (e.type) {
        case 'claim_granted':    counts.claims_granted_total++;    break
        case 'claim_denied':     counts.claims_denied_total++;     break
        case 'claim_expired':    counts.claims_expired_total++;    break
        case 'claim_released':   counts.claims_released_total++;   break
        case 'signal_published': counts.signals_published_total++; break
        case 'signal_delivered': counts.signals_delivered_total++; break
        case 'pool_acquired':    counts.pool_acquired_total++;     break
        case 'pool_released':    counts.pool_released_total++;     break
        case 'deadlock_detected':  counts.deadlocks_detected_total++;  break
        case 'deadlock_resolved':  counts.deadlocks_resolved_total++;  break
      }
    }
    return counts
  }

  computeGauges(): Record<string, number> {
    const claims = this.registry.list()
    const gauges: Record<string, number> = {
      active_claims_total: claims.length,
      active_write_claims: claims.filter(c => c.claimType === 'write').length,
      active_read_claims: claims.filter(c => c.claimType === 'read').length,
    }
    for (const name of this.pool.listPools()) {
      const s = this.pool.status(name)
      if (!s) continue
      gauges[`pool_utilization_pct{pool="${name}"}`] = s.total > 0 ? Math.round(s.inUse / s.total * 100) : 0
      gauges[`pool_available{pool="${name}"}`] = s.available
      gauges[`pool_waiters{pool="${name}"}`] = s.waiters
    }
    return gauges
  }

  computeHistograms(): Record<string, HistogramSummary> {
    const grantTimes = new Map<string, number>()     // `${agentId}:${resourceId}` → ts
    const publishTimes = new Map<string, number>()   // signalId → ts
    const holdDurations: number[] = []
    const signalLatencies: number[] = []

    for (const e of this.entries()) {
      if (e.type === 'claim_granted' && e.resourceId) {
        grantTimes.set(`${e.agentId}:${e.resourceId}`, e.ts)
      } else if ((e.type === 'claim_released' || e.type === 'claim_expired') && e.resourceId) {
        const key = `${e.agentId}:${e.resourceId}`
        const grantedAt = grantTimes.get(key)
        if (grantedAt !== undefined) {
          holdDurations.push(e.ts - grantedAt)
          grantTimes.delete(key)
        }
      } else if (e.type === 'signal_published' && e.signalId) {
        publishTimes.set(e.signalId, e.ts)
      } else if (e.type === 'signal_delivered' && e.signalId) {
        const publishedAt = publishTimes.get(e.signalId)
        if (publishedAt !== undefined) {
          signalLatencies.push(e.ts - publishedAt)
          publishTimes.delete(e.signalId)
        }
      }
    }
    return {
      claim_hold_duration_ms: histogramSummary(holdDurations, CLAIM_HOLD_BUCKETS),
      signal_delivery_latency_ms: histogramSummary(signalLatencies, SIGNAL_LATENCY_BUCKETS),
    }
  }

  toJSON(): MetricsSummary {
    return {
      counters: this.computeCounters(),
      gauges: this.computeGauges(),
      histograms: this.computeHistograms(),
    }
  }

  toPrometheus(): string {
    const lines: string[] = []
    const counters = this.computeCounters()
    const gauges = this.computeGauges()
    const histograms = this.computeHistograms()

    const counterHelp: Record<string, string> = {
      claims_granted_total: 'Total resource claims granted',
      claims_denied_total: 'Total resource claims denied (conflicts)',
      claims_expired_total: 'Total resource claims expired via TTL',
      claims_released_total: 'Total resource claims explicitly released',
      signals_published_total: 'Total signals published to the bus',
      signals_delivered_total: 'Total signals delivered to agents',
      pool_acquired_total: 'Total pool resource acquisitions',
      pool_released_total: 'Total pool resource releases',
      deadlocks_detected_total: 'Total deadlock cycles detected',
      deadlocks_resolved_total: 'Total deadlocks resolved',
    }
    for (const [name, value] of Object.entries(counters)) {
      lines.push(`# HELP graft_${name} ${counterHelp[name] ?? name}`)
      lines.push(`# TYPE graft_${name} counter`)
      lines.push(`graft_${name} ${value}`)
      lines.push('')
    }

    const gaugeHelp: Record<string, string> = {
      active_claims_total: 'Currently held resource claims',
      active_write_claims: 'Currently held write claims',
      active_read_claims: 'Currently held read claims',
    }
    for (const [name, value] of Object.entries(gauges)) {
      const baseName = name.includes('{') ? name.split('{')[0] : name
      lines.push(`# HELP graft_${baseName} ${gaugeHelp[baseName] ?? baseName}`)
      lines.push(`# TYPE graft_${baseName} gauge`)
      lines.push(`graft_${name} ${value}`)
      lines.push('')
    }

    const histHelp: Record<string, string> = {
      claim_hold_duration_ms: 'Duration a claim was held, in milliseconds',
      signal_delivery_latency_ms: 'Time between signal publish and delivery, in milliseconds',
    }
    for (const [name, h] of Object.entries(histograms)) {
      lines.push(`# HELP graft_${name} ${histHelp[name] ?? name}`)
      lines.push(`# TYPE graft_${name} histogram`)
      for (const b of h.buckets) {
        lines.push(`graft_${name}_bucket{le="${b.le}"} ${b.count}`)
      }
      lines.push(`graft_${name}_count ${h.count}`)
      lines.push(`graft_${name}_sum ${h.sum}`)
      lines.push('')
    }

    return lines.join('\n')
  }

  computeContention(limit = 20): ContentionEntry[] {
    const stats = new Map<string, {
      count: number; lastTs: number
      requesters: Map<string, number>; blockers: Map<string, number>
    }>()

    for (const e of this.entries()) {
      if (e.type !== 'claim_denied' || !e.resourceId) continue
      if (!stats.has(e.resourceId)) {
        stats.set(e.resourceId, { count: 0, lastTs: 0, requesters: new Map(), blockers: new Map() })
      }
      const s = stats.get(e.resourceId)!
      s.count++
      s.lastTs = Math.max(s.lastTs, e.ts)
      s.requesters.set(e.agentId, (s.requesters.get(e.agentId) ?? 0) + 1)
      const holder = e.detail.holder as string | undefined
      if (holder) s.blockers.set(holder, (s.blockers.get(holder) ?? 0) + 1)
    }

    const topN = (m: Map<string, number>) =>
      Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([agentId, count]) => ({ agentId, count }))

    return Array.from(stats.entries())
      .map(([resourceId, s]) => ({
        resourceId,
        denials: s.count,
        topRequestingAgents: topN(s.requesters),
        topBlockingAgents: topN(s.blockers),
        lastDeniedAt: s.lastTs,
      }))
      .sort((a, b) => b.denials - a.denials)
      .slice(0, limit)
  }

  computeGraph(): DependencyGraph {
    const agentNodes = new Map<string, GraphNode>()
    const resourceNodes = new Map<string, GraphNode>()
    const edges: GraphEdge[] = []

    for (const claim of this.registry.list()) {
      if (!agentNodes.has(claim.agentId)) {
        agentNodes.set(claim.agentId, { id: claim.agentId, type: 'agent', label: claim.agentId })
      }
      if (!resourceNodes.has(claim.resourceId)) {
        resourceNodes.set(claim.resourceId, { id: claim.resourceId, type: 'resource', label: claim.resourceId })
      }
      edges.push({ from: claim.agentId, to: claim.resourceId, type: 'holds', intent: claim.intent, claimType: claim.claimType })
    }

    for (const conflict of this.audit.queryConflicts()) {
      if (conflict.resolution !== 'pending') continue
      const { agentId } = conflict.requestingAgent
      if (!agentNodes.has(agentId)) {
        agentNodes.set(agentId, { id: agentId, type: 'agent', label: agentId })
      }
      if (!resourceNodes.has(conflict.resourceId)) {
        resourceNodes.set(conflict.resourceId, { id: conflict.resourceId, type: 'resource', label: conflict.resourceId })
      }
      edges.push({ from: agentId, to: conflict.resourceId, type: 'waiting_for', intent: conflict.requestingAgent.intent })
    }

    return {
      nodes: [...agentNodes.values(), ...resourceNodes.values()],
      edges,
      generatedAt: Date.now(),
    }
  }

  computeEfficiency(): AgentEfficiency[] {
    const stats = new Map<string, { granted: number; denied: number; blockedMs: number[] }>()

    for (const e of this.entries()) {
      if (e.type !== 'claim_granted' && e.type !== 'claim_denied') continue
      if (!stats.has(e.agentId)) stats.set(e.agentId, { granted: 0, denied: 0, blockedMs: [] })
      const s = stats.get(e.agentId)!
      if (e.type === 'claim_granted') s.granted++
      else s.denied++
    }

    const now = Date.now()
    for (const conflict of this.audit.queryConflicts()) {
      const s = stats.get(conflict.requestingAgent.agentId)
      if (!s) continue
      s.blockedMs.push(conflict.resolvedAt ? conflict.resolvedAt - conflict.ts : now - conflict.ts)
    }

    return Array.from(stats.entries()).map(([agentId, s]) => {
      const total = s.granted + s.denied
      const blockRate = total > 0 ? Math.round((s.denied / total) * 1000) / 10 : 0
      const avgBlockedMs = s.blockedMs.length > 0
        ? Math.round(s.blockedMs.reduce((a, b) => a + b, 0) / s.blockedMs.length)
        : 0
      const efficiencyScore = Math.round((1 - blockRate / 100) * Math.max(0, 1 - avgBlockedMs / 60_000) * 100)
      return { agentId, claimsGranted: s.granted, claimsDenied: s.denied, blockRate, avgBlockedMs, efficiencyScore }
    }).sort((a, b) => b.efficiencyScore - a.efficiencyScore)
  }

  computeAgentRoster(): AgentRosterEntry[] {
    const agentStats = new Map<string, {
      firstSeen: number; lastSeen: number
      granted: number; denied: number; published: number; received: number
    }>()

    for (const e of this.entries()) {
      if (!agentStats.has(e.agentId)) {
        agentStats.set(e.agentId, { firstSeen: e.ts, lastSeen: e.ts, granted: 0, denied: 0, published: 0, received: 0 })
      }
      const s = agentStats.get(e.agentId)!
      if (e.ts < s.firstSeen) s.firstSeen = e.ts
      if (e.ts > s.lastSeen) s.lastSeen = e.ts
      if (e.type === 'claim_granted')    s.granted++
      else if (e.type === 'claim_denied')     s.denied++
      else if (e.type === 'signal_published') s.published++
      else if (e.type === 'signal_delivered') s.received++
    }

    const claimsByAgent = new Map<string, string[]>()
    for (const c of this.registry.list()) {
      if (!claimsByAgent.has(c.agentId)) claimsByAgent.set(c.agentId, [])
      claimsByAgent.get(c.agentId)!.push(c.resourceId)
    }

    const now = Date.now()
    return Array.from(agentStats.entries())
      .map(([agentId, s]) => {
        const currentClaims = claimsByAgent.get(agentId) ?? []
        return {
          agentId,
          firstSeen: s.firstSeen,
          lastSeen: s.lastSeen,
          claimsGranted: s.granted,
          claimsDenied: s.denied,
          signalsPublished: s.published,
          signalsReceived: s.received,
          currentClaims,
          pendingSignals: this.signals.peekPending(agentId).length,
          active: currentClaims.length > 0 || now - s.lastSeen < ACTIVE_WINDOW_MS,
        }
      })
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }
}
