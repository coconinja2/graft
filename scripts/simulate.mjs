// Simulates 3 parallel agents claiming overlapping resources,
// creating conflicts, publishing signals, and letting the healer fire.
// Run: node scripts/simulate.mjs  (bus must be on localhost:7433)

const BASE = 'http://localhost:7433'

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json().catch(() => null)
}

const post   = (p, b) => api('POST',   p, b)
const del_   = (p, b) => api('DELETE', p, b)
const sleep  = (ms)   => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('Graft Simulation — 3 parallel agents\n')

  // ── Subscribe all agents ─────────────────────────────────────
  await post('/signals/subscribe', { agent_id: 'agent-auth',  types: ['interface_change', 'change_summary', '*'] })
  await post('/signals/subscribe', { agent_id: 'agent-db',    types: ['schema_change', 'change_summary', '*'] })
  await post('/signals/subscribe', { agent_id: 'agent-infra', types: ['*'] })
  console.log('✓ Subscribed 3 agents to signals')

  // ── Phase 1: Normal operation — agents claim their files ─────
  console.log('\n── Phase 1: Normal claims')
  const r1 = await post('/claims', { resource_id: 'src/auth/types.ts',   agent_id: 'agent-auth',  intent: 'Adding OAuth provider fields to AuthConfig', ttl: 60 })
  const r2 = await post('/claims', { resource_id: 'src/db/schema.ts',    agent_id: 'agent-db',    intent: 'Adding user_sessions table migration',       ttl: 60 })
  const r3 = await post('/claims', { resource_id: 'src/infra/ports.ts',  agent_id: 'agent-infra', intent: 'Updating dev port assignments',              ttl: 60 })
  console.log(`  agent-auth  → src/auth/types.ts:   ${r1?.granted ? '✓ granted' : '✗ denied'}`)
  console.log(`  agent-db    → src/db/schema.ts:    ${r2?.granted ? '✓ granted' : '✗ denied'}`)
  console.log(`  agent-infra → src/infra/ports.ts:  ${r3?.granted ? '✓ granted' : '✗ denied'}`)

  await sleep(300)

  // ── Phase 2: Conflict — agent-db tries to claim auth types ──
  console.log('\n── Phase 2: Conflict (agent-db tries to claim auth/types.ts)')
  const r4 = await post('/claims', { resource_id: 'src/auth/types.ts', agent_id: 'agent-db', intent: 'Reading auth types for session schema FK reference', ttl: 60 })
  console.log(`  agent-db  → src/auth/types.ts: ${r4?.granted ? '✓ granted' : '✗ denied (held by agent-auth)'}`)

  await sleep(300)

  // ── Phase 3: Line-range claim — partial overlap ───────────────
  console.log('\n── Phase 3: Line-range claims on src/auth/types.ts')
  const r5 = await post('/claims', { resource_id: 'src/auth/types.ts', agent_id: 'agent-auth',  intent: 'Editing AuthConfig interface (lines 1-40)',  ttl: 60, line_start: 1,  line_end: 40 })
  const r6 = await post('/claims', { resource_id: 'src/auth/types.ts', agent_id: 'agent-infra', intent: 'Editing export barrel (lines 80-100)',        ttl: 60, line_start: 80, line_end: 100 })
  console.log(`  agent-auth  lines 1-40:   ${r5?.granted ? '✓ granted' : '✗ denied'}`)
  console.log(`  agent-infra lines 80-100: ${r6?.granted ? '✓ granted' : '✗ denied'}`)

  await sleep(300)

  // ── Phase 4: agent-auth publishes interface_change signal ────
  console.log('\n── Phase 4: Signals')
  await post('/signals', {
    type: 'interface_change',
    from: 'agent-auth',
    message: 'AuthConfig now requires timeout: number field — all callers must update',
    affected_resources: ['src/auth/types.ts'],
    severity: 'high',
  })
  await post('/signals', {
    type: 'change_summary',
    from: 'agent-db',
    message: 'Added user_sessions table with FK to users.id',
    affected_resources: ['src/db/schema.ts', 'src/db/migrations/0012_sessions.ts'],
    severity: 'medium',
    change_context: {
      what: 'Added user_sessions table migration',
      why: 'New JWT-based auth requires server-side session tracking',
      breakingChange: false,
      affectedResources: ['src/db/schema.ts'],
    },
  })
  console.log('  ✓ Published interface_change from agent-auth')
  console.log('  ✓ Published change_summary from agent-db')

  // ── Phase 5: Poll signals ────────────────────────────────────
  const sigs = await api('GET', '/signals/pending?agent_id=agent-infra')
  console.log(`  agent-infra received ${Array.isArray(sigs) ? sigs.length : 0} pending signals`)

  await sleep(300)

  // ── Phase 6: Release and re-claim ───────────────────────────
  console.log('\n── Phase 5: Release auth/types.ts → agent-db can now claim it')
  await del_('/claims/src%2Fauth%2Ftypes.ts?agent_id=agent-auth')
  await sleep(200)
  const r7 = await post('/claims', { resource_id: 'src/auth/types.ts', agent_id: 'agent-db', intent: 'Updating auth FK references after timeout field added', ttl: 60 })
  console.log(`  agent-db → src/auth/types.ts: ${r7?.granted ? '✓ granted' : '✗ denied'}`)

  await sleep(300)

  // ── Phase 7: Pool acquisition ────────────────────────────────
  console.log('\n── Phase 6: Pool (test_database)')
  const p1 = await post('/pool/test_database/acquire', { agent_id: 'agent-auth' })
  const p2 = await post('/pool/test_database/acquire', { agent_id: 'agent-db' })
  if (p1?.resource) console.log(`  agent-auth acquired: ${p1.resource}`)
  if (p2?.resource) console.log(`  agent-db   acquired: ${p2.resource}`)
  else console.log('  agent-db: no pool resources available (pool not configured — ok)')

  await sleep(300)

  // ── Phase 8: Create a second conflict to show healer ─────────
  console.log('\n── Phase 7: Creating a long-lived conflict (healer bait)')
  await post('/claims', { resource_id: 'src/shared/constants.ts', agent_id: 'agent-auth',  intent: 'Adding AUTH_TIMEOUT constant', ttl: 300 })
  await post('/claims', { resource_id: 'src/shared/constants.ts', agent_id: 'agent-infra', intent: 'Adding PORT_RANGE constants (would conflict)', ttl: 300 })
  console.log('  Created conflict on src/shared/constants.ts')
  console.log('  Healer will detect starvation after starvation_threshold_ms and force-release')

  // ── Final status ─────────────────────────────────────────────
  await sleep(300)
  const claims = await api('GET', '/claims')
  const conflicts = await api('GET', '/conflicts')
  const health = await api('GET', '/health')

  console.log('\n── Final state')
  console.log(`  Active claims: ${Array.isArray(claims) ? claims.length : '?'}`)
  console.log(`  Conflicts:     ${Array.isArray(conflicts) ? conflicts.length : '?'}`)
  console.log(`  Bus uptime:    ${health?.uptime ?? '?'}s`)
  console.log('\n✓ Simulation complete — open http://localhost:7433/dashboard to inspect\n')
}

main().catch(e => { console.error(e); process.exit(1) })
