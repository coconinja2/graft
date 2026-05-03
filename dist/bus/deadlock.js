"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeadlockDetector = void 0;
class DeadlockDetector {
    constructor(audit, registry) {
        this.waitEdges = new Map();
        this.audit = audit;
        this.registry = registry;
        this.detectTimer = setInterval(() => this.detect(), 10000);
        this.detectTimer.unref();
    }
    recordWait(agentId, resourceId, heldByAgentId) {
        this.waitEdges.set(agentId, { agentId, waitingFor: resourceId, heldBy: heldByAgentId });
    }
    clearWait(agentId) {
        this.waitEdges.delete(agentId);
    }
    detect() {
        const visited = new Set();
        for (const agentId of this.waitEdges.keys()) {
            if (!visited.has(agentId)) {
                const cycle = this.findCycle(agentId, []);
                if (cycle.length > 0) {
                    for (const edge of cycle)
                        visited.add(edge.agentId);
                    this.resolveDeadlock(cycle);
                }
            }
        }
    }
    findCycle(start, path) {
        const edge = this.waitEdges.get(start);
        if (!edge)
            return [];
        const cycleStart = path.indexOf(start);
        if (cycleStart !== -1) {
            // Collect the edges forming the cycle
            return path.slice(cycleStart).map(a => this.waitEdges.get(a)).filter(Boolean);
        }
        return this.findCycle(edge.heldBy, [...path, start]);
    }
    resolveDeadlock(cycle) {
        const deadlock = this.audit.recordDeadlock({
            cycle: cycle.map(e => ({
                agentId: e.agentId,
                waitingFor: e.waitingFor,
                heldBy: e.heldBy,
            })),
        });
        this.audit.append('deadlock_detected', cycle[0].agentId, {
            deadlockId: deadlock.deadlockId,
            detail: { cycleLength: cycle.length, agents: cycle.map(e => e.agentId) },
        });
        // Resolve by force-releasing the claim with the oldest claimedAt in the cycle
        const allClaims = this.registry.list();
        let oldest;
        for (const edge of cycle) {
            const claim = allClaims.find(c => c.resourceId === edge.waitingFor);
            if (claim && (!oldest || claim.claimedAt < oldest.claimedAt)) {
                oldest = { resourceId: claim.resourceId, agentId: claim.agentId, claimedAt: claim.claimedAt };
            }
        }
        if (oldest) {
            this.registry.forceRelease(oldest.resourceId);
            for (const edge of cycle) {
                if (edge.waitingFor === oldest.resourceId || edge.agentId === oldest.agentId) {
                    this.clearWait(edge.agentId);
                }
            }
            this.audit.resolveDeadlock(deadlock.deadlockId, 'expired_oldest_claim');
            this.audit.append('deadlock_resolved', oldest.agentId, {
                deadlockId: deadlock.deadlockId,
                resourceId: oldest.resourceId,
                detail: { resolution: 'expired_oldest_claim' },
            });
        }
    }
    stop() {
        clearInterval(this.detectTimer);
    }
}
exports.DeadlockDetector = DeadlockDetector;
//# sourceMappingURL=deadlock.js.map