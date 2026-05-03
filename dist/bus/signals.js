"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalBus = void 0;
const crypto_1 = require("crypto");
const HISTORY_CAP = 10000;
class SignalBus {
    constructor(audit) {
        this.queues = new Map();
        this.subscriptions = new Map();
        this.history = [];
        this.historyIndex = new Map();
        this.audit = audit;
    }
    subscribe(agentId, types) {
        if (!this.subscriptions.has(agentId)) {
            this.subscriptions.set(agentId, new Set());
        }
        for (const type of types) {
            this.subscriptions.get(agentId).add(type);
        }
        if (!this.queues.has(agentId)) {
            this.queues.set(agentId, []);
        }
    }
    publish(req) {
        const signal = {
            signalId: (0, crypto_1.randomUUID)(),
            type: req.type,
            from: req.from,
            message: req.message,
            affectedResources: req.affectedResources,
            severity: req.severity,
            changeContext: req.changeContext,
            ts: Date.now(),
        };
        this.audit.append('signal_published', req.from, {
            signalId: signal.signalId,
            detail: { type: req.type, message: req.message, severity: req.severity },
        });
        for (const [agentId, types] of this.subscriptions) {
            if (agentId === req.from)
                continue;
            if (types.has(req.type) || types.has('*')) {
                this.queues.get(agentId).push(signal);
                const entry = { ...signal, status: 'pending' };
                this.historyIndex.set(signal.signalId, entry);
                this.history.push(entry);
                if (this.history.length > HISTORY_CAP) {
                    const dropped = this.history.shift();
                    this.historyIndex.delete(dropped.signalId);
                }
            }
        }
        return signal;
    }
    getPending(agentId) {
        if (!this.queues.has(agentId))
            this.queues.set(agentId, []);
        const pending = this.queues.get(agentId).splice(0);
        const now = Date.now();
        for (const signal of pending) {
            const entry = this.historyIndex.get(signal.signalId);
            if (entry && entry.status === 'pending') {
                entry.status = 'delivered';
                entry.deliveredTo = agentId;
                entry.deliveredAt = now;
            }
            this.audit.append('signal_delivered', agentId, {
                signalId: signal.signalId,
                detail: { type: signal.type, from: signal.from },
            });
        }
        return pending;
    }
    peekPending(agentId) {
        return [...(this.queues.get(agentId) ?? [])];
    }
    getHistory(filter = {}) {
        let result = this.history.slice();
        if (filter.agentId)
            result = result.filter(h => h.deliveredTo === filter.agentId);
        if (filter.from)
            result = result.filter(h => h.from === filter.from);
        if (filter.type)
            result = result.filter(h => h.type === filter.type);
        return result.sort((a, b) => b.ts - a.ts);
    }
}
exports.SignalBus = SignalBus;
//# sourceMappingURL=signals.js.map