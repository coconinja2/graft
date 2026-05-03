import { AuditLog } from './audit'

export interface Claim {
  resourceId: string
  agentId: string
  intent: string
  ttl: number
  claimedAt: number
  expiresAt: number
  lastHeartbeat: number
  claimType: 'write' | 'read'
}

export interface ClaimRequest {
  resourceId: string
  agentId: string
  intent: string
  ttl?: number
  claimType?: 'write' | 'read'
}

export interface ClaimResult {
  granted: boolean
  claim?: Claim
  holder?: { agentId: string; intent: string; claimedAt: number; ttl: number }
  conflictId?: string
}

export class ClaimRegistry {
  private claims: Map<string, Claim> = new Map()
  private waiters: Map<string, Array<() => void>> = new Map()
  private agentLastSeen: Map<string, number> = new Map()
  private audit: AuditLog
  private defaultTtl: number
  private deadAgentTimeout: number
  private cleanupTimer: NodeJS.Timeout

  constructor(audit: AuditLog, defaultTtl = 120, deadAgentTimeout = 30) {
    this.audit = audit
    this.defaultTtl = defaultTtl
    this.deadAgentTimeout = deadAgentTimeout * 1000
    this.cleanupTimer = setInterval(() => this.cleanup(), 10_000)
    this.cleanupTimer.unref()
  }

  private touch(agentId: string): void {
    this.agentLastSeen.set(agentId, Date.now())
  }

  claim(req: ClaimRequest): ClaimResult {
    this.touch(req.agentId)
    const existing = this.claims.get(req.resourceId)
    const now = Date.now()

    if (existing && existing.claimType === 'write' && existing.expiresAt > now && existing.agentId !== req.agentId) {
      const conflict = this.audit.recordConflict({
        resourceId: req.resourceId,
        requestingAgent: { agentId: req.agentId, intent: req.intent },
        holdingAgent: {
          agentId: existing.agentId,
          intent: existing.intent,
          claimedAt: existing.claimedAt,
          ttl: existing.ttl,
        },
      })
      this.audit.append('claim_denied', req.agentId, {
        resourceId: req.resourceId,
        conflictId: conflict.conflictId,
        detail: { holder: existing.agentId, holderIntent: existing.intent },
      })
      return {
        granted: false,
        holder: {
          agentId: existing.agentId,
          intent: existing.intent,
          claimedAt: existing.claimedAt,
          ttl: existing.ttl,
        },
        conflictId: conflict.conflictId,
      }
    }

    const ttl = req.ttl ?? this.defaultTtl
    const claim: Claim = {
      resourceId: req.resourceId,
      agentId: req.agentId,
      intent: req.intent,
      ttl,
      claimedAt: now,
      expiresAt: now + ttl * 1000,
      lastHeartbeat: now,
      claimType: req.claimType ?? 'write',
    }
    this.claims.set(req.resourceId, claim)
    this.audit.append('claim_granted', req.agentId, {
      resourceId: req.resourceId,
      detail: { intent: req.intent, ttl, claimType: claim.claimType },
    })
    return { granted: true, claim }
  }

  release(resourceId: string, agentId: string): boolean {
    this.touch(agentId)
    const existing = this.claims.get(resourceId)
    if (!existing || existing.agentId !== agentId) return false
    this.claims.delete(resourceId)
    this.audit.resolveConflictsByResource(resourceId, 'holder_released')
    this.audit.append('claim_released', agentId, {
      resourceId,
      detail: { intent: existing.intent },
    })
    this.notifyWaiters(resourceId)
    return true
  }

  forceRelease(resourceId: string): boolean {
    const existing = this.claims.get(resourceId)
    if (!existing) return false
    this.claims.delete(resourceId)
    this.audit.resolveConflictsByResource(resourceId, 'force_released')
    this.audit.append('claim_released', existing.agentId, {
      resourceId,
      detail: { intent: existing.intent, forced: true },
    })
    this.notifyWaiters(resourceId)
    return true
  }

  // Register a callback fired exactly once when resourceId is released or expires.
  // Returns a cleanup function to cancel the registration (used by timeout paths).
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
    const cbs = this.waiters.get(resourceId)
    if (!cbs?.length) return
    this.waiters.delete(resourceId)
    for (const cb of cbs) cb()
  }

  heartbeat(resourceId: string, agentId: string): boolean {
    this.touch(agentId)
    const claim = this.claims.get(resourceId)
    if (!claim || claim.agentId !== agentId) return false
    const now = Date.now()
    claim.lastHeartbeat = now
    claim.expiresAt = now + claim.ttl * 1000
    return true
  }

  // Force-release all claims held by agentId (e.g. after detecting it is dead).
  // Returns the list of resource IDs that were released.
  forceReleaseAgent(agentId: string): string[] {
    const released: string[] = []
    for (const [resourceId, claim] of this.claims) {
      if (claim.agentId !== agentId) continue
      this.claims.delete(resourceId)
      this.audit.resolveConflictsByResource(resourceId, 'force_released')
      this.audit.append('claim_released', agentId, {
        resourceId,
        detail: { intent: claim.intent, forced: true, reason: 'agent_dead' },
      })
      this.notifyWaiters(resourceId)
      released.push(resourceId)
    }
    this.agentLastSeen.delete(agentId)
    return released
  }

  get(resourceId: string): Claim | undefined {
    const claim = this.claims.get(resourceId)
    if (!claim || claim.expiresAt <= Date.now()) return undefined
    return claim
  }

  list(): Claim[] {
    const now = Date.now()
    return Array.from(this.claims.values()).filter(c => c.expiresAt > now)
  }

  private cleanup(): void {
    const now = Date.now()

    // TTL expiry
    for (const [resourceId, claim] of this.claims) {
      if (claim.expiresAt <= now) {
        this.claims.delete(resourceId)
        this.audit.resolveConflictsByResource(resourceId, 'holder_expired')
        this.audit.append('claim_expired', claim.agentId, {
          resourceId,
          detail: { intent: claim.intent, ttl: claim.ttl },
        })
        this.notifyWaiters(resourceId)
      }
    }

    // Dead agent detection — force-release all claims for agents that have
    // stopped making any bus calls beyond the deadAgentTimeout window.
    const deadCutoff = now - this.deadAgentTimeout
    const deadAgents = new Set<string>()
    for (const [resourceId, claim] of this.claims) {
      const lastSeen = this.agentLastSeen.get(claim.agentId) ?? claim.claimedAt
      if (lastSeen < deadCutoff && !deadAgents.has(claim.agentId)) {
        deadAgents.add(claim.agentId)
      }
    }
    for (const agentId of deadAgents) {
      this.audit.append('claim_expired', agentId, {
        detail: { reason: 'agent_dead', deadAgentTimeout: this.deadAgentTimeout / 1000 },
      })
      this.forceReleaseAgent(agentId)
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer)
  }
}
