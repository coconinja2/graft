# Graft — Architecture

## What problem does Graft solve?

When two AI coding agents work on the same codebase simultaneously, they have no way to know what the other is touching until they try to merge. By then, one agent has already done work that conflicts with the other. Git helps at merge time. Graft helps at *execution time*.

Graft brings the coordination primitives that operating systems use for concurrent processes — mutexes, semaphores, event buses, barriers — to the agent layer. Agents claim shared resources before touching them, broadcast signals mid-execution when they discover something others need to know, and synchronize at wave gates before merging. All of this happens through a single local HTTP server. Agents never talk to each other directly.

---

## System overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Agent (any framework)                │
│                                                              │
│   Claude Code          OpenAI Agents SDK     Gemini / Cursor │
│   preToolUse hook      graftTools()           MCP tools      │
└───────────┬────────────────────┬─────────────────┬──────────┘
            │                    │                 │
            └────────────────────┴─────────────────┘
                                 │  HTTP
                                 ▼
            ┌────────────────────────────────────────┐
            │         Graft Bus  (localhost:7433)     │
            │                                        │
            │  registry.ts   signals.ts   pool.ts    │
            │  ClaimRegistry  SignalBus   ResourcePool│
            │                                        │
            │  deadlock.ts   audit.ts                │
            │  DeadlockDetector  AuditLog            │
            │                                        │
            │  server.ts  (Fastify — 20+ endpoints)  │
            └────────────────────────────────────────┘
                                 │
                          graft.config.yaml
                    (TTL, pools, waves, signal policy)
```

All coordination state lives in the bus process. Agents are stateless from the bus's perspective — they make HTTP calls and get back typed JSON responses.

---

## Core primitives

### 1. Resource claims

A **claim** is an exclusive write lock on any string key — a file path, a port number, a database URL, a schema name. Before an agent writes to a shared resource, it claims it. The claim includes:

- `resource_id` — what is being locked
- `agent_id` — who holds the lock
- `intent` — a human-readable description of what the agent plans to do
- `ttl` — seconds before the claim auto-expires if the agent crashes (default: 120, overridable per claim)

Two agents cannot hold a write claim on the same resource simultaneously. When a second agent requests a claim that is already held, it receives back the holder's `agentId` and `intent` — enough context to decide how to proceed.

```
Agent A claims src/auth/types.ts  →  granted
Agent B claims src/auth/types.ts  →  denied
                                     { holder: { agentId: 'agent-a', intent: 'adding OAuth fields' },
                                       conflictId: 'conf_xyz' }
```

**TTL is the primary safety net.** There is no automatic dead-agent detection. If an agent crashes without releasing its claims, the TTL expires them. The default is 120 seconds and is configurable via `agents.claim_ttl` in `graft.config.yaml`. Operators can also manually release all claims for a crashed agent via `forceReleaseAgent`.

### 2. Signals

A **signal** is a typed broadcast message an agent publishes when it discovers something that other agents should know about mid-execution. Signals are queued per subscriber and delivered at the next poll (preToolUse boundary).

Built-in signal types:

| Type | Purpose |
|------|---------|
| `change_summary` | Agent finished a unit of work; broadcasts what changed and why |
| `interface_change` | A shared type or API contract is changing |
| `schema_change` | A database schema or migration is changing |
| `security_finding` | A vulnerability found in shared code |
| `resource_conflict` | An agent hit a resource already in use |
| `new_utility` | A shared utility was created that others might want to use |

`change_summary` is the primary broadcast primitive. When an agent completes a write, it **must** publish a `change_summary` with a structured payload:

```typescript
{
  what: string           // specific and semantic — not "updated file"
  why: string            // the constraint or reason behind the decision
  breakingChange: boolean
  affectedResources: string[]
  diff?: string          // optional short diff excerpt
}
```

**Receiving agents decide what to do with signals.** The bus delivers context. The agent owns the decision — whether to incorporate the change, continue unaffected, or pause. The only exception is `security_finding`, which is configured to `escalate_to_human` in the default config.

### 3. Resource pools

A **pool** is a set of stateful resources that cannot be shared but have multiple available instances — test databases, dev server ports, external API keys. Agents acquire one instance from the pool, use it exclusively, then release it back. If the pool is exhausted, the acquire call blocks until a resource is returned.

```yaml
# graft.config.yaml
pools:
  test_database:
    resources:
      - postgres://localhost:5432/test_1
      - postgres://localhost:5432/test_2
