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
    expect(registry.get('auth.ts')).toBeUndefined()
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
    const before = registry.get('auth.ts')!.expiresAt
    // Advance time slightly
    const later = Date.now() + 2000
    jest.spyOn(Date, 'now').mockReturnValue(later)
    registry.heartbeat('auth.ts', 'agent-a')
    const after = registry.get('auth.ts')!.expiresAt
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
    expect(registry.get('auth.ts')).toBeUndefined()
    registry.stop()
  })

  test('forceRelease removes any claim regardless of owner', () => {
    const { registry } = makeRegistry()
    registry.claim({ resourceId: 'auth.ts', agentId: 'agent-a', intent: 'test' })
    expect(registry.forceRelease('auth.ts')).toBe(true)
    expect(registry.get('auth.ts')).toBeUndefined()
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
