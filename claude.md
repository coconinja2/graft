# Graft — CLAUDE.md

## What is Graft?

Graft is a shared resource coordination layer for parallel AI coding agents. It solves the problem that git worktrees and isolation-based tools don't solve: agents that are running simultaneously on the same codebase need to know what each other is touching in real time — not at merge time.

Graft brings OS-level concurrency primitives (mutexes, event buses, semaphores, barriers) to the agent layer. Agents claim shared resources before touching them, broadcast signals mid-execution when they discover something that affects other agents, and respond to incoming signals based on user-configured strategies — all without an orchestrator.

The coordination point is the Graft bus — a lightweight local process. Agents never talk to each other directly. They talk to the bus. Policy lives in config. Intelligence stays in the agents.

---

## Project Structure

```
graft/
├── CLAUDE.md                  # This file
├── README.md
├── package.json               # npm package (TypeScript)
├── pyproject.toml             # PyPI package (Python)
├── graft.config.yaml          # Example user config
├── src/
│   ├── bus/
│   │   ├── server.ts          # Graft bus — HTTP server, claim registry, event bus
│   │   ├── registry.ts        # Resource claim registry (in-memory + optional Redis)
│   │   ├── signals.ts         # Signal routing and delivery
│   │   ├── pool.ts            # Stateful resource pool (ports, databases)
│   │   ├── deadlock.ts        # Deadlock detection and resolution
│   │   └── audit.ts           # Append-only audit log, conflict log, deadlock log
│   ├── sdk/
│   │   ├── client.ts          # TypeScript SDK — claim, release, publish, subscribe
│   │   └── python/
│   │       └── client.py      # Python SDK — same interface
│   ├── adapters/
│   │   ├── claude-code/
│   │   │   ├── hooks.ts       # preToolUse and postToolUse hook handlers
│   │   │   └── settings.json  # Claude Code hook config to copy into .claude/
│   │   ├── openai/
│   │   │   └── tools.ts       # OpenAI Agents SDK tool definitions
│   │   └── mcp/
│   │       └── server.ts      # MCP server exposing Graft as Claude tools
│   └── cli/
│       └── index.ts           # `graft` CLI — start, status, claims, signals, config
├── tests/
│   ├── bus/
│   ├── sdk/
│   └── integration/
└── docs/
    ├── architecture.md
    ├── config-reference.md
    └── adapters.md
```

---

## Core Concepts

### Resource Claim
Before any agent touches a shared resource — a file, a port, a database, a schema — it claims it. The claim includes:
- `resource_id` — file path, port number, schema name, or any string key
- `agent_id` — unique identifier for the agent session
- `intent` — human-readable description of what the agent plans to do ("adding OAuth fields to AuthConfig")
- `ttl` — seconds before the claim auto-expires if the agent crashes (default: 120)

Claims are exclusive by default. Two agents cannot hold the same claim simultaneously. The second agent receives the claim holder's identity and intent so it can make an informed decision about how to proceed.

### Signal
An agent publishes a signal when it discovers something that other agents should know about mid-execution. Signals are typed and routed to subscribed agents at their next tool call boundary.

Signal types (user extensible):
- `interface_change` — a shared type or API contract is changing
- `security_finding` — a vulnerability found in shared code
- `schema_change` — a database schema or migration is changing
- `resource_conflict` — an agent hit a resource already in use
- `new_utility` — a shared utility was created that others might want to use

### Signal Response Strategy
Users configure how each agent responds to each signal type. Strategies:
- `incremental_adjust` — agent absorbs signal and continues forward with new context
- `checkpoint_and_replay` — agent saves state, restarts context with signal incorporated
- `wait_and_retry` — agent pauses, holds claims, waits for signaling agent to complete
- `escalate_to_human` — agent stops, writes pause report, releases claims, halts

### Resource Pool
For stateful resources (test databases, dev servers, ports) that can't be shared but have multiple available instances. Agents acquire from the pool, use exclusively, release back.

### Wave Gate (Barrier)
All agents in a declared wave must complete before any proceeds to merge. The bus tracks wave membership and completion signals.

---

## Bus API

The Graft bus runs on `localhost:7433` by default. All endpoints return JSON.

### Claims
```
POST   /claims              — Claim a resource
DELETE /claims/:resource_id — Release a claim
GET    /claims              — List all active claims
GET    /claims/:resource_id — Get claim status for a specific resource
```