```

### 4. Wave gate

A **wave gate** is a barrier that requires all agents in a named set to signal completion before any of them proceeds to merge. This prevents a fast agent from merging before slower agents have finished work that might conflict.

```
agent-a completes  →  wave status: 1/3 done
agent-b completes  →  wave status: 2/3 done
agent-c completes  →  wave status: 3/3 done  →  done: true  →  all may merge
```

---

## How agents interact with Graft

The integration path depends on what framework or tool the agent is running in.

### Claude Code — hook-based (transparent)

Graft installs as `preToolUse` and `postToolUse` shell hooks in `.claude/settings.json`. The agent code changes nothing. Before every file write:

1. Hook polls for pending signals and delivers them to Claude's context
2. Hook claims the target resource
3. If granted → tool executes; `postToolUse` refreshes the claim TTL
4. If denied → hook returns context to Claude: who holds it, why, what signals are pending

The `postToolUse` hook acts as an implicit heartbeat — as long as Claude is actively making tool calls, claims stay refreshed. If Claude crashes, the TTL expires within `claim_ttl` seconds.

```
Claude Code preToolUse:   GET /signals/pending  →  POST /claims
Claude Code postToolUse:  POST /claims/:id/heartbeat  (or DELETE to release)
```

### OpenAI Agents SDK / LangGraph / AutoGen — explicit SDK calls

The agent calls `graft.claim()` / `graft.release()` directly before and after writing. Use lifecycle hooks (`on_start`, `on_end`, `on_tool_start`) to wrap claim management:

```typescript
import { GraftClient } from 'graft'

const graft = new GraftClient({ busUrl: 'http://localhost:7433', agentId: 'agent-a' })

