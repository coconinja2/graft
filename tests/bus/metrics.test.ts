import { AuditLog } from '../../src/bus/audit'
import { ClaimRegistry } from '../../src/bus/registry'
import { SignalBus } from '../../src/bus/signals'
import { ResourcePool } from '../../src/bus/pool'
import { MetricsCollector } from '../../src/bus/metrics'

function makeStack() {
  const audit = new AuditLog()
  const registry = new ClaimRegistry(audit, 120)
  const signals = new SignalBus(audit)
  const pool = new ResourcePool(audit)
  const metrics = new MetricsCollector(audit, registry, signals, pool)
  return { audit, registry, signals, pool, metrics }
}

afterEach(() => {
  jest.useRealTimers()
})

// ── Counters ──────────────────────────────────────────────────────────────────

describe('MetricsCollector.computeCounters', () => {
  test('starts at zero', () => {
    const { metrics } = makeStack()
    const c = metrics.computeCounters()
    expect(c.claims_granted_total).toBe(0)
    expect(c.claims_denied_total).toBe(0)
    expect(c.signals_published_total).toBe(0)
  })

  test('counts claims granted and denied', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'x' })
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-b', intent: 'y' }) // denied
    const c = metrics.computeCounters()
    expect(c.claims_granted_total).toBe(1)
    expect(c.claims_denied_total).toBe(1)
    registry.stop()
  })

  test('counts signals published and delivered', () => {
    const { signals, metrics } = makeStack()
    signals.subscribe('agent-b', ['change_summary'])
    const sig = signals.publish({ type: 'change_summary', from: 'agent-a', message: 'hi' })
    signals.getPending('agent-b') // marks as delivered

    const c = metrics.computeCounters()
    expect(c.signals_published_total).toBe(1)
    expect(c.signals_delivered_total).toBe(1)
    void sig
  })

  test('counts pool acquired and released', () => {
    const { pool, metrics } = makeStack()
    pool.register('db', { resources: ['pg://1'] })
    pool.acquire('db', 'agent-a').then(r => pool.release('db', 'agent-a', r))

    return new Promise<void>(resolve => setTimeout(() => {
      const c = metrics.computeCounters()
      expect(c.pool_acquired_total).toBe(1)
      expect(c.pool_released_total).toBe(1)
      resolve()
    }, 10))
  })

  test('counts expired claims via TTL cleanup', () => {
    jest.useFakeTimers()
    const audit = new AuditLog()
    const registry = new ClaimRegistry(audit, 1) // 1s TTL
    const signals = new SignalBus(audit)
    const pool = new ResourcePool(audit)
    const metrics = new MetricsCollector(audit, registry, signals, pool)

    registry.claim({ resourceId: 'b.ts', agentId: 'agent-a', intent: 'x', ttl: 1 })
    jest.advanceTimersByTime(15_000) // trigger cleanup loop
    const c = metrics.computeCounters()
    expect(c.claims_expired_total).toBe(1)
    registry.stop()
  })
})

// ── Gauges ────────────────────────────────────────────────────────────────────

describe('MetricsCollector.computeGauges', () => {
  test('reflects current active claims', () => {
    const { registry, metrics } = makeStack()
    expect(metrics.computeGauges().active_claims_total).toBe(0)
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'x' })
    expect(metrics.computeGauges().active_claims_total).toBe(1)
    registry.release('a.ts', 'agent-a')
    expect(metrics.computeGauges().active_claims_total).toBe(0)
    registry.stop()
  })

  test('reflects pool utilization', () => {
    const { pool, metrics } = makeStack()
    pool.register('ports', { resources: ['3001', '3002'] })
    expect(metrics.computeGauges()['pool_utilization_pct{pool="ports"}']).toBe(0)
    pool.acquire('ports', 'agent-a')
    expect(metrics.computeGauges()['pool_utilization_pct{pool="ports"}']).toBe(50)
  })

  test('separates write and read claim gauges', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'write', claimType: 'write' })
    registry.claim({ resourceId: 'b.ts', agentId: 'agent-b', intent: 'read', claimType: 'read' })
    const g = metrics.computeGauges()
    expect(g.active_write_claims).toBe(1)
    expect(g.active_read_claims).toBe(1)
    registry.stop()
  })
})

// ── Histograms ────────────────────────────────────────────────────────────────

