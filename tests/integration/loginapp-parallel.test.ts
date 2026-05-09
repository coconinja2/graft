/**
 * Loginapp parallel agents integration test.
 *
 * Scenario: two agents work simultaneously on the loginapp codebase.
 *
 *   Agent A — sprint-a: adds rateLimitedUntil?: number to User interface,
 *             adds isRateLimited() validator, acquires dev port
 *
 *   Agent B — sprint-b: adds mfaEnabled?: boolean to User interface,
 *             adds MFA session helpers, acquires dev port
 *
 * Coordination story:
 *   1. Both agents race to claim src/auth/types.ts (User block, overlapping line range)
 *   2. Agent B is denied — sees Agent A's intent — pivots to session.ts first
 *   3. Agent A completes its types.ts edits, publishes a change_summary signal, releases
 *   4. Agent B receives the signal at its next poll boundary, claims types.ts, adds its field
 *   5. Both agents race for dev ports from the pool — each gets a different port
 *   6. Wave gate prevents either agent from merging until both complete
 *   7. Audit trail records the full story: grants, denials, signals, conflicts, wave
 */

import { createServer } from '../../src/bus/server'
import { GraftClient } from '../../src/sdk/client'

// Simulated line range for the User interface block in loginapp/src/auth/types.ts
// Lines 3–9 based on actual file content:
//   3: export interface User {
//   4:   id: string
//   5:   email: string
//   6:   name: string
//   7:   provider?: OAuthProvider
//   8:   failedAttempts?: number
//   9:   lockedUntil?: number
//  10: }
const USER_BLOCK = { start: 3, end: 10 }
const TYPES_FILE = 'loginapp/src/auth/types.ts'
const VALIDATORS_FILE = 'loginapp/src/auth/validators.ts'
const SESSION_FILE = 'loginapp/src/auth/session.ts'
const DEV_PORT_POOL = 'dev_port'
const WAVE = 'loginapp-sprint-1'

let serverInstance: Awaited<ReturnType<typeof createServer>>
let baseUrl: string

