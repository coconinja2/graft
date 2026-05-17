"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelfHealer = void 0;
class SelfHealer {
    constructor(audit, registry, config) {
        this.audit = audit;
        this.registry = registry;
        this.config = config;
        this.timer = null;
        this.healCount = 0;
    }
    start() {
        if (!this.config.enabled)
            return;
        this.timer = setInterval(() => this.heal(), this.config.intervalMs);
        this.timer.unref();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    getHealCount() { return this.healCount; }
    heal() {
        this.checkStarvation();
    }
    checkStarvation() {
        const now = Date.now();
        // Deduplicate: only act once per conflict per healer tick
        const actedOn = new Set();
        for (const conflict of this.audit.queryConflicts()) {
            if (conflict.resolution !== 'pending')
                continue;
            if (actedOn.has(conflict.conflictId))
                continue;
            const age = now - conflict.ts;
            if (age < this.config.starvationThresholdMs)
                continue;
            actedOn.add(conflict.conflictId);
            this.audit.append('starvation_detected', conflict.requestingAgent.agentId, {
                resourceId: conflict.resourceId,
                conflictId: conflict.conflictId,
                detail: {
                    holdingAgent: conflict.holdingAgent.agentId,
                    ageMs: age,
                    thresholdMs: this.config.starvationThresholdMs,
                    autoHeal: this.config.autoHeal,
                },
            });
            if (!this.config.autoHeal)
                continue;
            const released = this.registry.forceRelease(conflict.resourceId);
            if (released) {
                this.healCount++;
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
                });
            }
        }
    }
}
exports.SelfHealer = SelfHealer;
//# sourceMappingURL=healer.js.map