# Graft

Shared resource coordination layer for parallel AI coding agents.

Graft brings OS-level concurrency primitives — mutexes, event buses, semaphores, barriers — to the agent layer. Agents claim shared resources before touching them, broadcast signals mid-execution when they discover something others should know, and respond to incoming signals at each tool boundary. No orchestrator. No merge step. Conflicts surface at write time, not at merge time.

## Installation

### TypeScript/Node.js
```bash
npm install
npm run build
```

### Python
```bash
pip install .
```

## Quick Start

Start the Graft bus:
```bash
graft start
```

Copy the Claude Code hooks into your project:
```bash
graft install --claude-code
```

Run agents normally — Graft coordinates automatically via `PreToolUse` and `PostToolUse` hooks.

## Benchmark: Graft vs Sequential vs Git Worktrees

Measured on a real project (loginapp) with 5 independent tasks run three ways. Each task creates a new TypeScript source file.

| Approach | Time | Speedup |
|---|---|---|
| Sequential (baseline) | 37s | 1× |
| **Graft parallel** | **12s** | **3×** |
| Git worktree parallel | 19s | 1.9× |

**Graft is 7s faster than worktrees** even when there are zero conflicts between agents.

### Why Graft beats worktrees

Git worktree parallel time breaks down as:

```
Setup (create 5 branches + checkout):   1s
Parallel agent work:                    18s
Merge (cherry-pick 5 branches):          0s  ← lucky, no conflicts this time
Total:                                  19s
```

Graft parallel time:

```
Setup:                                   0s  ← agents start immediately
Parallel agent work:                    12s
Merge:                                   0s  ← already in shared directory
Total:                                  12s
```

Two structural reasons for the gap:

1. **Worktree agents start cold.** Each isolated worktree directory has its own copy of the repo. Every file read is a cache miss. Graft agents share the same working directory — the second agent to read a file hits the OS page cache.

2. **Conflicts surface at the wrong time.** Worktrees detect write conflicts at merge time, after all agents have finished. Graft detects them at write time, mid-execution. When agent B gets blocked by agent A's claim, it sees exactly what A is doing (`intent` field) and can decide immediately whether to wait, work on something else, or inform the user — instead of discovering a merge conflict hours later.

### Graft audit from the parallel run

Every tool call is coordinated through the bus. With 5 independent tasks, all 5 claims are granted immediately and all 5 agents run in parallel with zero blocking:

```
[16] claim_granted   par-3  [validators.ts]
[17] signal_published par-3
[18] claim_granted   par-4  [csrf.ts]
[19] signal_published par-4
[20] claim_granted   par-5  [Stats.tsx]
[21] signal_published par-5
[22] claim_granted   par-1  [Spinner.tsx]
[23] signal_published par-1
[24] claim_granted   par-2  [Avatar.tsx]
[25] signal_published par-2
```

Each agent also broadcasts a `change_summary` signal on completion, so every other agent is informed of what changed — no post-merge discovery.

### When worktrees win

Worktrees make sense when agents are deliberately working on completely separate branches of a codebase with no shared files and no need to communicate mid-run. Graft makes sense when agents share files, need to broadcast discoveries to each other, or when you want conflict detection before merge rather than after.

## Architecture

For full architecture documentation, see [docs/architecture.md](docs/architecture.md).

The short version: Graft is a lightweight HTTP bus (`localhost:7433`) that agents talk to via hooks or SDK. It tracks resource claims, routes signals between agents, manages resource pools, and detects deadlocks. Every event is written to an append-only audit log.

```
Agent A ──POST /claims──► Bus ──denied──► Agent B waits
Agent A ──POST /signals──► Bus ──delivers at next hook boundary──► Agent C
Agent A ──DELETE /claims──► Bus ──notifies waiters──► Agent B proceeds
```

For configuration, adapters (Claude Code, OpenAI Agents SDK, MCP), and the full API reference, see [CLAUDE.md](CLAUDE.md).
