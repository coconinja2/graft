import { AuditLog } from '../../src/bus/audit'

describe('AuditLog', () => {
  let log: AuditLog

  beforeEach(() => {
    log = new AuditLog(100)
  })

  test('appends entries with monotonic seq', () => {
    log.append('claim_granted', 'agent-a', { resourceId: 'file.ts', detail: {} })
    log.append('claim_granted', 'agent-b', { resourceId: 'other.ts', detail: {} })
    const entries = log.query()
    expect(entries[0].seq).toBeGreaterThan(entries[1].seq) // reversed (newest first)
    expect(entries[1].seq).toBe(1)
    expect(entries[0].seq).toBe(2)
  })

  test('ring buffer drops oldest entries at cap', () => {
    const small = new AuditLog(3)
    small.append('claim_granted', 'a', { detail: {} })
    small.append('claim_denied', 'a', { detail: {} })
    small.append('claim_expired', 'a', { detail: {} })
    small.append('claim_released', 'a', { detail: {} }) // should drop first
    const entries = small.query({ limit: 10 })
    expect(entries.length).toBe(3)
    expect(entries.map(e => e.type)).not.toContain('claim_granted')
  })

  test('filter by agentId', () => {
    log.append('claim_granted', 'agent-a', { resourceId: 'a.ts', detail: {} })
    log.append('claim_granted', 'agent-b', { resourceId: 'b.ts', detail: {} })
    const entries = log.query({ agentId: 'agent-a' })
    expect(entries.every(e => e.agentId === 'agent-a')).toBe(true)
    expect(entries.length).toBe(1)
  })

  test('filter by resourceId', () => {
    log.append('claim_granted', 'agent-a', { resourceId: 'shared.ts', detail: {} })
    log.append('claim_granted', 'agent-b', { resourceId: 'other.ts', detail: {} })
    const entries = log.query({ resourceId: 'shared.ts' })
    expect(entries.length).toBe(1)
    expect(entries[0].resourceId).toBe('shared.ts')
  })

  test('filter by type', () => {
    log.append('claim_granted', 'agent-a', { detail: {} })
    log.append('claim_denied', 'agent-a', { detail: {} })
    const entries = log.query({ type: 'claim_denied' })
    expect(entries.length).toBe(1)
    expect(entries[0].type).toBe('claim_denied')
  })

  test('filter by since timestamp', () => {
    log.append('claim_granted', 'agent-a', { detail: {} })
    const mid = Date.now()
    log.append('claim_denied', 'agent-a', { detail: {} })
    const entries = log.query({ since: mid })
    expect(entries.every(e => e.ts >= mid)).toBe(true)
  })

  test('respects limit', () => {
    for (let i = 0; i < 10; i++) log.append('claim_granted', 'a', { detail: {} })
    expect(log.query({ limit: 3 }).length).toBe(3)
  })

  // Conflict log
  test('records and resolves conflicts', () => {
    const c = log.recordConflict({
      resourceId: 'auth.ts',
      requestingAgent: { agentId: 'agent-a', intent: 'adding oauth' },
      holdingAgent: { agentId: 'agent-b', intent: 'fixing types', claimedAt: Date.now(), ttl: 120 },
    })
    expect(c.resolution).toBe('pending')
    log.resolveConflict(c.conflictId, 'holder_released')
    const found = log.getConflict(c.conflictId)
    expect(found?.resolution).toBe('holder_released')
    expect(found?.resolvedAt).toBeDefined()
  })

  test('resolveConflictsByResource resolves all pending for a resource', () => {
    const c1 = log.recordConflict({
      resourceId: 'shared.ts',
      requestingAgent: { agentId: 'a', intent: 'x' },
      holdingAgent: { agentId: 'b', intent: 'y', claimedAt: Date.now(), ttl: 120 },
    })
    const c2 = log.recordConflict({
      resourceId: 'shared.ts',
      requestingAgent: { agentId: 'c', intent: 'z' },
      holdingAgent: { agentId: 'b', intent: 'y', claimedAt: Date.now(), ttl: 120 },
    })
    log.resolveConflictsByResource('shared.ts', 'holder_expired')
    expect(log.getConflict(c1.conflictId)?.resolution).toBe('holder_expired')
    expect(log.getConflict(c2.conflictId)?.resolution).toBe('holder_expired')
  })

  test('queryConflicts filters by agent', () => {
    log.recordConflict({
      resourceId: 'a.ts',
      requestingAgent: { agentId: 'agent-a', intent: 'x' },
      holdingAgent: { agentId: 'agent-b', intent: 'y', claimedAt: Date.now(), ttl: 120 },
    })
    log.recordConflict({
      resourceId: 'b.ts',
      requestingAgent: { agentId: 'agent-c', intent: 'x' },
      holdingAgent: { agentId: 'agent-d', intent: 'y', claimedAt: Date.now(), ttl: 120 },
    })
    const results = log.queryConflicts({ agentId: 'agent-a' })
    expect(results.length).toBe(1)
    expect(results[0].resourceId).toBe('a.ts')
  })

  // Deadlock log
  test('records and resolves deadlocks', () => {
    const d = log.recordDeadlock({
      cycle: [
        { agentId: 'a', waitingFor: 'r1', heldBy: 'b' },
        { agentId: 'b', waitingFor: 'r2', heldBy: 'a' },
      ],
    })
    expect(d.resolution).toBe('pending')
    log.resolveDeadlock(d.deadlockId, 'expired_oldest_claim')
    const found = log.getDeadlock(d.deadlockId)
    expect(found?.resolution).toBe('expired_oldest_claim')
    expect(found?.resolvedAt).toBeDefined()
  })

  test('disabled audit log does not append', () => {
    const disabled = new AuditLog(100, false)
    disabled.append('claim_granted', 'a', { detail: {} })
    expect(disabled.query().length).toBe(0)
  })

  test('getTimeline returns entries for a single agent in order', () => {
    log.append('claim_granted', 'agent-x', { detail: {} })
    log.append('claim_granted', 'agent-y', { detail: {} })
    log.append('claim_released', 'agent-x', { detail: {} })
    const timeline = log.getTimeline('agent-x')
    expect(timeline.length).toBe(2)
    expect(timeline.every(e => e.agentId === 'agent-x')).toBe(true)
    expect(timeline[0].type).toBe('claim_granted')
    expect(timeline[1].type).toBe('claim_released')
  })
})
