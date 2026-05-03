/**
 * Integration test: two simulated agents coordinate via a real in-process bus.
 * Tests the full stack: registry + signals + pool + wave gate + audit trail.
 */

import { createServer } from '../../src/bus/server'
import { GraftClient } from '../../src/sdk/client'

let serverInstance: Awaited<ReturnType<typeof createServer>>
let baseUrl: string

beforeAll(async () => {
  serverInstance = await createServer()
  await serverInstance.app.listen({ port: 0, host: '127.0.0.1' })
  const address = serverInstance.app.server.address()
  const port = typeof address === 'object' && address ? address.port : 7433
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  serverInstance.registry.stop()
  serverInstance.deadlock.stop()
  await serverInstance.app.close()
})

describe('Two agents — overlapping resource claims', () => {
  test('agent-a claims a resource; agent-b is denied', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'agent-b' })

    const claimA = await a.claim({ resourceId: 'src/auth/types.ts', intent: 'adding OAuth fields' })
    expect(claimA.granted).toBe(true)

    const claimB = await b.claim({ resourceId: 'src/auth/types.ts', intent: 'adding rate limiting' })
    expect(claimB.granted).toBe(false)
    expect(claimB.holder?.agentId).toBe('agent-a')
    expect(claimB.conflictId).toBeDefined()
  })

  test('agent-b gets access after agent-a releases', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'int-agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'int-agent-b' })

    await a.claim({ resourceId: 'src/shared/utils.ts', intent: 'refactoring' })
    await a.release('src/shared/utils.ts')

    const claimB = await b.claim({ resourceId: 'src/shared/utils.ts', intent: 'adding helper' })
    expect(claimB.granted).toBe(true)
  })
})

describe('Signal delivery between agents', () => {
  test('agent-a publishes a signal; agent-b receives it at next poll', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'sig-agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'sig-agent-b' })

    await b.subscribe(['interface_change'])
    await a.publish({
      type: 'interface_change',
      message: 'AuthConfig now requires timeout: number',
      affectedResources: ['src/auth/types.ts'],
      severity: 'medium',
    })

    const signals = await b.getPendingSignals()
    expect(signals.length).toBe(1)
    expect(signals[0].type).toBe('interface_change')
    expect(signals[0].message).toBe('AuthConfig now requires timeout: number')
    expect(signals[0].from).toBe('sig-agent-a')
  })

  test('signals are not delivered to unsubscribed agents', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'nosub-agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'nosub-agent-b' })

    // b does not subscribe
    await a.publish({ type: 'new_utility', message: 'new helper created' })
    const signals = await b.getPendingSignals()
    expect(signals.length).toBe(0)
  })

  test('sender does not receive their own signal', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'self-agent-a' })
    await a.subscribe(['*'])
    await a.publish({ type: 'new_utility', message: 'self published' })
    const signals = await a.getPendingSignals()
    expect(signals.length).toBe(0)
  })
})

describe('Audit trail', () => {
  test('full audit trail exists after claim/deny/release sequence', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'audit-agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'audit-agent-b' })

    await a.claim({ resourceId: 'src/audit-test.ts', intent: 'test' })
    await b.claim({ resourceId: 'src/audit-test.ts', intent: 'blocked' })
    await a.release('src/audit-test.ts')

    const granted = await a.getAuditLog({ type: 'claim_granted', resourceId: 'src/audit-test.ts' })
    const denied = await a.getAuditLog({ type: 'claim_denied', resourceId: 'src/audit-test.ts' })
    const released = await a.getAuditLog({ type: 'claim_released', resourceId: 'src/audit-test.ts' })

    expect(granted.length).toBeGreaterThanOrEqual(1)
    expect(denied.length).toBeGreaterThanOrEqual(1)
    expect(released.length).toBeGreaterThanOrEqual(1)
  })

  test('conflict is recorded and resolved after release', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'conf-agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'conf-agent-b' })

    await a.claim({ resourceId: 'src/conflict-test.ts', intent: 'holding' })
    const denied = await b.claim({ resourceId: 'src/conflict-test.ts', intent: 'wanting' })
    expect(denied.conflictId).toBeDefined()

    const conflicts = await a.getConflicts({ resourceId: 'src/conflict-test.ts' })
    expect(conflicts.some(c => c.resolution === 'pending')).toBe(true)

    await a.release('src/conflict-test.ts')

    const resolved = await a.getConflicts({ resourceId: 'src/conflict-test.ts' })
    expect(resolved.some(c => c.resolution === 'holder_released')).toBe(true)
  })
})

describe('Wave gate', () => {
  test('wave is not done until all agents complete', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'wave-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'wave-b' })

    await a.waveRegister('test-wave', ['wave-a', 'wave-b'])

    await a.waveComplete('test-wave')
    const statusAfterA = await a.waveStatus('test-wave')
    expect(statusAfterA.done).toBe(false)

    await b.waveComplete('test-wave')
    const statusAfterB = await b.waveStatus('test-wave')
    expect(statusAfterB.done).toBe(true)
  })
})

describe('Health endpoint', () => {
  test('returns ok status', async () => {
    const client = new GraftClient({ busUrl: baseUrl, agentId: 'health-check' })
    const health = await client.health()
    expect(health.status).toBe('ok')
    expect(health.uptime).toBeGreaterThanOrEqual(0)
  })
})

