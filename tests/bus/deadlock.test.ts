import { DeadlockDetector } from '../../src/bus/deadlock'
import { ClaimRegistry } from '../../src/bus/registry'
import { AuditLog } from '../../src/bus/audit'

function makeDetector() {
  const audit = new AuditLog()
  const registry = new ClaimRegistry(audit)
  const detector = new DeadlockDetector(audit, registry)
  return { detector, registry, audit }
}

describe('DeadlockDetector', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('detect does nothing when no wait edges', () => {
    const { detector, audit } = makeDetector()
    detector.detect()
    expect(audit.queryDeadlocks().length).toBe(0)
    detector.stop()
    registry_stop_helper(detector)
  })

  test('detect finds a 2-agent cycle', () => {
    const { detector, registry, audit } = makeDetector()
    // agent-a holds r1, waits for r2 (held by agent-b)
    // agent-b holds r2, waits for r1 (held by agent-a)
    registry.claim({ resourceId: 'r1', agentId: 'agent-a', intent: 'a' })
    registry.claim({ resourceId: 'r2', agentId: 'agent-b', intent: 'b' })
    detector.recordWait('agent-a', 'r2', 'agent-b')
    detector.recordWait('agent-b', 'r1', 'agent-a')
    detector.detect()
    const deadlocks = audit.queryDeadlocks()
    expect(deadlocks.length).toBe(1)
    expect(deadlocks[0].cycle.length).toBeGreaterThanOrEqual(2)
    detector.stop()
  })

  test('detect resolves deadlock by releasing oldest claim', () => {
    const { detector, registry, audit } = makeDetector()
    // agent-a claims r1 first (older), agent-b claims r2 after
    registry.claim({ resourceId: 'r1', agentId: 'agent-a', intent: 'a', ttl: 120 })
    registry.claim({ resourceId: 'r2', agentId: 'agent-b', intent: 'b', ttl: 120 })
    detector.recordWait('agent-a', 'r2', 'agent-b')
    detector.recordWait('agent-b', 'r1', 'agent-a')
    detector.detect()
    // One of the two claims in the cycle must be force-released to break it
    const r1Released = registry.get('r1').length === 0
    const r2Released = registry.get('r2').length === 0
    expect(r1Released || r2Released).toBe(true)
    const deadlocks = audit.queryDeadlocks()
    expect(deadlocks[0].resolution).toBe('expired_oldest_claim')
    detector.stop()
  })

  test('clearWait removes a wait edge', () => {
    const { detector, registry, audit } = makeDetector()
    registry.claim({ resourceId: 'r1', agentId: 'agent-a', intent: 'a' })
    registry.claim({ resourceId: 'r2', agentId: 'agent-b', intent: 'b' })
    detector.recordWait('agent-a', 'r2', 'agent-b')
    detector.recordWait('agent-b', 'r1', 'agent-a')
    detector.clearWait('agent-b') // break the cycle
    detector.detect()
    // No cycle since agent-b's wait edge was removed
    expect(audit.queryDeadlocks().length).toBe(0)
    detector.stop()
  })

  test('detect writes deadlock_detected and deadlock_resolved audit entries', () => {
    const { detector, registry, audit } = makeDetector()
    registry.claim({ resourceId: 'r1', agentId: 'agent-a', intent: 'a' })
    registry.claim({ resourceId: 'r2', agentId: 'agent-b', intent: 'b' })
    detector.recordWait('agent-a', 'r2', 'agent-b')
    detector.recordWait('agent-b', 'r1', 'agent-a')
    detector.detect()
    const detected = audit.query({ type: 'deadlock_detected' })
    const resolved = audit.query({ type: 'deadlock_resolved' })
    expect(detected.length).toBe(1)
    expect(resolved.length).toBe(1)
    detector.stop()
  })

  test('no false positive for linear wait chain', () => {
    const { detector, registry, audit } = makeDetector()
    // a waits for b, b waits for c — no cycle
    registry.claim({ resourceId: 'r1', agentId: 'agent-b', intent: 'b' })
    registry.claim({ resourceId: 'r2', agentId: 'agent-c', intent: 'c' })
    detector.recordWait('agent-a', 'r1', 'agent-b')
    detector.recordWait('agent-b', 'r2', 'agent-c')
    detector.detect()
    expect(audit.queryDeadlocks().length).toBe(0)
    detector.stop()
  })
})

// Helper since we can't call .stop() on the registry from outside the test
function registry_stop_helper(_detector: DeadlockDetector): void {
  // No-op — just documenting intent
}
