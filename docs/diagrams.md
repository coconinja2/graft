# Graft — Architecture Diagrams

---

## 1. System Architecture

How all components relate — from the bus core through SDK, adapters, and CLI.

```mermaid
graph TD
    config["graft.config.yaml\n(policy, pools, waves)"]

    subgraph BUS["Graft Bus — localhost:7433"]
        direction TB
        audit["audit.ts\nAuditLog · ConflictLog · DeadlockLog"]
        registry["registry.ts\nClaimRegistry\n(TTL · heartbeat · conflict)"]
        signals["signals.ts\nSignalBus\n(pub/sub · history)"]
        pool["pool.ts\nResourcePool\n(acquire · release · queue)"]
        deadlock["deadlock.ts\nDeadlockDetector\n(cycle detection · TTL resolution)"]
        server["server.ts\nFastify HTTP\n20+ REST endpoints"]

        registry -->|writes events| audit
        signals  -->|writes events| audit
        pool     -->|writes events| audit
        deadlock -->|writes events| audit
        deadlock -->|reads + force-releases| registry
        server   --> registry
        server   --> signals
        server   --> pool
        server   --> deadlock
        server   --> audit
    end

    subgraph SDK["SDK"]
        ts["client.ts\nTypeScript GraftClient"]
        py["client.py\nPython GraftClient"]
    end

    subgraph ADAPTERS["Adapters"]
        cc["claude-code/hooks.ts\npreToolUse · postToolUse"]
        mcp["mcp/server.ts\nMCP Server"]
        oai["openai/tools.ts\nOpenAI tool definitions"]
    end

    cli["cli/index.ts\ngraft start · status · audit\nclaims · signals · timeline"]

    config -->|loaded at startup| server
    ts     -->|HTTP| server
    py     -->|HTTP| server
    cc     --> ts
    mcp    --> ts
    oai    --> ts
    cli    -->|HTTP| server
    cli    -->|invokes| cc
```

---

## 2. Claim Flow

What happens between an agent deciding to write a file and the write actually executing.

```mermaid
sequenceDiagram
    participant Agent
    participant Hook as preToolUse Hook
    participant Bus as Graft Bus
    participant Reg as ClaimRegistry
    participant AL as AuditLog

    Agent->>Hook: tool call (Write / Edit / Bash)
    Hook->>Bus: GET /signals/pending?agent_id=X
    Bus-->>Hook: [any queued signals]

    Hook->>Bus: POST /claims
    Bus->>Reg: claim(resourceId, agentId, intent, ttl)

    alt Resource is free
        Reg->>AL: append(claim_granted)
        Reg-->>Bus: { granted: true, claim }
        Bus-->>Hook: { granted: true }
        Hook-->>Agent: ✓ proceed — tool executes
        Agent->>Bus: POST /claims/:id/heartbeat  (postToolUse)
    else Resource held by another agent
        Reg->>AL: append(claim_denied)
        Reg->>AL: recordConflict → pending
        Reg-->>Bus: { granted: false, holder: { agentId, intent } }
        Bus-->>Hook: { granted: false, holder, conflictId }
        Hook-->>Agent: ✗ BLOCKED\n"auth/types.ts held by agent-b:\n adding rate limiting fields"\n+ pending signals
    end
```

---

## 3. Signal Propagation

How a mid-execution discovery reaches other agents without any direct agent-to-agent communication.

```mermaid
sequenceDiagram
    participant A as Agent-A
    participant Bus as Graft Bus
    participant B as Agent-B
    participant C as Agent-C

    Note over A: discovers AuthConfig\ninterface is changing

    A->>Bus: POST /signals\n{ type: interface_change,\n  message: "AuthConfig needs timeout field",\n  severity: medium }
    Bus->>Bus: append(signal_published)\nqueue signal for all\nsubscribed agents ≠ A

    Note over B,C: each agent polls at its next tool boundary

    B->>Bus: GET /signals/pending?agent_id=B
    Bus->>Bus: append(signal_delivered)
    Bus-->>B: [interface_change signal]
    Note over B: reads graft.config.yaml\ninterface_change → checkpoint_and_replay
    B->>B: save state · restart\nwith new context

    C->>Bus: GET /signals/pending?agent_id=C
    Bus->>Bus: append(signal_delivered)
    Bus-->>C: [interface_change signal]
    Note over C: interface_change → incremental_adjust
    C->>C: absorb · continue forward
```