### Signals
```
POST /signals               — Publish a signal
GET  /signals/pending       — Get pending signals for an agent (polled at hook boundaries)
POST /signals/subscribe     — Subscribe agent to signal types
```

### Pool
```
POST   /pool/:pool_name/acquire  — Acquire a resource from a named pool
DELETE /pool/:pool_name/release  — Release back to pool
GET    /pool/:pool_name/status   — Pool availability
```

### Wave
```
POST /wave/register    — Register agent as part of a named wave
POST /wave/complete    — Signal wave completion for this agent
GET  /wave/:name       — Wave status — how many agents complete vs pending
```

### Health
```
GET /health            — Bus status, uptime, active claims count
```

### Audit Log
```
GET /audit                          — Full event log, newest first
GET /audit?agent=<agent_id>         — Filter by agent
GET /audit?resource=<resource_id>   — Filter by resource
GET /audit?type=<event_type>        — Filter by event type (claim_granted, claim_denied, claim_expired, claim_released, signal_published, signal_delivered, pool_acquired, pool_released, deadlock_detected, deadlock_resolved)
GET /audit?since=<unix_timestamp>   — Events after timestamp
GET /audit?limit=<n>                — Cap results (default 200)
```

### Signal History
```
GET /signals/history                        — All delivered/expired signals
GET /signals/history?agent=<agent_id>       — Signals received by agent
GET /signals/history?from=<agent_id>        — Signals sent by agent
GET /signals/history?type=<signal_type>     — Filter by signal type
```

### Conflicts
```
GET /conflicts                      — All recorded claim conflicts (both resolved and pending)
GET /conflicts?agent=<agent_id>     — Conflicts involving an agent
GET /conflicts?resource=<resource>  — Conflicts on a specific resource
GET /conflicts/:conflict_id         — Full detail: agents, resource, resolution, duration
```

### Deadlocks
```
GET /deadlocks                      — Current and recently resolved deadlocks
GET /deadlocks/:deadlock_id         — Dependency graph: agents, resources, cycle path, resolution
```

### Agent Timeline
```
GET /timeline/:agent_id             — Chronological event stream for an agent session
GET /timeline/:agent_id?since=<ts>  — Timeline from a point in time
```

---

## Debugging & Observability

Graft provides five debugging surfaces for diagnosing parallel agent coordination problems. All are temporal — they show what happened, not just what is.

### Audit Log

The foundation of all debugging. Every bus event is appended to an in-memory audit log with a monotonic sequence number and Unix timestamp.

Logged event types:
- `claim_granted` — resource claimed successfully
- `claim_denied` — resource already held; includes holder identity and intent
- `claim_expired` — TTL elapsed, claim auto-released by cleanup loop
- `claim_released` — agent released claim explicitly
- `signal_published` — agent published a signal
- `signal_delivered` — signal dequeued by a polling agent
- `pool_acquired` — agent acquired a pool resource
- `pool_released` — agent returned a pool resource
- `deadlock_detected` — circular dependency found
- `deadlock_resolved` — deadlock broken (by TTL priority or force release)

Each audit entry shape:
```typescript
interface AuditEntry {
  seq: number           // monotonic, never reused
  ts: number            // Unix ms
  type: AuditEventType
  agentId: string
  resourceId?: string
  signalId?: string
  conflictId?: string
  deadlockId?: string
  detail: Record<string, unknown>  // event-specific payload
}
```

The audit log is capped at 10,000 entries by default (configurable via `bus.audit_max_entries`). Oldest entries are dropped when the cap is hit. For persistent audit logs, set `bus.backend: redis` — entries are appended to a Redis list.

### Signal History

Signals are removed from the pending queue once delivered. Signal history preserves a record of every signal after delivery or expiry.

Each history entry includes:
- Signal payload (type, message, affectedResources, severity)
- Publishing agent and timestamp
- Delivery timestamp and receiving agent (or `expired` if never polled)

### Conflict Log

When a claim is denied, the bus records a conflict entry:
```typescript
interface ConflictEntry {
  conflictId: string
  resourceId: string
  requestingAgent: { agentId: string; intent: string }
  holdingAgent: { agentId: string; intent: string; claimedAt: number; ttl: number }
  ts: number
  resolution?: 'holder_released' | 'holder_expired' | 'force_released' | 'pending'
  resolvedAt?: number
}
```

Conflicts remain `pending` until the hold is released or expires. This lets you see stuck conflicts in real time.

### Deadlock Inspector

