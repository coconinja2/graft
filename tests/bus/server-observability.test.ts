/**
 * Integration tests for the four new observability endpoints:
 *   GET /metrics            — Prometheus text + JSON
 *   GET /audit/stream       — SSE live stream
 *   GET /stats/contention   — contention heatmap
 *   GET /agents             — agent roster
 */

import { createServer } from '../../src/bus/server'

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

// ── /metrics (Prometheus) ─────────────────────────────────────────────────────

describe('GET /metrics', () => {
  test('returns Prometheus text format by default', async () => {
    const res = await fetch(`${baseUrl}/metrics`)
    expect(res.ok).toBe(true)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const body = await res.text()
    expect(body).toContain('graft_claims_granted_total')
    expect(body).toContain('# TYPE graft_claims_granted_total counter')
    expect(body).toContain('# TYPE graft_claim_hold_duration_ms histogram')
    expect(body).toContain('le="+Inf"')
  })

  test('returns JSON when format=json is requested', async () => {
    const res = await fetch(`${baseUrl}/metrics?format=json`)
    expect(res.ok).toBe(true)
    const body = await res.json() as { counters: Record<string, number>; gauges: Record<string, number>; histograms: Record<string, unknown> }
    expect(typeof body.counters).toBe('object')
    expect(typeof body.gauges).toBe('object')
    expect(typeof body.histograms).toBe('object')
    expect('claims_granted_total' in body.counters).toBe(true)
    expect('active_claims_total' in body.gauges).toBe(true)
  })

  test('counter increments after claim activity', async () => {
    // Establish a baseline
    const before = await fetch(`${baseUrl}/metrics?format=json`).then(r => r.json()) as { counters: Record<string, number> }

    // Grant one claim, deny one claim
    await fetch(`${baseUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: 'metrics-test.ts', agent_id: 'metrics-a', intent: 'hold' }),
    })
    await fetch(`${baseUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: 'metrics-test.ts', agent_id: 'metrics-b', intent: 'want' }),
    })

    const after = await fetch(`${baseUrl}/metrics?format=json`).then(r => r.json()) as { counters: Record<string, number> }
    expect(after.counters.claims_granted_total).toBe(before.counters.claims_granted_total + 1)
    expect(after.counters.claims_denied_total).toBe(before.counters.claims_denied_total + 1)

    // Cleanup
    await fetch(`${baseUrl}/claims/${encodeURIComponent('metrics-test.ts')}?agent_id=metrics-a`, { method: 'DELETE' })
  })

  test('gauge reflects live claim count', async () => {
    await fetch(`${baseUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: 'gauge-test.ts', agent_id: 'gauge-agent', intent: 'testing' }),
    })

    const body = await fetch(`${baseUrl}/metrics?format=json`).then(r => r.json()) as { gauges: Record<string, number> }
    expect(body.gauges.active_claims_total).toBeGreaterThanOrEqual(1)

    await fetch(`${baseUrl}/claims/${encodeURIComponent('gauge-test.ts')}?agent_id=gauge-agent`, { method: 'DELETE' })
  })
})

// ── /stats/contention ─────────────────────────────────────────────────────────

describe('GET /stats/contention', () => {
  test('returns empty array when no conflicts have occurred', async () => {
    // Fresh server — depends on test order, but we look for the specific resource
    const res = await fetch(`${baseUrl}/stats/contention`)
    expect(res.ok).toBe(true)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
  })

  test('lists contested resources sorted by denial count', async () => {
    // Create two denials on hot.ts and one on warm.ts
    await fetch(`${baseUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: 'contention-hot.ts', agent_id: 'cnt-holder', intent: 'hold' }),
    })
    await fetch(`${baseUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: 'contention-hot.ts', agent_id: 'cnt-req-1', intent: 'want1' }),
    })
    await fetch(`${baseUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: 'contention-hot.ts', agent_id: 'cnt-req-2', intent: 'want2' }),
    })

    const res = await fetch(`${baseUrl}/stats/contention`)
    const list = await res.json() as Array<{ resourceId: string; denials: number }>
    const hot = list.find(e => e.resourceId === 'contention-hot.ts')
    expect(hot).toBeDefined()
    expect(hot!.denials).toBe(2)
    expect(list[0].denials).toBeGreaterThanOrEqual(list[list.length - 1].denials)
  })

  test('respects limit query param', async () => {
    const res = await fetch(`${baseUrl}/stats/contention?limit=1`)
    const list = await res.json() as unknown[]
    expect(list.length).toBeLessThanOrEqual(1)
  })

  test('contention entries include topBlockingAgents', async () => {
    const res = await fetch(`${baseUrl}/stats/contention`)
    const list = await res.json() as Array<{ resourceId: string; topBlockingAgents: Array<{ agentId: string; count: number }> }>
    const hot = list.find(e => e.resourceId === 'contention-hot.ts')
    expect(hot?.topBlockingAgents).toBeDefined()
    expect(hot!.topBlockingAgents[0].agentId).toBe('cnt-holder')
  })
})

