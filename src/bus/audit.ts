import { randomUUID } from 'crypto'

export type AuditEventType =
  | 'claim_granted'
  | 'claim_denied'
  | 'claim_expired'
  | 'claim_released'
  | 'signal_published'
  | 'signal_delivered'
  | 'pool_acquired'
  | 'pool_released'
  | 'deadlock_detected'
  | 'deadlock_resolved'

export interface AuditEntry {
  seq: number
  ts: number
  type: AuditEventType
  agentId: string
  resourceId?: string
  signalId?: string
  conflictId?: string
  deadlockId?: string
  detail: Record<string, unknown>
}

export interface ConflictEntry {
  conflictId: string
  resourceId: string
  requestingAgent: { agentId: string; intent: string }
  holdingAgent: { agentId: string; intent: string; claimedAt: number; ttl: number }
  ts: number
  resolution: 'holder_released' | 'holder_expired' | 'force_released' | 'pending'
  resolvedAt?: number
}

export interface DeadlockEntry {
  deadlockId: string
  ts: number
  cycle: Array<{ agentId: string; waitingFor: string; heldBy: string }>
  resolution: 'expired_oldest_claim' | 'force_released' | 'pending'
  resolvedAt?: number
}

export interface AuditFilter {
  agentId?: string
  resourceId?: string
  type?: AuditEventType
  since?: number
  limit?: number
}

export class AuditLog {
  private entries: AuditEntry[] = []
  private conflicts: Map<string, ConflictEntry> = new Map()
  private deadlocks: Map<string, DeadlockEntry> = new Map()
  private seq = 0
  private maxEntries: number
  readonly enabled: boolean

  constructor(maxEntries = 10_000, enabled = true) {
    this.maxEntries = maxEntries
    this.enabled = enabled
  }

  append(
    type: AuditEventType,
    agentId: string,
    fields: Partial<Omit<AuditEntry, 'seq' | 'ts' | 'type' | 'agentId'>> = {}
  ): void {
    if (!this.enabled) return
    const entry: AuditEntry = {
      seq: ++this.seq,
      ts: Date.now(),
      type,
      agentId,
      detail: fields.detail ?? {},
      ...fields,
    }
    this.entries.push(entry)
    if (this.maxEntries > 0 && this.entries.length > this.maxEntries) {
      this.entries.shift()
    }
  }

  query(filter: AuditFilter = {}): AuditEntry[] {
    let result = this.entries.slice()
    if (filter.agentId) result = result.filter(e => e.agentId === filter.agentId)
    if (filter.resourceId) result = result.filter(e => e.resourceId === filter.resourceId)
    if (filter.type) result = result.filter(e => e.type === filter.type)
    if (filter.since != null) result = result.filter(e => e.ts >= filter.since!)
    result = result.reverse()
    return result.slice(0, filter.limit ?? 200)
  }

  getTimeline(agentId: string, since?: number): AuditEntry[] {
    let result = this.entries.filter(e => e.agentId === agentId)
    if (since != null) result = result.filter(e => e.ts >= since)
    return result
  }

  // Conflict log

  recordConflict(entry: Omit<ConflictEntry, 'conflictId' | 'ts' | 'resolution'>): ConflictEntry {
    const conflict: ConflictEntry = {
      ...entry,
      conflictId: randomUUID(),
      ts: Date.now(),
      resolution: 'pending',
    }
    this.conflicts.set(conflict.conflictId, conflict)
    return conflict
  }

  resolveConflict(conflictId: string, resolution: ConflictEntry['resolution']): void {
    const c = this.conflicts.get(conflictId)
    if (c && c.resolution === 'pending') {
      c.resolution = resolution
      c.resolvedAt = Date.now()
    }
  }

  resolveConflictsByResource(resourceId: string, resolution: ConflictEntry['resolution']): void {
    for (const c of this.conflicts.values()) {
      if (c.resourceId === resourceId && c.resolution === 'pending') {
        c.resolution = resolution
        c.resolvedAt = Date.now()
      }
    }
  }

  queryConflicts(filter: { agentId?: string; resourceId?: string } = {}): ConflictEntry[] {
    let result = Array.from(this.conflicts.values())
    if (filter.agentId) {
      result = result.filter(
        c => c.requestingAgent.agentId === filter.agentId || c.holdingAgent.agentId === filter.agentId
      )
    }
    if (filter.resourceId) result = result.filter(c => c.resourceId === filter.resourceId)
    return result.sort((a, b) => b.ts - a.ts)
  }

  getConflict(conflictId: string): ConflictEntry | undefined {
    return this.conflicts.get(conflictId)
  }

  // Deadlock log

  recordDeadlock(entry: Omit<DeadlockEntry, 'deadlockId' | 'ts' | 'resolution'>): DeadlockEntry {
    const deadlock: DeadlockEntry = {
      ...entry,
      deadlockId: randomUUID(),
      ts: Date.now(),
      resolution: 'pending',
    }
    this.deadlocks.set(deadlock.deadlockId, deadlock)
    return deadlock
  }

  resolveDeadlock(deadlockId: string, resolution: DeadlockEntry['resolution']): void {
    const d = this.deadlocks.get(deadlockId)
    if (d) {
      d.resolution = resolution
      d.resolvedAt = Date.now()
    }
  }

  queryDeadlocks(): DeadlockEntry[] {
    return Array.from(this.deadlocks.values()).sort((a, b) => b.ts - a.ts)
  }

  getDeadlock(deadlockId: string): DeadlockEntry | undefined {
    return this.deadlocks.get(deadlockId)
  }
}