describe('MetricsCollector.computeHistograms', () => {
  test('returns zero-count histograms when no claims have completed', () => {
    const { metrics } = makeStack()
    const h = metrics.computeHistograms()
    expect(h.claim_hold_duration_ms.count).toBe(0)
    expect(h.signal_delivery_latency_ms.count).toBe(0)
  })

  test('records claim hold duration after release', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'x' })
    registry.release('a.ts', 'agent-a')
    const h = metrics.computeHistograms()
    expect(h.claim_hold_duration_ms.count).toBe(1)
    expect(h.claim_hold_duration_ms.sum).toBeGreaterThanOrEqual(0)
    registry.stop()
  })

  test('records signal delivery latency', () => {
    const { signals, metrics } = makeStack()
    signals.subscribe('agent-b', ['interface_change'])
    signals.publish({ type: 'interface_change', from: 'agent-a', message: 'AuthConfig changed' })
    signals.getPending('agent-b')
    const h = metrics.computeHistograms()
    expect(h.signal_delivery_latency_ms.count).toBe(1)
    expect(h.signal_delivery_latency_ms.sum).toBeGreaterThanOrEqual(0)
  })

  test('bucket counts are cumulative and monotonically increasing', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'x.ts', agentId: 'agent-a', intent: 'x' })
    registry.release('x.ts', 'agent-a')
    const buckets = metrics.computeHistograms().claim_hold_duration_ms.buckets
    let prev = -1
    for (const b of buckets) {
      expect(b.count).toBeGreaterThanOrEqual(prev)
      prev = b.count
    }
    registry.stop()
  })
})

// ── toPrometheus ──────────────────────────────────────────────────────────────

describe('MetricsCollector.toPrometheus', () => {
  test('output contains required metric names', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'x' })
    const out = metrics.toPrometheus()
    expect(out).toContain('graft_claims_granted_total')
    expect(out).toContain('graft_claims_denied_total')
    expect(out).toContain('graft_active_claims_total')
    expect(out).toContain('graft_claim_hold_duration_ms_bucket')
    expect(out).toContain('graft_signal_delivery_latency_ms_bucket')
    registry.stop()
  })

  test('counter values are correct in Prometheus output', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'x' })
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-b', intent: 'y' }) // denied
    const out = metrics.toPrometheus()
    expect(out).toContain('graft_claims_granted_total 1')
    expect(out).toContain('graft_claims_denied_total 1')
    registry.stop()
  })

  test('histogram contains +Inf bucket', () => {
    const { metrics } = makeStack()
    const out = metrics.toPrometheus()
    expect(out).toContain('le="+Inf"')
  })

  test('TYPE declarations are present for each metric family', () => {
    const { metrics } = makeStack()
    const out = metrics.toPrometheus()
    expect(out).toContain('# TYPE graft_claims_granted_total counter')
    expect(out).toContain('# TYPE graft_active_claims_total gauge')
    expect(out).toContain('# TYPE graft_claim_hold_duration_ms histogram')
  })
})

// ── Contention ────────────────────────────────────────────────────────────────

describe('MetricsCollector.computeContention', () => {
  test('returns empty when no denials', () => {
    const { metrics } = makeStack()
    expect(metrics.computeContention()).toEqual([])
  })

  test('aggregates denials by resource and sorts by count descending', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'hot.ts', agentId: 'agent-a', intent: 'hold' })
    registry.claim({ resourceId: 'hot.ts', agentId: 'agent-b', intent: 'req1' }) // denied
    registry.claim({ resourceId: 'hot.ts', agentId: 'agent-c', intent: 'req2' }) // denied
    registry.claim({ resourceId: 'cool.ts', agentId: 'agent-d', intent: 'hold' })
    registry.claim({ resourceId: 'cool.ts', agentId: 'agent-e', intent: 'req' }) // denied

    const list = metrics.computeContention()
    expect(list[0].resourceId).toBe('hot.ts')
    expect(list[0].denials).toBe(2)
    expect(list[1].resourceId).toBe('cool.ts')
    expect(list[1].denials).toBe(1)
    registry.stop()
  })

  test('top requesting agents populated', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'shared.ts', agentId: 'holder', intent: 'hold' })
    registry.claim({ resourceId: 'shared.ts', agentId: 'requester', intent: 'want' })
    registry.claim({ resourceId: 'shared.ts', agentId: 'requester', intent: 'want again' }) // granted after re-claim; ok if same resource different agent path

    const list = metrics.computeContention()
    // At least one entry for shared.ts
    const entry = list.find(e => e.resourceId === 'shared.ts')
    expect(entry).toBeDefined()
    expect(entry!.topRequestingAgents.length).toBeGreaterThan(0)
    registry.stop()
  })

  test('respects limit parameter', () => {
    const { registry, metrics } = makeStack()
    for (let i = 0; i < 5; i++) {
      registry.claim({ resourceId: `file${i}.ts`, agentId: 'holder', intent: 'hold' })
      registry.claim({ resourceId: `file${i}.ts`, agentId: 'requester', intent: 'want' })
    }
    expect(metrics.computeContention(3).length).toBe(3)
    registry.stop()
  })
})

