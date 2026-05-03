"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLog = void 0;
const crypto_1 = require("crypto");
class AuditLog {
    constructor(maxEntries = 10000, enabled = true) {
        this.entries = [];
        this.conflicts = new Map();
        this.deadlocks = new Map();
        this.seq = 0;
        this.maxEntries = maxEntries;
        this.enabled = enabled;
    }
    append(type, agentId, fields = {}) {
        if (!this.enabled)
            return;
        const entry = {
            seq: ++this.seq,
            ts: Date.now(),
            type,
            agentId,
            detail: fields.detail ?? {},
            ...fields,
        };
        this.entries.push(entry);
        if (this.maxEntries > 0 && this.entries.length > this.maxEntries) {
            this.entries.shift();
        }
    }
    query(filter = {}) {
        let result = this.entries.slice();
        if (filter.agentId)
            result = result.filter(e => e.agentId === filter.agentId);
        if (filter.resourceId)
            result = result.filter(e => e.resourceId === filter.resourceId);
        if (filter.type)
            result = result.filter(e => e.type === filter.type);
        if (filter.since != null)
            result = result.filter(e => e.ts >= filter.since);
        result = result.reverse();
        return result.slice(0, filter.limit ?? 200);
    }
    getTimeline(agentId, since) {
        let result = this.entries.filter(e => e.agentId === agentId);
        if (since != null)
            result = result.filter(e => e.ts >= since);
        return result;
    }
    // Conflict log
    recordConflict(entry) {
        const conflict = {
            ...entry,
            conflictId: (0, crypto_1.randomUUID)(),
            ts: Date.now(),
            resolution: 'pending',
        };
        this.conflicts.set(conflict.conflictId, conflict);
        return conflict;
    }
    resolveConflict(conflictId, resolution) {
        const c = this.conflicts.get(conflictId);
        if (c && c.resolution === 'pending') {
            c.resolution = resolution;
            c.resolvedAt = Date.now();
        }
    }
    resolveConflictsByResource(resourceId, resolution) {
        for (const c of this.conflicts.values()) {
            if (c.resourceId === resourceId && c.resolution === 'pending') {
                c.resolution = resolution;
                c.resolvedAt = Date.now();
            }
        }
    }
    queryConflicts(filter = {}) {
        let result = Array.from(this.conflicts.values());
        if (filter.agentId) {
            result = result.filter(c => c.requestingAgent.agentId === filter.agentId || c.holdingAgent.agentId === filter.agentId);
        }
        if (filter.resourceId)
            result = result.filter(c => c.resourceId === filter.resourceId);
        return result.sort((a, b) => b.ts - a.ts);
    }
    getConflict(conflictId) {
        return this.conflicts.get(conflictId);
    }
    // Deadlock log
    recordDeadlock(entry) {
        const deadlock = {
            ...entry,
            deadlockId: (0, crypto_1.randomUUID)(),
            ts: Date.now(),
            resolution: 'pending',
        };
        this.deadlocks.set(deadlock.deadlockId, deadlock);
        return deadlock;
    }
    resolveDeadlock(deadlockId, resolution) {
        const d = this.deadlocks.get(deadlockId);
        if (d) {
            d.resolution = resolution;
            d.resolvedAt = Date.now();
        }
    }
    queryDeadlocks() {
        return Array.from(this.deadlocks.values()).sort((a, b) => b.ts - a.ts);
    }
    getDeadlock(deadlockId) {
        return this.deadlocks.get(deadlockId);
    }
}
exports.AuditLog = AuditLog;
//# sourceMappingURL=audit.js.map