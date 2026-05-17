"use strict";
// TypeScript SDK — wraps all Graft bus HTTP endpoints with typed interfaces
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraftClient = void 0;
class GraftClient {
    constructor(options) {
        this.busUrl = (options.busUrl ?? 'http://localhost:7433').replace(/\/$/, '');
        this.agentId = options.agentId;
    }
    async request(method, path, body) {
        const res = await fetch(`${this.busUrl}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error ?? res.statusText);
        }
        return res.json();
    }
    // ── Claims ──────────────────────────────────────────────────────────────
    async claim(options) {
        return this.request('POST', '/claims', {
            resource_id: options.resourceId,
            agent_id: this.agentId,
            intent: options.intent,
            ttl: options.ttl,
            claim_type: options.claimType,
            line_start: options.lineStart,
            line_end: options.lineEnd,
            wait: options.wait,
        });
    }
    async release(resourceId, lineStart, lineEnd) {
        const params = new URLSearchParams({ agent_id: this.agentId });
        if (lineStart != null && lineEnd != null) {
            params.set('line_start', String(lineStart));
            params.set('line_end', String(lineEnd));
        }
        const res = await this.request('DELETE', `/claims/${encodeURIComponent(resourceId)}?${params}`);
        return res.released;
    }
    async releaseById(claimId) {
        const res = await this.request('DELETE', `/claim/${encodeURIComponent(claimId)}?agent_id=${encodeURIComponent(this.agentId)}`);
        return res.released;
    }
    // Blocks until resourceId is released or timeout_ms elapses (default 30s).
    // Returns immediately if resource is already free.
    async waitForRelease(resourceId, timeoutMs = 30000) {
        await this.request('GET', `/claims/${encodeURIComponent(resourceId)}/wait?timeout_ms=${timeoutMs}`);
    }
    async heartbeat(resourceId) {
        try {
            await this.request('POST', `/claims/${encodeURIComponent(resourceId)}/heartbeat`, {
                agent_id: this.agentId,
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async forceReleaseAgent(agentId) {
        return this.request('DELETE', `/agents/${encodeURIComponent(agentId)}/claims`);
    }
    async listClaims() {
        return this.request('GET', '/claims');
    }
    /** Returns all active claims on a resource (multiple when non-overlapping line ranges coexist). */
    async getClaims(resourceId) {
        return this.request('GET', `/claims/${encodeURIComponent(resourceId)}`);
    }
    async getClaimById(claimId) {
        return this.request('GET', `/claim/${encodeURIComponent(claimId)}`);
    }
    // ── Signals ─────────────────────────────────────────────────────────────
    async subscribe(types) {
        await this.request('POST', '/signals/subscribe', { agent_id: this.agentId, types });
    }
    async publish(options) {
        return this.request('POST', '/signals', {
            type: options.type,
            from: this.agentId,
            message: options.message,
            affected_resources: options.affectedResources,
            severity: options.severity,
            change_context: options.changeContext,
        });
    }
    async getPendingSignals() {
        return this.request('GET', `/signals/pending?agent_id=${encodeURIComponent(this.agentId)}`);
    }
    async peekPendingSignals() {
        return this.request('GET', `/signals/pending?agent_id=${encodeURIComponent(this.agentId)}&peek=true`);
    }
    async getSignalHistory(filter) {
        const params = new URLSearchParams({ agent: this.agentId });
        if (filter?.from)
            params.set('from', filter.from);
        if (filter?.type)
            params.set('type', filter.type);
        return this.request('GET', `/signals/history?${params}`);
    }
    // ── Pool ─────────────────────────────────────────────────────────────────
    async acquirePool(poolName, timeoutMs) {
        const res = await this.request('POST', `/pool/${encodeURIComponent(poolName)}/acquire`, { agent_id: this.agentId, timeout_ms: timeoutMs });
        return res.resource;
    }
    async releasePool(poolName, resource) {
        const res = await this.request('DELETE', `/pool/${encodeURIComponent(poolName)}/release`, { agent_id: this.agentId, resource });
        return res.released;
    }
    async poolStatus(poolName) {
        return this.request('GET', `/pool/${encodeURIComponent(poolName)}/status`);
    }
    // ── Wave ─────────────────────────────────────────────────────────────────
    async waveRegister(name, agents) {
        await this.request('POST', '/wave/register', { name, agent_id: this.agentId, agents });
    }
    async waveComplete(name) {
        return this.request('POST', '/wave/complete', { name, agent_id: this.agentId });
    }
    async waveStatus(name) {
        return this.request('GET', `/wave/${encodeURIComponent(name)}`);
    }
    // ── Audit & Debugging ────────────────────────────────────────────────────
    async getAuditLog(filter) {
        const params = new URLSearchParams();
        if (filter?.agentId)
            params.set('agent', filter.agentId);
        if (filter?.resourceId)
            params.set('resource', filter.resourceId);
        if (filter?.type)
            params.set('type', filter.type);
        if (filter?.since != null)
            params.set('since', String(filter.since));
        if (filter?.limit != null)
            params.set('limit', String(filter.limit));
        return this.request('GET', `/audit?${params}`);
    }
    async getConflicts(filter) {
        const params = new URLSearchParams();
        if (filter?.agentId)
            params.set('agent', filter.agentId);
        if (filter?.resourceId)
            params.set('resource', filter.resourceId);
        return this.request('GET', `/conflicts?${params}`);
    }
    async getConflict(conflictId) {
        return this.request('GET', `/conflicts/${encodeURIComponent(conflictId)}`);
    }
    async getDeadlocks() {
        return this.request('GET', '/deadlocks');
    }
    async getDeadlock(deadlockId) {
        return this.request('GET', `/deadlocks/${encodeURIComponent(deadlockId)}`);
    }
    async getTimeline(agentId, since) {
        const target = agentId ?? this.agentId;
        const params = since != null ? `?since=${since}` : '';
        return this.request('GET', `/timeline/${encodeURIComponent(target)}${params}`);
    }
    async health() {
        return this.request('GET', '/health');
    }
}
exports.GraftClient = GraftClient;
//# sourceMappingURL=client.js.map