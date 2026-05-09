import { ClaimRegistry } from '../../src/bus/registry'
import { AuditLog } from '../../src/bus/audit'

function makeRegistry(ttl = 120) {
  const audit = new AuditLog()
  const registry = new ClaimRegistry(audit, ttl)
  return { registry, audit }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('ClaimRegistry', () => {
  test('grants a claim when resource is free', () => {
    const { registry } = makeRegistry()
    const result = registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'adding oauth' })
    expect(result.granted).toBe(true)
    expect(result.claim?.resourceId).toBe('auth.ts')
    expect(result.claim?.agentId).toBe('agent-a')
    expect(result.claim?.claimId).toBeDefined()
    registry.stop()
  })

  test('denies a claim when resource is held by another write claim', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'first' })
    const result = registry.claim({ resourceId: 'auth.ts', agentId: 'agent-b', intent: 'second' })
    expect(result.granted).toBe(false)
    expect(result.holder?.agentId).toBe('agent-a')
    expect(result.holder?.intent).toBe('first')
    expect(result.conflictId).toBeDefined()
    registry.stop()
  })

  test('allows same agent to re-claim its own resource', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'first' })
    const result = registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'update' })
    expect(result.granted).toBe(true)
    registry.stop()
  })

  test('releases a claim', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    expect(registry.release('auth.ts', 'agent-a')).toBe(true)
    expect(registry.get('auth.ts')).toEqual([])
    registry.stop()
  })

  test('release returns false if agent does not own the claim', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    expect(registry.release('auth.ts', 'agent-b')).toBe(false)
    registry.stop()
  })

  test('heartbeat refreshes TTL', () => {
    const { registry } = makeRegistry(5)
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test', ttl: 5 })
    const before = registry.get('auth.ts')[0]!.expiresAt
    const later = Date.now() + 2000
    jest.spyOn(Date, 'now').mockReturnValue(later)
    registry.heartbeat('auth.ts', 'agent-a')
    const after = registry.get('auth.ts')[0]!.expiresAt
    expect(after).toBeGreaterThan(before)
    registry.stop()
  })

  test('heartbeat returns false for wrong agent', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    expect(registry.heartbeat('auth.ts', 'agent-b')).toBe(false)
    registry.stop()
  })

  test('expired claims are not returned by get()', () => {
    jest.useFakeTimers()
    const { registry } = makeRegistry(1)
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test', ttl: 1 })
    jest.advanceTimersByTime(2000)
    expect(registry.get('auth.ts')).toEqual([])
    registry.stop()
  })

  test('forceRelease removes any claim regardless of owner', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    expect(registry.forceRelease('auth.ts')).toBe(true)
    expect(registry.get('auth.ts')).toEqual([])
    registry.stop()
  })

  test('list returns only active claims', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'a.ts', agentId: 'x', intent: 'x' })
    registry.claim({ resourceId: 'b.ts', agentId: 'y', intent: 'y' })
    expect(registry.list().length).toBe(2)
    registry.release('a.ts', 'x')
    expect(registry.list().length).toBe(1)
    registry.stop()
  })

  test('writes claim_granted audit entry on success', () => {
    const { registry, audit } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    const entries = audit.query({ type: 'claim_granted' })
    expect(entries.length).toBe(1)
    expect(entries[0].agentId).toBe('agent-a')
    registry.stop()
  })

  test('writes claim_denied audit entry and conflict on deny', () => {
    const { registry, audit } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'first' })
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-b', intent: 'second' })
    const denied = audit.query({ type: 'claim_denied' })
    expect(denied.length).toBe(1)
    const conflicts = audit.queryConflicts()
    expect(conflicts.length).toBe(1)
    expect(conflicts[0].resolution).toBe('pending')
    registry.stop()
  })
})

// ── Line-range locking ────────────────────────────────────────────────────────

