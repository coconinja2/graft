import { AuditLog } from './audit'
import { ClaimRegistry } from './registry'

interface WaitEdge {
  agentId: string
  waitingFor: string
  heldBy: string
}

export class DeadlockDetector {
  private waitEdges: Map<string, WaitEdge> = new Map()
  private audit: AuditLog
  private registry: ClaimRegistry
  private detectTimer: NodeJS.Timeout

  constructor(audit: AuditLog, registry: ClaimRegistry) {
    this.audit = audit
    this.registry = registry
    this.detectTimer = setInterval(() => this.detect(), 10_000)
    this.detectTimer.unref()
  }

  recordWait(agentId: string, resourceId: string, heldByAgentId: string): void {
    this.waitEdges.set(agentId, { agentId, waitingFor: resourceId, heldBy: heldByAgentId })
  }

  clearWait(agentId: string): void {
    this.waitEdges.delete(agentId)
  }

  detect(): void {
    const visited = new Set<string>()
    for (const agentId of this.waitEdges.keys()) {
      if (!visited.has(agentId)) {
        const cycle = this.findCycle(agentId, [])
        if (cycle.length > 0) {
          for (const edge of cycle) visited.add(edge.agentId)
          this.resolveDeadlock(cycle)
        }
      }
    }
  }

  private findCycle(start: string, path: string[]): WaitEdge[] {
    const edge = this.waitEdges.get(start)
    if (!edge) return []

    const cycleStart = path.indexOf(start)
    if (cycleStart !== -1) {
      // Collect the edges forming the cycle
      return path.slice(cycleStart).map(a => this.waitEdges.get(a)!).filter(Boolean)
    }

    return this.findCycle(edge.heldBy, [...path, start])
  }

  private resolveDeadlock(cycle: WaitEdge[]): void {
    const deadlock = this.audit.recordDeadlock({
      cycle: cycle.map(e => ({
        agentId: e.agentId,
        waitingFor: e.waitingFor,
        heldBy: e.heldBy,
      })),
    })

    this.audit.append('deadlock_detected', cycle[0].agentId, {
      deadlockId: deadlock.deadlockId,
      detail: { cycleLength: cycle.length, agents: cycle.map(e => e.agentId) },
    })

    // Resolve by force-releasing the claim with the oldest claimedAt in the cycle
    const allClaims = this.registry.list()
    let oldest: { resourceId: string; agentId: string; claimedAt: number } | undefined

    for (const edge of cycle) {
      const claim = allClaims.find(c => c.resourceId === edge.waitingFor)
      if (claim && (!oldest || claim.claimedAt < oldest.claimedAt)) {
        oldest = { resourceId: claim.resourceId, agentId: claim.agentId, claimedAt: claim.claimedAt }
      }
    }

    if (oldest) {
      this.registry.forceRelease(oldest.resourceId)
      for (const edge of cycle) {
        if (edge.waitingFor === oldest.resourceId || edge.agentId === oldest.agentId) {
          this.clearWait(edge.agentId)
        }
      }
      this.audit.resolveDeadlock(deadlock.deadlockId, 'expired_oldest_claim')
      this.audit.append('deadlock_resolved', oldest.agentId, {
        deadlockId: deadlock.deadlockId,
        resourceId: oldest.resourceId,
        detail: { resolution: 'expired_oldest_claim' },
      })
    }
  }

  stop(): void {
    clearInterval(this.detectTimer)
  }
}