const claim = await graft.claim({ resourceId: 'src/auth/types.ts', intent: 'adding OAuth fields' })
if (claim.granted) {
  await writeFile(...)
  await graft.release('src/auth/types.ts')
} else {
  console.log(`Blocked by ${claim.holder.agentId}: ${claim.holder.intent}`)
}
```

TTL is the safety net if the agent crashes between `claim()` and `release()`.

### Gemini CLI / Cursor — MCP tools

Graft runs as an MCP server (`graft mcp --port 7434`). The agent calls `graft_claim`, `graft_release`, `graft_publish_signal` as native tools. Claiming is explicit — the agent must be instructed to claim before writing. TTL handles crashes.

---

## What happens when an agent crashes

No framework or tool (Claude Code, Codex, Gemini, Cursor, CrewAI, LangGraph, AutoGen, OpenAI Agents SDK) provides a crash notification or background heartbeat mechanism. This was verified against published documentation for all eight tools.

The TTL is therefore the **universal and only** automatic cleanup mechanism:

1. Agent crashes mid-task with claims held
2. No more heartbeat calls reach the bus
3. After `claim_ttl` seconds (default 120), the cleanup loop expires the claims
4. Any agents waiting on those resources (via `waitForRelease`) are unblocked
5. Pending conflicts are resolved as `holder_expired`

For cases where 120 seconds is too long — a known agent crash detected by an orchestrator — operators can call `forceReleaseAgent(agentId)` to immediately release all claims and unblock waiters.

---

## Waiting for a resource

When an agent wants a resource that is currently held, it has two options:

**Option A — fail fast:** Read the denial response, log the holder's intent, do other work or stop.

**Option B — block until released:** Call `waitForRelease(resourceId)`. The bus parks the HTTP request and fires the response the moment the claim is released or expires. This is a single blocking HTTP call, not a polling loop, and it works regardless of what language or framework the agent is using.

```typescript
// Agent B: block until Agent A releases, then claim
await graft.waitForRelease('src/auth/types.ts')
const claim = await graft.claim({ resourceId: 'src/auth/types.ts', intent: 'adding rate limiting' })
```

A `timeout_ms` parameter (default 30s, max 300s) prevents indefinite blocking.

---

## Bus internals

### registry.ts — ClaimRegistry

In-memory `Map<resourceId, Claim>`. A cleanup loop runs every 10 seconds and expires any claim whose `expiresAt` has passed. Heartbeat calls extend `expiresAt` by `ttl` seconds from now.

Waiters are stored as `Map<resourceId, Array<() => void>>`. When a claim is released (normally, by force, or by TTL expiry), all parked callbacks fire and the waiter list is cleared.

### signals.ts — SignalBus

Per-agent pending queue (`Map<agentId, Signal[]>`). Subscriptions are per signal type. Publishing fans out to all subscribed agents except the sender. Signal history is capped at 10,000 entries.

### pool.ts — ResourcePool

Per-pool queue of available resources. Acquire removes from available; release returns to available and dispatches to the next waiter if the queue was empty.

### deadlock.ts — DeadlockDetector

Runs alongside the TTL cleanup loop. Builds a wait-for graph from active claims and pending `waitForRelease` calls. If a cycle is detected, it force-releases the claim with the oldest `claimedAt` timestamp in the cycle (giving the longest-running agent priority to complete).

### audit.ts — AuditLog

Append-only ring buffer capped at 10,000 entries (configurable). Every bus event is written here with a monotonic sequence number and Unix timestamp. The conflict log and deadlock log live here as separate structures.

---

## Observability

Five debugging surfaces expose what happened, in order:

| Endpoint | Answers |
|----------|---------|
| `GET /audit` | What happened, in order? Filter by agent, resource, type, or time |
| `GET /conflicts` | Which agents collided on what resource? What was the resolution? |
| `GET /deadlocks` | Who was waiting on whom? What cycle formed? How was it broken? |
| `GET /signals/history` | What signals were published and received? By whom? |
| `GET /timeline/:agent_id` | What did this specific agent do from start to finish? |

Use the CLI for interactive debugging:

```bash
graft audit --agent agent-a
graft conflicts list --resource src/auth/types.ts
graft deadlocks show <deadlock_id>
graft signals history --from agent-b
graft timeline agent-a
```

---

## Configuration reference

```yaml
# graft.config.yaml

bus:
  port: 7433
  backend: memory          # memory | redis
  audit_max_entries: 10000

agents:
  heartbeat_interval: 30   # seconds between heartbeats (SDK usage)
  claim_ttl: 120           # seconds before an abandoned claim auto-expires
                           # override per-claim via the ttl parameter

signal_responses:
  security_finding: escalate_to_human   # only hard floor recommended

pools:
  test_database:
    resources:
      - postgres://localhost:5432/test_1
      - postgres://localhost:5432/test_2

waves:
  sprint_wave_1:
    agents: [agent-a, agent-b, agent-c]
    merge_gate: all_complete
```

The `claim_ttl` default of 120 seconds is the key tuning knob. Set it higher for agents that do long local computation between bus calls. Set it lower if you want faster recovery after crashes.

---

## What Graft does not do

- Does not orchestrate agents or assign tasks
- Does not manage agent lifecycles, spawning, or restarts
- Does not persist agent work or handle checkpointing
- Does not replace git worktrees — use them alongside Graft
- Does not detect agent crashes via heartbeat timeouts (no framework supports this — TTL is the mechanism)
