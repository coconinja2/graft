import { randomUUID } from 'crypto'
import { AuditLog } from './audit'

export interface LineRange {
  start: number  // 1-based, inclusive
  end: number    // 1-based, inclusive
}

export interface Claim {
  claimId: string
  resourceId: string
  agentId: string
  intent: string
  ttl: number
  claimedAt: number
  expiresAt: number
  lastHeartbeat: number
  claimType: 'write' | 'read'
  lineRange?: LineRange  // undefined = whole-file claim
}

export interface ClaimRequest {
  resourceId: string
  agentId: string
  intent: string
  ttl?: number
  claimType?: 'write' | 'read'
  lineRange?: LineRange
}

export interface ClaimResult {
  granted: boolean
  claim?: Claim
  holder?: { agentId: string; intent: string; claimedAt: number; ttl: number; lineRange?: LineRange }
  conflictId?: string
}

// Two ranges conflict when either is a whole-file claim (undefined) or their
// line ranges overlap. Overlap: [a.start, a.end] ∩ [b.start, b.end] ≠ ∅
function rangesOverlap(a: LineRange | undefined, b: LineRange | undefined): boolean {
  if (!a || !b) return true
  return a.start <= b.end && b.start <= a.end
}

export class ClaimRegistry {
  // Primary storage: resourceId → all active claims on that file (multiple non-overlapping ranges allowed)
  private claims: Map<string, Claim[]> = new Map()
  // Secondary index for O(1) lookup/release by claim ID
  private claimsById: Map<string, Claim> = new Map()
  private waiters: Map<string, Array<() => void>> = new Map()
  private audit: AuditLog
  private defaultTtl: number
  private cleanupTimer: NodeJS.Timeout

  constructor(audit: AuditLog, defaultTtl = 120) {
    this.audit = audit
    this.defaultTtl = defaultTtl
    this.cleanupTimer = setInterval(() => this.cleanup(), 10_000)
    this.cleanupTimer.unref()
  }

  claim(req: ClaimRequest): ClaimResult {
    const existing = this.claims.get(req.resourceId) ?? []
    const now = Date.now()

    for (const c of existing) {
      if (c.claimType !== 'write') continue
      if (c.expiresAt <= now) continue
      if (c.agentId === req.agentId) continue
      if (!rangesOverlap(c.lineRange, req.lineRange)) continue

      const conflict = this.audit.recordConflict({
        resourceId: req.resourceId,
        requestingAgent: { agentId: req.agentId, intent: req.intent },
        holdingAgent: { agentId: c.agentId, intent: c.intent, claimedAt: c.claimedAt, ttl: c.ttl },
      })
      this.audit.append('claim_denied', req.agentId, {
        resourceId: req.resourceId,
        conflictId: conflict.conflictId,
        detail: { holder: c.agentId, holderIntent: c.intent, lineRange: req.lineRange, conflictingRange: c.lineRange },
      })
      return {
        granted: false,
        holder: { agentId: c.agentId, intent: c.intent, claimedAt: c.claimedAt, ttl: c.ttl, lineRange: c.lineRange },
        conflictId: conflict.conflictId,
      }
    }

    const ttl = req.ttl ?? this.defaultTtl
    const claim: Claim = {
      claimId: randomUUID(),
      resourceId: req.resourceId,
      agentId: req.agentId,
      intent: req.intent,
      ttl,
      claimedAt: now,
      expiresAt: now + ttl * 1000,
      lastHeartbeat: now,
      claimType: req.claimType ?? 'write',
      lineRange: req.lineRange,
    }

    if (!this.claims.has(req.resourceId)) this.claims.set(req.resourceId, [])
    this.claims.get(req.resourceId)!.push(claim)
    this.claimsById.set(claim.claimId, claim)

    this.audit.append('claim_granted', req.agentId, {
      resourceId: req.resourceId,
      detail: { intent: req.intent, ttl, claimType: claim.claimType, lineRange: claim.lineRange },
    })
    return { granted: true, claim }
  }

  release(resourceId: string, agentId: string, lineRange?: LineRange): boolean {
    const existing = this.claims.get(resourceId)
    if (!existing) return false

    const toRemove = existing.filter(c => {
      if (c.agentId !== agentId) return false
      if (lineRange) {
        return c.lineRange?.start === lineRange.start && c.lineRange?.end === lineRange.end
      }
      return true
    })
    if (toRemove.length === 0) return false

    for (const c of toRemove) this.claimsById.delete(c.claimId)

    const remaining = existing.filter(c => !toRemove.includes(c))
    if (remaining.length === 0) {
      this.claims.delete(resourceId)
    } else {
      this.claims.set(resourceId, remaining)
    }

    this.audit.resolveConflictsByResource(resourceId, 'holder_released')
    this.audit.append('claim_released', agentId, {
      resourceId,
      detail: { lineRange, count: toRemove.length },
    })
    this.notifyWaiters(resourceId)
    return true
  }