describe('ClaimRegistry — line-range locking', () => {
  test('grants non-overlapping line ranges on the same file simultaneously', () => {
    const { registry } = makeRegistry()
    const r1 = registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'top half', lineRange: { start: 1, end: 50 } })
    const r2 = registry.claim({ resourceId: 'big.ts', agentId: 'agent-b', intent: 'bottom half', lineRange: { start: 51, end: 100 } })
    expect(r1.granted).toBe(true)
    expect(r2.granted).toBe(true)
    expect(registry.get('big.ts').length).toBe(2)
    registry.stop()
  })

  test('denies overlapping line ranges', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'lines 10-30', lineRange: { start: 10, end: 30 } })
    const r2 = registry.claim({ resourceId: 'big.ts', agentId: 'agent-b', intent: 'lines 25-40', lineRange: { start: 25, end: 40 } })
    expect(r2.granted).toBe(false)
    expect(r2.holder?.agentId).toBe('agent-a')
    expect(r2.holder?.lineRange).toEqual({ start: 10, end: 30 })
    registry.stop()
  })

  test('whole-file claim blocks any line-range claim on the same file', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'shared.ts', agentId: 'agent-a', intent: 'whole file' })
    const r2 = registry.claim({ resourceId: 'shared.ts', agentId: 'agent-b', intent: 'just line 5', lineRange: { start: 5, end: 5 } })
    expect(r2.granted).toBe(false)
    registry.stop()
  })

  test('line-range claim blocks a whole-file claim', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'shared.ts', agentId: 'agent-a', intent: 'line 5 only', lineRange: { start: 5, end: 5 } })
    const r2 = registry.claim({ resourceId: 'shared.ts', agentId: 'agent-b', intent: 'whole file' })
    expect(r2.granted).toBe(false)
    registry.stop()
  })

  test('adjacent ranges (no overlap) are both granted', () => {
    const { registry } = makeRegistry()
    const r1 = registry.claim({ resourceId: 'f.ts', agentId: 'agent-a', intent: 'lines 1-10', lineRange: { start: 1, end: 10 } })
    const r2 = registry.claim({ resourceId: 'f.ts', agentId: 'agent-b', intent: 'lines 11-20', lineRange: { start: 11, end: 20 } })
    expect(r1.granted).toBe(true)
    expect(r2.granted).toBe(true)
    registry.stop()
  })

  test('single-line claims on different lines are both granted', () => {
    const { registry } = makeRegistry()
    const r1 = registry.claim({ resourceId: 'f.ts', agentId: 'agent-a', intent: 'line 7', lineRange: { start: 7, end: 7 } })
    const r2 = registry.claim({ resourceId: 'f.ts', agentId: 'agent-b', intent: 'line 42', lineRange: { start: 42, end: 42 } })
    expect(r1.granted).toBe(true)
    expect(r2.granted).toBe(true)
    registry.stop()
  })

  test('single-line claims on the same line conflict', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'f.ts', agentId: 'agent-a', intent: 'line 7', lineRange: { start: 7, end: 7 } })
    const r2 = registry.claim({ resourceId: 'f.ts', agentId: 'agent-b', intent: 'also line 7', lineRange: { start: 7, end: 7 } })
    expect(r2.granted).toBe(false)
    registry.stop()
  })

  test('release by exact line range leaves other ranges untouched', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'top', lineRange: { start: 1, end: 50 } })
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-b', intent: 'bottom', lineRange: { start: 51, end: 100 } })

    registry.release('big.ts', 'agent-a', { start: 1, end: 50 })
    const remaining = registry.get('big.ts')
    expect(remaining.length).toBe(1)
    expect(remaining[0].agentId).toBe('agent-b')
    registry.stop()
  })

  test('release without lineRange releases all claims by that agent on the resource', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'top', lineRange: { start: 1, end: 50 } })
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'bottom', lineRange: { start: 51, end: 100 } })

    registry.release('big.ts', 'agent-a')
    expect(registry.get('big.ts')).toEqual([])
    registry.stop()
  })

  test('releaseById releases exactly the identified claim', () => {
    const { registry } = makeRegistry()
    const r1 = registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'top', lineRange: { start: 1, end: 50 } })
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-b', intent: 'bottom', lineRange: { start: 51, end: 100 } })

    registry.releaseById(r1.claim!.claimId, 'agent-a')
    const remaining = registry.get('big.ts')
    expect(remaining.length).toBe(1)
    expect(remaining[0].agentId).toBe('agent-b')
    registry.stop()
  })

  test('releaseById returns false when agent does not match', () => {
    const { registry } = makeRegistry()
    const r = registry.claim({ resourceId: 'f.ts', agentId: 'agent-a', intent: 'test' })
    expect(registry.releaseById(r.claim!.claimId, 'agent-b')).toBe(false)
    registry.stop()
  })

  test('getById returns the claim by UUID', () => {
    const { registry } = makeRegistry()
    const r = registry.claim({ resourceId: 'f.ts', agentId: 'agent-a', intent: 'test', lineRange: { start: 1, end: 10 } })
    const found = registry.getById(r.claim!.claimId)
    expect(found).toBeDefined()
    expect(found?.lineRange).toEqual({ start: 1, end: 10 })
    registry.stop()
  })

  test('waiter fires only when ALL line-range claims on a resource are released', (done) => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'top', lineRange: { start: 1, end: 50 } })
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-b', intent: 'bottom', lineRange: { start: 51, end: 100 } })

    let fired = false
    registry.addWaiter('big.ts', () => { fired = true })

    // Releasing one range should NOT fire the waiter
    registry.release('big.ts', 'agent-a', { start: 1, end: 50 })
    expect(fired).toBe(false)

    // Releasing the second range should fire it
    registry.release('big.ts', 'agent-b', { start: 51, end: 100 })
    expect(fired).toBe(true)
    registry.stop()
    done()
  })

  test('line ranges are included in audit detail', () => {
    const { registry, audit } = makeRegistry()
    registry.claim({ resourceId: 'f.ts', agentId: 'agent-a', intent: 'top', lineRange: { start: 1, end: 25 } })
    const entries = audit.query({ type: 'claim_granted' })
    expect(entries[0].detail.lineRange).toEqual({ start: 1, end: 25 })
    registry.stop()
  })

  test('three non-overlapping ranges on the same file all granted', () => {
    const { registry } = makeRegistry()
    const r1 = registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'a', lineRange: { start: 1, end: 30 } })
    const r2 = registry.claim({ resourceId: 'big.ts', agentId: 'agent-b', intent: 'b', lineRange: { start: 31, end: 60 } })
    const r3 = registry.claim({ resourceId: 'big.ts', agentId: 'agent-c', intent: 'c', lineRange: { start: 61, end: 90 } })
    expect(r1.granted).toBe(true)
    expect(r2.granted).toBe(true)
    expect(r3.granted).toBe(true)
    expect(registry.list().length).toBe(3)
    registry.stop()
  })
})