When `src/bus/deadlock.ts` detects a cycle, it records the full dependency graph:
```typescript
interface DeadlockEntry {
  deadlockId: string
  ts: number
  cycle: Array<{ agentId: string; waitingFor: string; heldBy: string }>
  resolution: 'expired_oldest_claim' | 'force_released' | 'pending'
  resolvedAt?: number
}
```

Detection runs every 10 seconds alongside the TTL cleanup loop. Resolution strategy: expire the claim with the oldest `claimedAt` timestamp in the cycle (gives longest-running agents priority to complete).

### Agent Timeline

A chronological view of all audit entries for a single agent session. Useful for reconstructing exactly what an agent did, when it hit conflicts, what signals it received, and how it responded.

Timeline entries are audit log entries filtered and sorted by agent. The timeline endpoint also injects synthetic `session_start` and `session_end` markers derived from the first and last audit entries for the agent.

---

## Debugging CLI

```bash
# Audit log — full or filtered
graft audit
graft audit --agent agent-a
graft audit --resource src/auth/types.ts
graft audit --type claim_denied
graft audit --since 1714500000
graft audit --limit 50

# Signal history
graft signals history
graft signals history --agent agent-a
graft signals history --from agent-b

# Conflict log
graft conflicts list
graft conflicts list --agent agent-a
graft conflicts list --resource src/auth/types.ts
graft conflicts show <conflict_id>

# Deadlock inspector
graft deadlocks list
graft deadlocks show <deadlock_id>

# Agent timeline
graft timeline agent-a
graft timeline agent-a --since 1714500000
```

---

## Debugging Implementation Notes

### Where to implement

- Audit log writer: `src/bus/audit.ts` — `AuditLog` class, append-only, capped ring buffer
- Plug audit writes into: `registry.ts` (claims), `signals.ts` (publish/deliver), `pool.ts` (acquire/release), `deadlock.ts` (detect/resolve)
- Conflict log: stored inside `registry.ts` alongside active claims
- API routes: add to `src/bus/server.ts` under `/audit`, `/signals/history`, `/conflicts`, `/deadlocks`, `/timeline/:agent_id`
- CLI commands: add to `src/cli/index.ts`

### Config additions

```yaml
bus:
  audit_max_entries: 10000    # ring buffer cap; 0 = unlimited (redis only)
  audit_enabled: true         # set false to disable for performance
```

---

## Claude Code Integration

Graft installs as Claude Code hooks. Copy the hook config into your project:

```bash
graft install --claude-code
```

This writes to `.claude/settings.json`:

```json
{
  "hooks": {
    "preToolUse": "graft hook pre --tool $TOOL_NAME --input '$TOOL_INPUT'",
    "postToolUse": "graft hook post --tool $TOOL_NAME --output '$TOOL_OUTPUT'"
  }
}
```

### What the preToolUse hook does

Before every `Write`, `Edit`, `Bash`, or `NotebookEdit` tool call:

1. Extracts the target resource (file path, port, database) from tool input
2. Calls `POST /claims` — attempts to claim the resource
3. If claim granted — passes through, tool executes normally
4. If claim held by another agent — returns context to Claude:
   ```
   Resource auth/types.ts is currently claimed by agent-b2f3.
   Agent intent: "adding rate limiting fields to AuthConfig"
   Suggested action: [per graft.config.yaml signal_responses]
   Pending signals for you: [any queued signals]
   ```
5. Delivers any pending signals from the bus to Claude in the same response

### What the postToolUse hook does

After every tool call:
1. If the tool was a file write — keeps the claim active, refreshes TTL
2. If the tool was a read — releases the claim immediately
3. Checks for any new signals since last hook fire — queues for next pre hook

---

## OpenAI Agents SDK Integration

Graft exposes as tools that agents call natively:

```typescript
import { graftTools } from 'graft/openai'

const agent = new Agent({
  name: 'coding_agent',
  tools: [
    ...graftTools({ busUrl: 'http://localhost:7433', agentId: 'agent-a' }),
    ...yourOtherTools
  ]
})
```

Tools exposed: `graft_claim`, `graft_release`, `graft_publish_signal`, `graft_get_signals`, `graft_acquire_pool`, `graft_release_pool`, `graft_wave_complete`

---

## MCP Server Integration

Graft runs as an MCP server for any MCP-compatible agent:

```bash
graft mcp --port 7434
```

Add to Claude's MCP config:
```json
{
  "mcpServers": {
    "graft": {
      "url": "http://localhost:7434/mcp"
    }
  }
}
```