---

## 4. TTL Expiry & Deadlock Resolution

How the bus self-heals when agents crash or create circular waits.

```mermaid
flowchart TD
    timer["Cleanup loop\nevery 10 seconds"]

    timer --> ttl_check["Check all claims:\nexpiresAt ≤ now?"]
    ttl_check -->|yes| expire["Remove claim\nresolveConflicts → holder_expired\nappend claim_expired"]
    ttl_check -->|no| ddcheck["DeadlockDetector.detect()\nbuild wait-for graph"]

    ddcheck --> cycle{"Circular\ndependency?"}
    cycle -->|no| done["Nothing to do"]
    cycle -->|yes| find["Find claim with\noldest claimedAt\nin the cycle"]
    find --> force["forceRelease(resourceId)\nresolveConflicts → force_released"]
    force --> log["recordDeadlock\nappend deadlock_detected\nappend deadlock_resolved"]
    log --> done
```

---

## 5. Resource Pool

How agents share a finite set of stateful resources (test databases, dev ports) without conflicts.

```mermaid
sequenceDiagram
    participant A as Agent-A
    participant B as Agent-B
    participant C as Agent-C
    participant Pool as ResourcePool\n(test_database)

    Note over Pool: resources: [db1, db2]\nboth free

    A->>Pool: acquire(test_database)
    Pool-->>A: db1  ✓

    B->>Pool: acquire(test_database)
    Pool-->>B: db2  ✓

    C->>Pool: acquire(test_database)
    Note over Pool: exhausted — C joins\nwaiter queue
    Pool-->>C: (waiting…)

    A->>Pool: release(test_database, db1)
    Note over Pool: dispatches db1\nto next waiter
    Pool-->>C: db1  ✓

    C->>Pool: release(test_database, db1)
    Note over Pool: db1 available again
```

---

## 6. Wave Gate

How a set of parallel agents synchronize before merging.

```mermaid
stateDiagram-v2
    direction LR

    [*] --> Registered : POST /wave/register\n(all agents declare membership)

    state Registered {
        agent_a : agent-a\npending
        agent_b : agent-b\npending
        agent_c : agent-c\npending
    }

    Registered --> Partial : agent-a posts\nPOST /wave/complete

    state Partial {
        done_a : agent-a ✓
        pending_b : agent-b pending
        pending_c : agent-c pending
    }

    Partial --> AllDone : agent-b and agent-c\npost /wave/complete

    state AllDone {
        all : all_complete ✓\ndone = true
    }

    AllDone --> [*] : agents may merge
```

---

## 7. Debugging surfaces

The five observability endpoints and what each one answers.

```mermaid
graph LR
    question["Something\nwent wrong…"]

    question --> audit["GET /audit\nWhat happened,\nin order?"]
    question --> conflicts["GET /conflicts\nWhich agents\ncollided on what?"]
    question --> deadlocks["GET /deadlocks\nWho was waiting\non whom?"]
    question --> history["GET /signals/history\nWhat signals were\nsent and received?"]
    question --> timeline["GET /timeline/:agent\nWhat did this agent\ndo from start to finish?"]

    audit     --> AuditLog
    conflicts --> ConflictLog
    deadlocks --> DeadlockLog
    history   --> SignalBus
    timeline  --> AuditLog

    subgraph AuditLog["AuditLog (audit.ts)"]
        AL["ring buffer · 10k entries\nseq · ts · type · agentId\nresourceId · detail"]
    end

    subgraph ConflictLog["ConflictLog (audit.ts)"]
        CL["conflictId · requestingAgent\nholdingAgent · resolution\npending → resolved"]
    end

    subgraph DeadlockLog["DeadlockLog (audit.ts)"]
        DL["deadlockId · cycle[]\nresolution · resolvedAt"]
    end

    subgraph SignalBus["SignalBus (signals.ts)"]
        SB["signalId · from · type\ndeliveredTo · status\npending → delivered"]
    end
```