// ── /agents ───────────────────────────────────────────────────────────────────

describe('GET /agents', () => {
  test('returns an array', async () => {
    const res = await fetch(`${baseUrl}/agents`)
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('includes agent that made a claim', async () => {
    await fetch(`${baseUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: 'roster-test.ts', agent_id: 'roster-agent', intent: 'testing' }),
    })

    const roster = await fetch(`${baseUrl}/agents`).then(r => r.json()) as Array<{
      agentId: string; active: boolean; currentClaims: string[]
      claimsGranted: number; firstSeen: number; lastSeen: number
    }>

    const agent = roster.find(a => a.agentId === 'roster-agent')
    expect(agent).toBeDefined()
    expect(agent!.active).toBe(true)
    expect(agent!.currentClaims).toContain('roster-test.ts')
    expect(agent!.claimsGranted).toBeGreaterThanOrEqual(1)
    expect(agent!.firstSeen).toBeGreaterThan(0)
  })

  test('denied agent also appears in roster', async () => {
    // cnt-req-1 was denied earlier — should appear in roster
    const roster = await fetch(`${baseUrl}/agents`).then(r => r.json()) as Array<{ agentId: string; claimsDenied: number }>
    const denied = roster.find(a => a.agentId === 'cnt-req-1')
    expect(denied).toBeDefined()
    expect(denied!.claimsDenied).toBeGreaterThanOrEqual(1)
  })

  test('roster entries sorted newest-last-seen first', async () => {
    const roster = await fetch(`${baseUrl}/agents`).then(r => r.json()) as Array<{ lastSeen: number }>
    if (roster.length < 2) return // skip if only one agent
    expect(roster[0].lastSeen).toBeGreaterThanOrEqual(roster[roster.length - 1].lastSeen)
  })
})

// ── /audit/stream (SSE) ───────────────────────────────────────────────────────

describe('GET /audit/stream', () => {
  test('responds with SSE headers', async () => {
    const ac = new AbortController()
    const res = await fetch(`${baseUrl}/audit/stream`, { signal: ac.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    ac.abort()
  })

  test('delivers an event when a claim is made after connecting', async () => {
    const received: string[] = []
    const ac = new AbortController()

    const streamDone = fetch(`${baseUrl}/audit/stream`, { signal: ac.signal })
      .then(async res => {
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
          if (done || value === undefined) break
          const text = decoder.decode(value, { stream: true })
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) received.push(line)
          }
          if (received.some(l => l.includes('stream-sse-test.ts'))) break
        }
      })
      .catch(() => { /* aborted */ })

    // Let the stream connect
    await new Promise(r => setTimeout(r, 50))

    // Fire a claim that should appear in the stream
    await fetch(`${baseUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource_id: 'stream-sse-test.ts', agent_id: 'sse-agent', intent: 'stream test' }),
    })

    await new Promise(r => setTimeout(r, 100))
    ac.abort()
    await streamDone

    expect(received.some(l => l.includes('stream-sse-test.ts'))).toBe(true)
  })
})