---

## User Configuration — graft.config.yaml

```yaml
bus:
  port: 7433
  backend: memory          # memory | redis
  redis_url: redis://localhost:6379  # only if backend: redis

agents:
  heartbeat_interval: 30   # seconds between heartbeats
  claim_ttl: 120           # seconds before abandoned claim expires

signal_responses:
  interface_change:    checkpoint_and_replay
  security_finding:    escalate_to_human
  schema_change:       checkpoint_and_replay
  resource_conflict:   wait_and_retry
  new_utility:         incremental_adjust

pools:
  test_database:
    resources:
      - postgres://localhost:5432/test_1
      - postgres://localhost:5432/test_2
      - postgres://localhost:5432/test_3
  dev_port:
    resources: [3001, 3002, 3003, 3004]

waves:
  sprint_wave_1:
    agents: [agent-a, agent-b, agent-c, agent-d]
    merge_gate: all_complete    # all_complete | majority | any
```

---

## CLI

```bash
# Start the Graft bus
graft start

# Install hooks for your agent framework
graft install --claude-code
graft install --openai
graft install --mcp

# Monitor active claims and signals in real time
graft status

# List all active claims
graft claims list

# Manually release a stuck claim
graft claims release auth/types.ts

# View pending signals
graft signals list

# Publish a signal manually (for testing)
graft signals publish --type interface_change --message "AuthConfig now requires timeout field"

# Check wave status
graft wave status sprint_wave_1

# View bus logs
graft logs

# Stop the bus
graft stop
```

---

## SDK Usage

### TypeScript

```typescript
import { GraftClient } from 'graft'

const graft = new GraftClient({
  busUrl: 'http://localhost:7433',
  agentId: 'agent-a'
})

// Claim a resource before writing
const claim = await graft.claim({
  resourceId: 'src/auth/types.ts',
  intent: 'adding OAuth provider fields to AuthConfig',
  ttl: 120
})

if (claim.granted) {
  // safe to write
  await writeFile('src/auth/types.ts', newContent)
  await graft.release('src/auth/types.ts')
} else {
  // resource held by another agent
  console.log(`Held by ${claim.holder.agentId}: ${claim.holder.intent}`)
  // handle per signal_responses config
}

// Publish a signal when you discover something important
await graft.publish({
  type: 'interface_change',
  message: 'AuthConfig now requires timeout: number field',
  affectedResources: ['src/auth/types.ts'],
  severity: 'medium'
})

// Check for pending signals at each tool boundary
const signals = await graft.getPendingSignals()
for (const signal of signals) {
  console.log(`Signal from ${signal.from}: ${signal.message}`)
}

// Acquire from a pool
const db = await graft.acquirePool('test_database')
await runTests(db.resource)
await graft.releasePool('test_database', db.resource)
```

### Python

```python
from graft import GraftClient

graft = GraftClient(
    bus_url="http://localhost:7433",
    agent_id="agent-b"
)

# Claim a resource
claim = graft.claim(
    resource_id="src/auth/types.ts",
    intent="adding rate limiting fields",
    ttl=120
)

if claim.granted:
    # safe to proceed
    graft.release("src/auth/types.ts")
else:
    print(f"Held by {claim.holder.agent_id}: {claim.holder.intent}")

# Subscribe to signal types
graft.subscribe(["interface_change", "schema_change"])

# Get pending signals
signals = graft.get_pending_signals()
```

---

## Build Instructions for Claude

When implementing Graft, follow this build order:

### Phase 1 — Bus core
1. Build `src/bus/audit.ts` — append-only AuditLog class (ring buffer, capped), ConflictLog, DeadlockLog; all other modules import and write to this
2. Build `src/bus/registry.ts` — in-memory claim registry with TTL expiry and heartbeat tracking; writes claim_granted, claim_denied, claim_expired, claim_released to audit; writes ConflictEntry on deny
3. Build `src/bus/signals.ts` — signal queue per agent, pub/sub routing by signal type; writes signal_published, signal_delivered to audit; maintains signal history
4. Build `src/bus/pool.ts` — resource pool with acquire/release and availability tracking; writes pool_acquired, pool_released to audit
5. Build `src/bus/deadlock.ts` — detect circular claim dependencies, resolve by TTL priority; writes deadlock_detected, deadlock_resolved to audit; writes DeadlockEntry
6. Build `src/bus/server.ts` — Fastify HTTP server wiring all modules to REST endpoints, including /audit, /signals/history, /conflicts, /deadlocks, /timeline/:agent_id

