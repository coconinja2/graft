"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResourcePool = void 0;
class ResourcePool {
    constructor(audit) {
        this.pools = new Map();
        this.audit = audit;
    }
    register(poolName, config) {
        this.pools.set(poolName, {
            resources: config.resources.map(v => ({ value: String(v) })),
            waiters: [],
        });
    }
    acquire(poolName, agentId, timeoutMs = 30000) {
        const pool = this.pools.get(poolName);
        if (!pool)
            return Promise.reject(new Error(`Pool '${poolName}' not found`));
        const free = pool.resources.find(r => !r.acquiredBy);
        if (free) {
            free.acquiredBy = agentId;
            free.acquiredAt = Date.now();
            this.audit.append('pool_acquired', agentId, {
                detail: { pool: poolName, resource: free.value },
            });
            return Promise.resolve(free.value);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = pool.waiters.findIndex(w => w.agentId === agentId);
                if (idx !== -1)
                    pool.waiters.splice(idx, 1);
                reject(new Error(`Timeout waiting for pool '${poolName}'`));
            }, timeoutMs);
            pool.waiters.push({ agentId, resolve, reject, timer });
        });
    }
    release(poolName, agentId, resource) {
        const pool = this.pools.get(poolName);
        if (!pool)
            return false;
        const r = pool.resources.find(pr => pr.value === resource && pr.acquiredBy === agentId);
        if (!r)
            return false;
        r.acquiredBy = undefined;
        r.acquiredAt = undefined;
        this.audit.append('pool_released', agentId, {
            detail: { pool: poolName, resource },
        });
        if (pool.waiters.length > 0) {
            const waiter = pool.waiters.shift();
            clearTimeout(waiter.timer);
            r.acquiredBy = waiter.agentId;
            r.acquiredAt = Date.now();
            this.audit.append('pool_acquired', waiter.agentId, {
                detail: { pool: poolName, resource, fromQueue: true },
            });
            waiter.resolve(resource);
        }
        return true;
    }
    status(poolName) {
        const pool = this.pools.get(poolName);
        if (!pool)
            return undefined;
        const inUse = pool.resources.filter(r => r.acquiredBy).length;
        return {
            total: pool.resources.length,
            available: pool.resources.length - inUse,
            inUse,
            waiters: pool.waiters.length,
        };
    }
    listPools() {
        return Array.from(this.pools.keys());
    }
}
exports.ResourcePool = ResourcePool;
//# sourceMappingURL=pool.js.map