describe('waitForRelease', () => {
  test('returns immediately when resource is not held', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'wait-free-a' })
    const start = Date.now()
    await a.waitForRelease('src/never-claimed.ts')
    expect(Date.now() - start).toBeLessThan(500)
  })

  test('blocks until holder releases then returns', async () => {
    const holder = new GraftClient({ busUrl: baseUrl, agentId: 'wait-holder' })
    const waiter = new GraftClient({ busUrl: baseUrl, agentId: 'wait-waiter' })

    await holder.claim({ resourceId: 'src/wait-test.ts', intent: 'holding' })

    let released = false
    const waitPromise = waiter.waitForRelease('src/wait-test.ts').then(() => { released = true })

    // Give the wait request time to park on the server
    await new Promise(r => setTimeout(r, 100))
    expect(released).toBe(false)

    await holder.release('src/wait-test.ts')
    await waitPromise
    expect(released).toBe(true)
  })

  test('waiter can immediately claim after waitForRelease resolves', async () => {
    const holder = new GraftClient({ busUrl: baseUrl, agentId: 'wait-claim-holder' })
    const waiter = new GraftClient({ busUrl: baseUrl, agentId: 'wait-claim-waiter' })

    await holder.claim({ resourceId: 'src/wait-claim-test.ts', intent: 'holding' })

    const waitAndClaim = waiter.waitForRelease('src/wait-claim-test.ts').then(() =>
      waiter.claim({ resourceId: 'src/wait-claim-test.ts', intent: 'acquired after wait' })
    )

    await new Promise(r => setTimeout(r, 100))
    await holder.release('src/wait-claim-test.ts')

    const result = await waitAndClaim
    expect(result.granted).toBe(true)
  })

  test('times out with 408 when resource is not released within timeout_ms', async () => {
    const holder = new GraftClient({ busUrl: baseUrl, agentId: 'timeout-holder' })
    const waiter = new GraftClient({ busUrl: baseUrl, agentId: 'timeout-waiter' })

    await holder.claim({ resourceId: 'src/timeout-test.ts', intent: 'holding forever' })

    await expect(
      waiter.waitForRelease('src/timeout-test.ts', 200)
    ).rejects.toThrow()

    await holder.release('src/timeout-test.ts')
  })
})

describe('change_summary broadcast flow', () => {
  test('agent-b receives full changeContext after agent-a broadcasts', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'cs-agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'cs-agent-b' })

    await b.subscribe(['change_summary'])

    await a.publish({
      type: 'change_summary',
      message: 'login now returns JWT token instead of setting a cookie',
      affectedResources: ['src/auth/login.ts', 'src/auth/types.ts'],
      severity: 'high',
      changeContext: {
        what: 'login now returns JWT token instead of setting a cookie',
        why: 'Safari ITP blocks third-party cookies',
        breakingChange: true,
        affectedResources: ['src/auth/login.ts', 'src/auth/types.ts'],
      },
    })

    const signals = await b.getPendingSignals()
    expect(signals.length).toBe(1)
    expect(signals[0].type).toBe('change_summary')
    expect(signals[0].changeContext?.breakingChange).toBe(true)
    expect(signals[0].changeContext?.why).toBe('Safari ITP blocks third-party cookies')
    expect(signals[0].changeContext?.affectedResources).toContain('src/auth/login.ts')
  })

  test('agent-b can decide to ignore a change_summary that does not affect its work', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'cs2-agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'cs2-agent-b' })

    await b.subscribe(['change_summary'])

    await a.publish({
      type: 'change_summary',
      message: 'refactored CSS variables in theme.ts',
      affectedResources: ['src/ui/theme.ts'],
      severity: 'low',
      changeContext: {
        what: 'refactored CSS variables in theme.ts',
        why: 'consolidate design tokens',
        breakingChange: false,
        affectedResources: ['src/ui/theme.ts'],
      },
    })

    const signals = await b.getPendingSignals()
    expect(signals.length).toBe(1)
    // Agent B (working on auth) reads this and decides it is unrelated — no assertion
    // on behaviour since the decision lives in the agent, not the bus. The signal
    // is delivered; what the agent does with it is out of scope for this test.
    expect(signals[0].changeContext?.breakingChange).toBe(false)
  })

  test('sender does not receive their own change_summary', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'cs3-agent-a' })
    await a.subscribe(['change_summary'])
    await a.publish({
      type: 'change_summary',
      message: 'some change',
      changeContext: {
        what: 'some change',
        why: 'some reason',
        breakingChange: false,
        affectedResources: ['src/foo.ts'],
      },
    })
    const signals = await a.getPendingSignals()
    expect(signals.length).toBe(0)
  })

  test('change_summary appears in signal history after delivery', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'cs4-agent-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'cs4-agent-b' })

    await b.subscribe(['change_summary'])
    await a.publish({
      type: 'change_summary',
      message: 'rewrote session handler',
      changeContext: {
        what: 'rewrote session handler',
        why: 'reduce latency',
        breakingChange: false,
        affectedResources: ['src/session/handler.ts'],
      },
    })

    await b.getPendingSignals()

    // Query from receiver's perspective — history is indexed by deliveredTo agent
    const history = await b.getSignalHistory({ from: 'cs4-agent-a' })
    expect(history.length).toBeGreaterThanOrEqual(1)
    expect(history[0].status).toBe('delivered')
  })
})