  releaseById(claimId: string, agentId: string): boolean {
    const claim = this.claimsById.get(claimId)
    if (!claim || claim.agentId !== agentId) return false
    return this.release(claim.resourceId, agentId, claim.lineRange)
  }

  forceRelease(resourceId: string): boolean {
    const existing = this.claims.get(resourceId)
    if (!existing || existing.length === 0) return false

    const agentIds = new Set(existing.map(c => c.agentId))
    for (const c of existing) this.claimsById.delete(c.claimId)
    this.claims.delete(resourceId)

    this.audit.resolveConflictsByResource(resourceId, 'force_released')
    for (const agentId of agentIds) {
      this.audit.append('claim_released', agentId, { resourceId, detail: { forced: true } })
    }
    this.notifyWaiters(resourceId)
    return true
  }

  addWaiter(resourceId: string, cb: () => void): () => void {
    if (!this.waiters.has(resourceId)) this.waiters.set(resourceId, [])
    const list = this.waiters.get(resourceId)!
    list.push(cb)
    return () => {
      const i = list.indexOf(cb)
      if (i !== -1) list.splice(i, 1)
    }
  }

  private notifyWaiters(resourceId: string): void {
    // Only fire waiters when the resource has no remaining claims at all
    if (this.get(resourceId).length > 0) return
    const cbs = this.waiters.get(resourceId)
    if (!cbs?.length) return
    this.waiters.delete(resourceId)
    for (const cb of cbs) cb()
  }

  heartbeat(resourceId: string, agentId: string): boolean {
    const existing = this.claims.get(resourceId) ?? []
    const now = Date.now()
    let found = false
    for (const c of existing) {
      if (c.agentId !== agentId) continue
      c.lastHeartbeat = now
      c.expiresAt = now + c.ttl * 1000
      found = true
    }
    return found
  }

  heartbeatById(claimId: string, agentId: string): boolean {
    const claim = this.claimsById.get(claimId)
    if (!claim || claim.agentId !== agentId) return false
    const now = Date.now()
    claim.lastHeartbeat = now
    claim.expiresAt = now + claim.ttl * 1000
    return true
  }

  forceReleaseAgent(agentId: string): string[] {
    const released: string[] = []
    for (const [resourceId, claims] of this.claims) {
      const toRemove = claims.filter(c => c.agentId === agentId)
      if (toRemove.length === 0) continue

      for (const c of toRemove) this.claimsById.delete(c.claimId)

      const remaining = claims.filter(c => c.agentId !== agentId)
      if (remaining.length === 0) {
        this.claims.delete(resourceId)
      } else {
        this.claims.set(resourceId, remaining)
      }

      this.audit.resolveConflictsByResource(resourceId, 'force_released')
      this.audit.append('claim_released', agentId, {
        resourceId,
        detail: { forced: true, reason: 'agent_dead', count: toRemove.length },
      })
      this.notifyWaiters(resourceId)
      released.push(resourceId)
    }
    return released
  }

  /** Returns all non-expired claims on a resource. Empty array = resource is free. */
  get(resourceId: string): Claim[] {
    const now = Date.now()
    return (this.claims.get(resourceId) ?? []).filter(c => c.expiresAt > now)
  }

  getById(claimId: string): Claim | undefined {
    const c = this.claimsById.get(claimId)
    return c && c.expiresAt > Date.now() ? c : undefined
  }

  list(): Claim[] {
    const now = Date.now()
    const result: Claim[] = []
    for (const claims of this.claims.values()) {
      for (const c of claims) {
        if (c.expiresAt > now) result.push(c)
      }
    }
    return result
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [resourceId, claims] of this.claims) {
      const expired = claims.filter(c => c.expiresAt <= now)
      const remaining = claims.filter(c => c.expiresAt > now)

      for (const c of expired) {
        this.claimsById.delete(c.claimId)
        this.audit.resolveConflictsByResource(resourceId, 'holder_expired')
        this.audit.append('claim_expired', c.agentId, {
          resourceId,
          detail: { intent: c.intent, ttl: c.ttl, lineRange: c.lineRange },
        })
      }

      if (remaining.length === 0) {
        this.claims.delete(resourceId)
        if (expired.length > 0) this.notifyWaiters(resourceId)
      } else {
        this.claims.set(resourceId, remaining)
      }
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer)
  }
}
