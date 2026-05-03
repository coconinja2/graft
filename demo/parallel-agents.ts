/**
 * Parallel agent demo against ~/Documents/loginapp
 *
 * Simulates two agents working concurrently on the same codebase:
 *   Agent A — adding OAuth support (touches auth/types.ts and auth/session.ts)
 *   Agent B — adding JWT token auth (also needs auth/types.ts)
 *
 * Shows: claim conflict, change_summary broadcast, agent-B incorporating
 * Agent A's context before proceeding.
 */

import { GraftClient } from '../src/sdk/client'

const BUS = 'http://localhost:7433'
const PROJECT = `${process.env.HOME}/Documents/loginapp`

function log(agent: string, msg: string) {
  const t = new Date().toISOString().slice(11, 23)
  console.log(`[${t}] ${agent.padEnd(9)} ${msg}`)
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ── Agent A: OAuth support ────────────────────────────────────────────────────
async function agentA() {
  const client = new GraftClient({ busUrl: BUS, agentId: 'agent-a' })
  await client.subscribe(['change_summary', 'interface_change'])

  log('agent-a', 'starting — goal: add OAuth fields to AuthState and update session storage')

  // Step 1: claim auth/types.ts — wait if Agent B holds it first
  const typesPath = `${PROJECT}/src/auth/types.ts`
  let typesClaim = await client.claim({
    resourceId: typesPath,
    intent: 'adding OAuthProvider enum and token field to AuthState',
  })

  if (!typesClaim.granted) {
    log('agent-a', `CONFLICT — types.ts held by ${typesClaim.holder?.agentId}: "${typesClaim.holder?.intent}"`)
    log('agent-a', '  blocking on /wait — will resume the instant Agent B releases')
    await client.waitForRelease(typesPath)

    const signals = await client.getPendingSignals()
    if (signals.length > 0) {
      const s = signals[0]
      log('agent-a', `SIGNAL received from ${s.from}: "${s.message}"`)
      log('agent-a', `  what: ${s.changeContext?.what}`)
      log('agent-a', '  DECISION: incorporating this before writing my changes')
    }

    typesClaim = await client.claim({
      resourceId: typesPath,
      intent: 'adding OAuthProvider enum and token field to AuthState',
    })
    if (!typesClaim.granted) {
      log('agent-a', 'could not acquire types.ts — aborting')
      return
    }
  }

  log('agent-a', 'claimed auth/types.ts — writing OAuth changes')
  await sleep(800) // simulate thinking + writing

  const { writeFileSync } = await import('fs')
  writeFileSync(typesPath, `export type OAuthProvider = 'google' | 'github' | 'apple'

export interface User {
  id: string
  email: string
  name: string
  provider?: OAuthProvider
}

export interface AuthState {
  user: User | null
  loading: boolean
  token?: string          // added: JWT for API calls
  provider?: OAuthProvider
}

export interface LoginPayload {
  email: string
  password: string
  provider?: OAuthProvider  // added: OAuth login path
}
`)

  log('agent-a', 'wrote auth/types.ts — publishing change_summary')

  await client.publish({
    type: 'change_summary',
    message: 'AuthState now carries token and provider; LoginPayload accepts OAuth path',
    affectedResources: [typesPath],
    severity: 'high',
    changeContext: {
      what: 'Added OAuthProvider enum, token field to AuthState, provider to LoginPayload',
      why: 'Users need to log in via Google/GitHub without a password — cookie session alone is not enough',
      breakingChange: true,
      affectedResources: [typesPath],
    },
  })

  await client.release(typesPath)
  log('agent-a', 'released auth/types.ts')

  // Step 2: claim session.ts
  const sessionPath = `${PROJECT}/src/auth/session.ts`
  const claim2 = await client.claim({
    resourceId: sessionPath,
    intent: 'storing OAuth token alongside user object in session',
  })

  if (!claim2.granted) {
    log('agent-a', `BLOCKED on session.ts by ${claim2.holder?.agentId}`)
  } else {
    log('agent-a', 'claimed session.ts — writing token storage')
    await sleep(500)

    writeFileSync(sessionPath, `import { User, OAuthProvider } from './types'

export interface Session {
  user: User
  token: string
  provider?: OAuthProvider
  expiresAt: number
}

export function getSession(): Session | null {
  const raw = localStorage.getItem('session')
  return raw ? JSON.parse(raw) : null
}

export function setSession(user: User, token: string, provider?: OAuthProvider): void {
  const session: Session = {
    user,
    token,
    provider,
    expiresAt: Date.now() + 3600_000,
  }
  localStorage.setItem('session', JSON.stringify(session))
}

export function clearSession(): void {
  localStorage.removeItem('session')
}
`)

    await client.publish({
      type: 'change_summary',
      message: 'session.ts now stores token + provider + expiry alongside user',
      affectedResources: [sessionPath],
      severity: 'low',
      changeContext: {
        what: 'Session now stores token, provider, and expiresAt alongside user',
        why: 'API calls need the JWT token; UI needs provider to show correct avatar',
        breakingChange: false,
        affectedResources: [sessionPath],
      },
    })

    await client.release(sessionPath)
    log('agent-a', 'released session.ts — done')
  }
}

// ── Agent B: JWT login form ───────────────────────────────────────────────────
async function agentB() {
  const client = new GraftClient({ busUrl: BUS, agentId: 'agent-b' })
  await client.subscribe(['change_summary', 'interface_change'])

  log('agent-b', 'starting — goal: update LoginForm to handle JWT response and show errors')

  // Step 1: claim types.ts — wait for it if Agent A holds it first
  const typesPath = `${PROJECT}/src/auth/types.ts`
  let typesClaim = await client.claim({
    resourceId: typesPath,
    intent: 'adding LoginError type for form validation',
  })

  if (!typesClaim.granted) {
    log('agent-b', `CONFLICT — types.ts held by ${typesClaim.holder?.agentId}`)
    log('agent-b', `  holder intent: "${typesClaim.holder?.intent}"`)
    log('agent-b', '  blocking on /wait — will resume the instant Agent A releases')

    await client.waitForRelease(typesPath)

    // Pick up the change_summary Agent A published before releasing
    const signals = await client.getPendingSignals()
    if (signals.length > 0) {
      const s = signals[0]
      log('agent-b', `SIGNAL received from ${s.from}: "${s.message}"`)
      log('agent-b', `  what: ${s.changeContext?.what}`)
      log('agent-b', `  why:  ${s.changeContext?.why}`)
      log('agent-b', `  breaking: ${s.changeContext?.breakingChange}`)
      log('agent-b', '  DECISION: this affects my LoginForm — I need to handle the provider field')
    }

    typesClaim = await client.claim({ resourceId: typesPath, intent: 'adding LoginError type' })
  }

  if (typesClaim.granted) {
    log('agent-b', 'claimed types.ts — appending LoginError type')
    await sleep(400)

    const { readFileSync, writeFileSync } = await import('fs')
    const existing = readFileSync(typesPath, 'utf8')
    writeFileSync(typesPath, existing + `
export interface LoginError {
  field: 'email' | 'password' | 'provider' | 'general'
  message: string
}
`)
    await client.publish({
      type: 'change_summary',
      message: 'Added LoginError interface for form validation',
      affectedResources: [typesPath],
      severity: 'low',
      changeContext: {
        what: 'Added LoginError interface with field + message (aware of new provider field from agent-a)',
        why: 'LoginForm needs typed errors; incorporated provider field from agent-a signal',
        breakingChange: false,
        affectedResources: [typesPath],
      },
    })
    await client.release(typesPath)
    log('agent-b', 'released types.ts')
  } else {
    log('agent-b', 'could not acquire types.ts — skipping LoginError addition')
  }

  // Step 2: update login.tsx — no conflict expected
  const loginPath = `${PROJECT}/src/auth/login.tsx`
  const claim2 = await client.claim({
    resourceId: loginPath,
    intent: 'adding error display and OAuth provider buttons to LoginForm',
  })

  if (!claim2.granted) {
    log('agent-b', `BLOCKED on login.tsx by ${claim2.holder?.agentId}`)
    return
  }

  log('agent-b', 'claimed login.tsx — writing updated LoginForm')
  await sleep(600)

  const { writeFileSync } = await import('fs')
  writeFileSync(loginPath, `import React, { useState } from 'react'
import { LoginPayload, OAuthProvider, LoginError } from './types'

export function LoginForm({
  onSubmit,
  onOAuth,
}: {
  onSubmit: (p: LoginPayload) => void
  onOAuth?: (provider: OAuthProvider) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<LoginError | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.includes('@')) {
      setError({ field: 'email', message: 'Enter a valid email address' })
      return
    }
    setError(null)
    onSubmit({ email, password })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Password"
      />
      {error && <p className="error">{error.message}</p>}
      <button type="submit">Login</button>
      {onOAuth && (
        <div className="oauth-buttons">
          <button type="button" onClick={() => onOAuth('google')}>Continue with Google</button>
          <button type="button" onClick={() => onOAuth('github')}>Continue with GitHub</button>
        </div>
      )}
    </form>
  )
}
`)

  await client.publish({
    type: 'change_summary',
    message: 'LoginForm now shows validation errors and OAuth provider buttons',
    affectedResources: [loginPath],
    severity: 'low',
    changeContext: {
      what: 'LoginForm handles LoginError display and OAuthProvider buttons; uses provider field from types.ts',
      why: 'UX: users need clear error messages and one-click OAuth login',
      breakingChange: false,
      affectedResources: [loginPath],
    },
  })

  await client.release(loginPath)
  log('agent-b', 'released login.tsx — done')
}

// ── Run both agents concurrently ─────────────────────────────────────────────
async function main() {
  console.log('\n=== Graft parallel agent demo ===')
  console.log(`Project: ${PROJECT}`)
  console.log(`Bus:     ${BUS}\n`)

  // Verify bus is up
  try {
    const res = await fetch(`${BUS}/health`)
    const health = await res.json() as { status: string; claims: number }
    console.log(`Bus status: ${health.status}, active claims: ${health.claims}\n`)
  } catch {
    console.error('Graft bus is not running. Start it with: npm run dev -- start')
    process.exit(1)
  }

  // Fire both agents at the same time
  await Promise.all([agentA(), agentB()])

  console.log('\n=== Audit trail ===')
  const auditRes = await fetch(`${BUS}/audit`)
  const entries = await auditRes.json() as Array<{ type: string; agentId: string; resourceId?: string; ts: number }>
  for (const e of [...entries].reverse()) {
    const t = new Date(e.ts).toISOString().slice(11, 23)
    const resource = e.resourceId ? e.resourceId.split('/').pop() : ''
    console.log(`  [${t}] ${e.type.padEnd(22)} ${e.agentId.padEnd(10)} ${resource}`)
  }

  console.log('\n=== Conflicts ===')
  const cRes = await fetch(`${BUS}/conflicts`)
  const conflicts = await cRes.json() as Array<{ conflictId: string; resourceId: string; requestingAgent: { agentId: string }; resolution: string }>
  if (conflicts.length === 0) {
    console.log('  (none)')
  }
  for (const c of conflicts) {
    console.log(`  ${c.conflictId.slice(0, 8)} | ${c.resourceId.split('/').pop()} | requesting: ${c.requestingAgent.agentId} | resolution: ${c.resolution}`)
  }

  console.log('\n=== Signal history ===')
  const sRes = await fetch(`${BUS}/signals/history`)
  const signalHistory = await sRes.json() as Array<{ type: string; from: string; message: string; status: string }>
  for (const s of signalHistory) {
    console.log(`  [${s.status.padEnd(9)}] ${s.from.padEnd(10)} ${s.type.padEnd(20)} "${s.message}"`)
  }

  console.log('\nDone.')
}

main().catch(err => { console.error(err); process.exit(1) })
