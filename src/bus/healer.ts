import { AuditLog } from './audit'
import { ClaimRegistry } from './registry'

export interface HealerConfig {
  enabled: boolean
  intervalMs: number
  starvationThresholdMs: number
  autoHeal: boolean
}

export class SelfHealer {
  private timer: NodeJS.Timeout | null = null
  private healCount = 0

  constructor(
    private audit: AuditLog,
    private registry: ClaimRegistry,
    private config: HealerConfig,
  ) {}

  start(): void {
    if (!this.config.enabled) return
    this.timer = setInterval(() => this.heal(), this.config.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  getHealCount(): number { return this.healCount }

  private heal(): void {
    this.checkStarvation()
  }

  private checkStarvation(): void {
    const now = Date.now()
    // Deduplicate: only act once per conflict per healer tick
    const actedOn = new Set<string>()

    for (const conflict of this.audit.queryConflicts()) {
      if (conflict.resolution !== 'pending') continue
      if (actedOn.has(conflict.conflictId)) continue
      const age = now - conflict.ts
      if (age < this.config.starvationThresholdMs) continue

      actedOn.add(conflict.conflictId)

      this.audit.append('starvation_detected', conflict.requestingAgent.agentId, {
        resourceId: conflict.resourceId,
        conflictId: conflict.conflictId,
        detail: {
          holdingAgent: conflict.holdingAgent.agentId,
          ageMs: age,
          thresholdMs: this.config.starvationThresholdMs,
          autoHeal: this.config.autoHeal,
        },
      })

      if (!this.config.autoHeal) continue

      const released = this.registry.forceRelease(conflict.resourceId)
      if (released) {
        this.healCount++
        this.audit.append('healer_action', 'graft-healer', {
          resourceId: conflict.resourceId,
          conflictId: conflict.conflictId,
          detail: {
            action: 'force_release',
            reason: 'starvation',
            holdingAgent: conflict.holdingAgent.agentId,
            requestingAgent: conflict.requestingAgent.agentId,
            ageMs: age,
            healCount: this.healCount,
          },
        })
      }
    }
  }
}