beforeAll(async () => {
  serverInstance = await createServer()

  // Register dev port pool before the server starts accepting requests
  serverInstance.pool.register(DEV_PORT_POOL, { resources: ['port:3001', 'port:3002'] })

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Simulate an agent claiming a resource, doing work (delay), then releasing. */
async function simulateEdit(
  client: GraftClient,
  resourceId: string,
  intent: string,
  workMs: number,
  lineStart?: number,
  lineEnd?: number,
): Promise<{ granted: boolean; conflictId?: string; holder?: { agentId: string; intent: string } }> {
  const result = await client.claim({ resourceId, intent, lineStart, lineEnd })
  if (!result.granted) {
    return { granted: false, conflictId: result.conflictId, holder: result.holder }
  }
  // Simulate doing the actual work
  await new Promise(r => setTimeout(r, workMs))
  await client.release(resourceId, lineStart, lineEnd)
  return { granted: true }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Loginapp parallel sprint — two agents, shared codebase', () => {
  test('Agent A and B race for types.ts — B is denied, pivots to session.ts', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'sprint-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'sprint-b' })

    // Both subscribe to change_summary signals from each other
    await a.subscribe(['change_summary', 'interface_change'])
    await b.subscribe(['change_summary', 'interface_change'])

    // Agent A claims types.ts User block first
    const claimA = await a.claim({
      resourceId: TYPES_FILE,
      intent: 'adding rateLimitedUntil?: number to User interface',
      lineStart: USER_BLOCK.start,
      lineEnd: USER_BLOCK.end,
    })
    expect(claimA.granted).toBe(true)

    // Agent B races to claim the same block — denied
    const claimB = await b.claim({
      resourceId: TYPES_FILE,
      intent: 'adding mfaEnabled?: boolean to User interface',
      lineStart: USER_BLOCK.start,
      lineEnd: USER_BLOCK.end,
    })
    expect(claimB.granted).toBe(false)
    expect(claimB.holder?.agentId).toBe('sprint-a')
    expect(claimB.holder?.intent).toContain('rateLimitedUntil')
    expect(claimB.conflictId).toBeDefined()

    // B pivots: works on session.ts while A holds types.ts
    const pivotResult = await simulateEdit(
      b,
      SESSION_FILE,
      'adding isMfaRequired() and verifyMfaToken() session helpers',
      50,
    )
    expect(pivotResult.granted).toBe(true)

    // A finishes its types.ts work, broadcasts a change_summary, releases
    await a.publish({
      type: 'change_summary',
      message: 'User interface: added rateLimitedUntil?: number for rate limiting support',
      affectedResources: [TYPES_FILE],
      severity: 'medium',
      changeContext: {
        what: 'Added rateLimitedUntil?: number to User interface in types.ts',
        why: 'Rate limiting per-user needs a timestamp stored on the User object',
        breakingChange: false,
        affectedResources: [TYPES_FILE],
        diff: '+  rateLimitedUntil?: number',
      },
    })
    await a.release(TYPES_FILE, USER_BLOCK.start, USER_BLOCK.end)

    // B polls for signals — receives A's change_summary
    const signals = await b.getPendingSignals()
    expect(signals.length).toBeGreaterThanOrEqual(1)
    const cs = signals.find(s => s.type === 'change_summary' && s.from === 'sprint-a')
    expect(cs).toBeDefined()
    expect(cs?.changeContext?.breakingChange).toBe(false)
    expect(cs?.changeContext?.what).toContain('rateLimitedUntil')

    // B now claims types.ts (A released) — should be granted
    const claimB2 = await b.claim({
      resourceId: TYPES_FILE,
      intent: 'adding mfaEnabled?: boolean to User interface',
      lineStart: USER_BLOCK.start,
      lineEnd: USER_BLOCK.end,
    })
    expect(claimB2.granted).toBe(true)
    await b.release(TYPES_FILE, USER_BLOCK.start, USER_BLOCK.end)

    // B broadcasts its own change_summary
    await b.publish({
      type: 'change_summary',
      message: 'User interface: added mfaEnabled?: boolean for MFA support',
      affectedResources: [TYPES_FILE],
      severity: 'low',
      changeContext: {
        what: 'Added mfaEnabled?: boolean to User interface in types.ts',
        why: 'MFA session helpers need to read this flag from the User object',
        breakingChange: false,
        affectedResources: [TYPES_FILE],
        diff: '+  mfaEnabled?: boolean',
      },
    })
  })

  test('non-overlapping line ranges on same file both granted simultaneously', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'range-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'range-b' })

    // AuthState interface: lines 12-19 (different block from User at 3-10)
    const AUTH_STATE_BLOCK = { start: 12, end: 19 }
    const LOGIN_PAYLOAD_BLOCK = { start: 21, end: 27 }

    const [claimA, claimB] = await Promise.all([
      a.claim({
        resourceId: TYPES_FILE,
        intent: 'updating AuthState with MFA pending flag',
        lineStart: AUTH_STATE_BLOCK.start,
        lineEnd: AUTH_STATE_BLOCK.end,
      }),
      b.claim({
        resourceId: TYPES_FILE,
        intent: 'updating LoginPayload with mfaToken field',
        lineStart: LOGIN_PAYLOAD_BLOCK.start,
        lineEnd: LOGIN_PAYLOAD_BLOCK.end,
      }),
    ])

    // Both should be granted — non-overlapping line ranges
    expect(claimA.granted).toBe(true)
    expect(claimB.granted).toBe(true)

    await Promise.all([
      a.release(TYPES_FILE, AUTH_STATE_BLOCK.start, AUTH_STATE_BLOCK.end),
      b.release(TYPES_FILE, LOGIN_PAYLOAD_BLOCK.start, LOGIN_PAYLOAD_BLOCK.end),
    ])
  })

  test('whole-file claim blocks all line-range claims on same file', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'whole-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'whole-b' })

    // Agent A takes a whole-file claim (e.g. full reformat)
    const claimA = await a.claim({
      resourceId: VALIDATORS_FILE,
      intent: 'reformatting entire validators.ts with new lint rules',
    })
    expect(claimA.granted).toBe(true)

    // Agent B tries to claim a specific line range — still denied (whole-file blocks all)
    const claimB = await b.claim({
      resourceId: VALIDATORS_FILE,
      intent: 'adding isRateLimited() validator',
      lineStart: 10,
      lineEnd: 15,
    })
    expect(claimB.granted).toBe(false)
    expect(claimB.holder?.agentId).toBe('whole-a')

    await a.release(VALIDATORS_FILE)
  })

  test('port pool — both agents get distinct ports, exhaustion blocks a third', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'port-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'port-b' })
    const c = new GraftClient({ busUrl: baseUrl, agentId: 'port-c' })

    const portA = await a.acquirePool(DEV_PORT_POOL)
    const portB = await b.acquirePool(DEV_PORT_POOL)

    // Both agents got a port — they should be different
    expect(portA).toBeDefined()
    expect(portB).toBeDefined()
    expect(portA).not.toBe(portB)
    expect(['port:3001', 'port:3002']).toContain(portA)
    expect(['port:3001', 'port:3002']).toContain(portB)

    // Pool is now exhausted — C would block; we give it a short timeout
    const exhaustPromise = c.acquirePool(DEV_PORT_POOL, 200)
    await expect(exhaustPromise).rejects.toThrow()

    // Release ports and verify status
    await a.releasePool(DEV_PORT_POOL, portA)
    await b.releasePool(DEV_PORT_POOL, portB)

    const status = await a.poolStatus(DEV_PORT_POOL)
    expect(status.available).toBe(2)
    expect(status.inUse).toBe(0)
  })

  test('wave gate — neither agent merges until both complete their sprint tasks', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'wave-sprint-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'wave-sprint-b' })

    await a.waveRegister(WAVE, ['wave-sprint-a', 'wave-sprint-b'])

    // A finishes first
    await a.waveComplete(WAVE)
    const afterA = await a.waveStatus(WAVE)
    expect(afterA.done).toBe(false)
    expect(afterA.completed).toContain('wave-sprint-a')
    expect(afterA.pending).toContain('wave-sprint-b')

    // B finishes
    await b.waveComplete(WAVE)
    const afterB = await b.waveStatus(WAVE)
    expect(afterB.done).toBe(true)
    expect(afterB.pending).toHaveLength(0)
  })

  test('full audit trail — every coordination event is recorded', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'audit-sprint-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'audit-sprint-b' })

    const resource = 'loginapp/src/auth/audit-target.ts'

    await a.claim({ resourceId: resource, intent: 'agent-a holding for audit test' })
    await b.claim({ resourceId: resource, intent: 'agent-b denied for audit test' })
    await a.release(resource)
    await b.claim({ resourceId: resource, intent: 'agent-b claims after release' })
    await b.release(resource)

    const granted = await a.getAuditLog({ type: 'claim_granted', resourceId: resource })
    const denied = await a.getAuditLog({ type: 'claim_denied', resourceId: resource })
    const released = await a.getAuditLog({ type: 'claim_released', resourceId: resource })

    expect(granted.length).toBe(2)   // A granted, then B granted after A released
    expect(denied.length).toBe(1)    // B denied initially
    expect(released.length).toBe(2)  // A released, B released

    // Sequence numbers must be monotonically increasing
    const all = [...granted, ...denied, ...released].sort((x, y) => x.seq - y.seq)
    for (let i = 1; i < all.length; i++) {
      expect(all[i].seq).toBeGreaterThan(all[i - 1].seq)
    }
  })

  test('conflict log records the types.ts race with full agent context', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'conflict-sprint-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'conflict-sprint-b' })

    const resource = 'loginapp/src/auth/conflict-types.ts'

    await a.claim({ resourceId: resource, intent: 'agent-a adding fields', lineStart: 3, lineEnd: 10 })
    const denied = await b.claim({ resourceId: resource, intent: 'agent-b adding fields', lineStart: 3, lineEnd: 10 })
    expect(denied.conflictId).toBeDefined()

    await a.release(resource, 3, 10)

    const conflicts = await a.getConflicts({ resourceId: resource })
    expect(conflicts.length).toBe(1)

    const conflict = conflicts[0]
    expect(conflict.requestingAgent.agentId).toBe('conflict-sprint-b')
    expect(conflict.holdingAgent.agentId).toBe('conflict-sprint-a')
    expect(conflict.resourceId).toBe(resource)
    expect(conflict.resolution).toBe('holder_released')
    expect(conflict.resolvedAt).toBeDefined()
  })

  test('agent timeline shows chronological events for a single agent session', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'timeline-sprint-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'timeline-sprint-b' })

    await b.subscribe(['change_summary'])

    const r1 = 'loginapp/src/auth/timeline-types.ts'
    const r2 = 'loginapp/src/auth/timeline-session.ts'

    await a.claim({ resourceId: r1, intent: 'first claim' })
    await a.release(r1)
    await a.claim({ resourceId: r2, intent: 'second claim' })
    await a.publish({
      type: 'change_summary',
      message: 'timeline agent finished',
      affectedResources: [r2],
      changeContext: {
        what: 'timeline agent finished',
        why: 'test',
        breakingChange: false,
        affectedResources: [r2],
      },
    })
    await a.release(r2)

    const timeline = await a.getTimeline('timeline-sprint-a')
    expect(timeline.length).toBeGreaterThanOrEqual(4)

    const types = timeline.map(e => e.type)
    expect(types).toContain('claim_granted')
    expect(types).toContain('claim_released')
    expect(types).toContain('signal_published')

    // Timeline is sorted oldest-first (ascending seq).
    // session_start/session_end synthetic entries share the seq of the adjacent real entry.
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].seq).toBeGreaterThanOrEqual(timeline[i - 1].seq)
    }
  })

  test('contention heatmap shows types.ts as most contested resource', async () => {
    const a = new GraftClient({ busUrl: baseUrl, agentId: 'heat-a' })
    const b = new GraftClient({ busUrl: baseUrl, agentId: 'heat-b' })
    const c = new GraftClient({ busUrl: baseUrl, agentId: 'heat-c' })

    const hotFile = 'loginapp/src/auth/hot-types.ts'
    const coldFile = 'loginapp/src/auth/cold-utils.ts'

    // Generate 3 denials on hotFile, 1 denial on coldFile
    await a.claim({ resourceId: hotFile, intent: 'holder' })
    await b.claim({ resourceId: hotFile, intent: 'denied-1' })
    await c.claim({ resourceId: hotFile, intent: 'denied-2' })
    await a.release(hotFile)
    await a.claim({ resourceId: hotFile, intent: 'holder again' })
    await b.claim({ resourceId: hotFile, intent: 'denied-3' })
    await a.release(hotFile)

    await a.claim({ resourceId: coldFile, intent: 'cold holder' })
    await b.claim({ resourceId: coldFile, intent: 'cold denied-1' })
    await a.release(coldFile)

    // Fetch the contention heatmap via HTTP
    const resp = await fetch(`${baseUrl}/stats/contention?limit=10`)
    expect(resp.ok).toBe(true)
    const heatmap = await resp.json() as Array<{ resourceId: string; denials: number }>

    expect(Array.isArray(heatmap)).toBe(true)
    const hotEntry = heatmap.find(h => h.resourceId === hotFile)
    const coldEntry = heatmap.find(h => h.resourceId === coldFile)

    expect(hotEntry).toBeDefined()
    expect(coldEntry).toBeDefined()
    expect(hotEntry!.denials).toBeGreaterThan(coldEntry!.denials)
    // hotFile should rank higher (heatmap sorted descending by denials)
    expect(heatmap.indexOf(hotEntry!)).toBeLessThan(heatmap.indexOf(coldEntry!))
  })

  test('agent roster shows both sprint agents with their activity', async () => {
    const resp = await fetch(`${baseUrl}/agents`)
    expect(resp.ok).toBe(true)
    const roster = await resp.json() as Array<{ agentId: string }>

    // sprint-a and sprint-b participated earlier in this suite
    const ids = roster.map(r => r.agentId)
    expect(ids).toContain('sprint-a')
    expect(ids).toContain('sprint-b')
  })
})