// ── Dead agent detection ──────────────────────────────────────────────────────

describe('ClaimRegistry — dead agent detection', () => {
  test('forceReleaseAgent releases all claims held by that agent', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'one' })
    registry.claim({ resourceId: 'b.ts', agentId: 'agent-a', intent: 'two' })
    registry.claim({ resourceId: 'c.ts', agentId: 'agent-b', intent: 'other' })

    const released = registry.forceReleaseAgent('agent-a')
    expect(released).toEqual(expect.arrayContaining(['a.ts', 'b.ts']))
    expect(released).not.toContain('c.ts')
    expect(registry.get('a.ts')).toEqual([])
    expect(registry.get('b.ts')).toEqual([])
    expect(registry.get('c.ts').length).toBe(1)
    registry.stop()
  })

  test('forceReleaseAgent releases line-range claims held by that agent', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-a', intent: 'top', lineRange: { start: 1, end: 50 } })
    registry.claim({ resourceId: 'big.ts', agentId: 'agent-b', intent: 'bottom', lineRange: { start: 51, end: 100 } })

    registry.forceReleaseAgent('agent-a')
    const remaining = registry.get('big.ts')
    expect(remaining.length).toBe(1)
    expect(remaining[0].agentId).toBe('agent-b')
    registry.stop()
  })

  test('forceReleaseAgent notifies waiters for each released resource', (done) => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'one' })
    registry.claim({ resourceId: 'b.ts', agentId: 'agent-a', intent: 'two' })

    let notified = 0
    const check = () => { if (++notified === 2) { registry.stop(); done() } }
    registry.addWaiter('a.ts', check)
    registry.addWaiter('b.ts', check)

    registry.forceReleaseAgent('agent-a')
  })

  test('forceReleaseAgent writes claim_released audit entries with agent_dead reason', () => {
    const { registry, audit } = makeRegistry()
    registry.claim({ resourceId: 'a.ts', agentId: 'agent-a', intent: 'test' })
    registry.forceReleaseAgent('agent-a')

    const entries = audit.query({ type: 'claim_released', agentId: 'agent-a' })
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0].detail).toMatchObject({ forced: true, reason: 'agent_dead' })
    registry.stop()
  })

  test('forceReleaseAgent returns empty array when agent has no claims', () => {
    const { registry } = makeRegistry()
    expect(registry.forceReleaseAgent('ghost-agent')).toEqual([])
    registry.stop()
  })
})

// ── Waiters ───────────────────────────────────────────────────────────────────

describe('ClaimRegistry — waiters', () => {
  test('addWaiter callback fires when claim is released', (done) => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    registry.addWaiter('auth.ts', () => {
      expect(registry.get('auth.ts')).toEqual([])
      registry.stop()
      done()
    })
    registry.release('auth.ts', 'agent-a')
  })

  test('addWaiter callback fires when claim is force released', (done) => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    registry.addWaiter('auth.ts', () => {
      registry.stop()
      done()
    })
    registry.forceRelease('auth.ts')
  })

  test('multiple waiters all fire on release', (done) => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    let fired = 0
    const check = () => { if (++fired === 3) { registry.stop(); done() } }
    registry.addWaiter('auth.ts', check)
    registry.addWaiter('auth.ts', check)
    registry.addWaiter('auth.ts', check)
    registry.release('auth.ts', 'agent-a')
  })

  test('cancel function removes waiter before it fires', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    let fired = false
    const cancel = registry.addWaiter('auth.ts', () => { fired = true })
    cancel()
    registry.release('auth.ts', 'agent-a')
    expect(fired).toBe(false)
    registry.stop()
  })

  test('addWaiter callback fires when claim expires via cleanup', (done) => {
    jest.useFakeTimers()
    const { registry } = makeRegistry(1)
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test', ttl: 1 })
    registry.addWaiter('auth.ts', () => {
      registry.stop()
      done()
    })
    jest.advanceTimersByTime(12_000)
    jest.useRealTimers()
  })
})
