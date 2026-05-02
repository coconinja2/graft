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
    const existing = this.claims.get(resourceId)
    if (!existing || existing.agentId !== agentId) return false
    this.claims.delete(resourceId)
    this.audit.resolveConflictsByResource(resourceId, 'holder_released')
    this.audit.append('claim_released', agentId, {
      resourceId,
      detail: { intent: existing.intent },
    })
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
    return true
  }

  heartbeat(resourceId: string, agentId: string): boolean {
    const claim = this.claims.get(resourceId)
    if (!claim || claim.agentId !== agentId) return false
    const now = Date.now()
    claim.lastHeartbeat = now
    claim.expiresAt = now + claim.ttl * 1000
    return true
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
    for (const [resourceId, claim] of this.claims) {
      if (claim.expiresAt <= now) {
        this.claims.delete(resourceId)
        this.audit.resolveConflictsByResource(resourceId, 'holder_expired')
        this.audit.append('claim_expired', claim.agentId, {
          resourceId,
          detail: { intent: claim.intent, ttl: claim.ttl },
        })
      }
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer)
  }
}