### Phase 2 — SDK
6. Build `src/sdk/client.ts` — TypeScript client wrapping all bus endpoints with typed interfaces
7. Build `src/sdk/python/client.py` — Python client, same interface, using httpx

### Phase 3 — Adapters
8. Build `src/adapters/claude-code/hooks.ts` — preToolUse handler that extracts resource from tool input, calls claim, delivers pending signals in response; postToolUse handler that refreshes or releases claim
9. Build `src/adapters/mcp/server.ts` — MCP server exposing graft_claim, graft_release, graft_publish_signal, graft_get_signals, graft_acquire_pool, graft_release_pool as MCP tools
10. Build `src/adapters/openai/tools.ts` — OpenAI function tool definitions wrapping the same SDK calls

### Phase 4 — CLI
11. Build `src/cli/index.ts` — Commander.js CLI with start, stop, status, claims, signals, wave, install, logs commands

### Phase 5 — Tests
12. Unit tests for audit — append, ring buffer cap, filter by agent/resource/type/since, conflict log entries, deadlock log entries
13. Unit tests for registry — claim grant, claim deny, TTL expiry, heartbeat refresh; verify audit entries written on each event
14. Unit tests for signals — publish, subscribe, delivery at poll; verify signal history populated after delivery
15. Unit tests for pool — acquire, release, exhaustion, queue
16. Unit tests for deadlock — circular dependency detection, resolution; verify deadlock log entries
17. Integration test — two simulated agents claiming overlapping resources, signal delivery, wave gate; assert full audit trail and conflict log entries are correct

---

## Key Implementation Rules

**No orchestrator** — The bus is infrastructure, not an agent. It routes signals and enforces claims based on config. It makes no decisions about what agents should do. All decision logic lives in the agent's response to hook output or signal delivery.

**Claims are advisory for reads, mandatory for writes** — Agents should claim before writing. Reading without a claim is allowed. The bus tracks read-claims separately and never blocks reads.

**Signals are delivered at poll, never pushed** — Agents poll for signals at preToolUse boundaries. The bus queues signals per agent. No WebSocket, no long-polling. Keep it simple.

**TTL is the safety net** — Every claim has a TTL. If an agent crashes, its claims expire automatically. The bus runs a cleanup loop every 10 seconds to expire stale claims and release pool resources.

**Config drives behavior, not code** — Signal response strategies live in `graft.config.yaml`. The bus reads this at startup. Agents read it to know how to respond to signals. No hardcoded behavior.

**Framework agnostic** — The bus is a plain HTTP server. The SDK is a plain HTTP client. Adapters are thin wrappers. Nothing about Graft requires LangGraph, LangChain, or any specific agent framework.

**Fail open** — If the bus is unreachable, agents should log a warning and proceed normally. Graft is a coordination layer, not a hard dependency. A crashed bus should not crash an agent fleet.

---

## What Graft Does NOT Do

- Does not orchestrate agents or assign tasks
- Does not manage agent lifecycles or spawning
- Does not persist agent work or handle checkpointing (use git-stint for that)
- Does not provide agent monitoring UI (use Galactic for that)
- Does not implement the Scout-and-Wave planning protocol (use scout-and-wave for that)
- Does not replace git worktrees — use them alongside Graft

Graft is the missing coordination layer that makes all of the above tools more effective when agents share resources.

---

## Complementary Tools

Graft is designed to work alongside, not replace:

| Tool | What it does | How it pairs with Graft |
|---|---|---|
| git-stint | Session-scoped branch and worktree management | git-stint isolates agent sessions; Graft coordinates shared resources across sessions |
| scout-and-wave | Pre-execution dependency planning protocol | Scout-and-Wave plans file ownership upfront; Graft enforces it at runtime and handles cases Scout declares NOT SUITABLE |
| Galactic | Desktop app for worktree and environment management | Galactic manages network isolation; Graft manages resource coordination |
| Gas Town | Multi-agent workspace manager | Gas Town manages task assignment; Graft manages resource conflicts within tasks |

---

## Article Reference

This project is the implementation of the coordination pattern described in the Medium article series:

1. "Parallel Agents Are Just Multithreading" — the concurrency primitives mapped to agents
2. "Isolation Isn't Coordination" — why worktrees solve the wrong problem
3. "Graft: Runtime Resource Coordination for Parallel Coding Agents" — this implementation

The article series is the whitepaper. Graft is the reference implementation.