// ── Agent roster ──────────────────────────────────────────────────────────────

describe('MetricsCollector.computeAgentRoster', () => {
  test('returns empty when no events', () => {
    const { metrics } = makeStack()
    expect(metrics.computeAgentRoster()).toEqual([])
  })

  test('records first/last seen and claim counts per agent', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'x' })
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-b', intent: 'y' }) // denied — agent-b also recorded

    const roster = metrics.computeAgentRoster()
    const a = roster.find(r => r.agentId === 'agent-a')
    const b = roster.find(r => r.agentId === 'agent-b')
    expect(a?.claimsGranted).toBe(1)
    expect(b?.claimsDenied).toBe(1)
    expect(a?.firstSeen).toBeGreaterThan(0)
    registry.stop()
  })

  test('marks agent active when it holds a current claim', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'x' })
    const a = metrics.computeAgentRoster().find(r => r.agentId === 'agent-a')
    expect(a?.active).toBe(true)
    expect(a?.currentClaims).toContain('a.ts')
    registry.stop()
  })

  test('includes pending signal count', () => {
    const { signals, metrics } = makeStack()
    signals.subscribe('agent-b', ['change_summary'])
    // agent-b needs an audit entry so it appears in the roster
    signals.publish({ type: 'change_summary', from: 'agent-b', message: 'from b' })
    // this publish goes to agent-b's queue (from agent-a)
    signals.publish({ type: 'change_summary', from: 'agent-a', message: 'done' })
    // don't drain — agent-b should show 1 pending signal
    const roster = metrics.computeAgentRoster()
    const b = roster.find(r => r.agentId === 'agent-b')
    expect(b).toBeDefined()
    expect(b!.pendingSignals).toBe(1)
  })

  test('sorted by lastSeen descending', () => {
    const { registry, metrics } = makeStack()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-z', intent: 'x' })
    registry.claim({ resourceId: 'b.ts', agentId: 'agent-a', intent: 'y' })
    const roster = metrics.computeAgentRoster()
    // every entry must have lastSeen >= the entry after it
    for (let i = 0; i < roster.length - 1; i++) {
      expect(roster[i].lastSeen).toBeGreaterThanOrEqual(roster[i + 1].lastSeen)
    }
    registry.stop()
  })
})

// ── AuditLog.onAppend (SSE listener) ─────────────────────────────────────────

describe('AuditLog.onAppend', () => {
  test('fires listener on every append', () => {
    const audit = new AuditLog()
    const received: string[] = []
    audit.onAppend(e => received.push(e.type))
    audit.append('claim_granted', 'a', { detail: {} })
    audit.append('claim_released', 'a', { detail: {} })
    expect(received).toEqual(['claim_granted', 'claim_released'])
  })

  test('unsubscribe stops further notifications', () => {
    const audit = new AuditLog()
    const received: string[] = []
    const unsub = audit.onAppend(e => received.push(e.type))
    audit.append('claim_granted', 'a', { detail: {} })
    unsub()
    audit.append('claim_released', 'a', { detail: {} })
    expect(received).toEqual(['claim_granted'])
  })

  test('does not fire when audit is disabled', () => {
    const audit = new AuditLog(1000, false)
    const received: string[] = []
    audit.onAppend(e => received.push(e.type))
    audit.append('claim_granted', 'a', { detail: {} })
    expect(received).toHaveLength(0)
  })
})

// ── AuditLog.getAll ───────────────────────────────────────────────────────────

describe('AuditLog.getAll', () => {
  test('returns all entries in append order', () => {
    const audit = new AuditLog()
    audit.append('claim_granted', 'a', { detail: {} })
    audit.append('claim_denied', 'b', { detail: {} })
    const all = audit.getAll()
    expect(all.length).toBe(2)
    expect(all[0].type).toBe('claim_granted')
    expect(all[1].type).toBe('claim_denied')
  })

  test('returns a snapshot — mutations to result do not affect internal state', () => {
    const audit = new AuditLog()
    audit.append('claim_granted', 'a', { detail: {} })
    const snap = audit.getAll()
    snap.pop()
    expect(audit.getAll().length).toBe(1)
  })
})
