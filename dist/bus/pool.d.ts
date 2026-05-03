import { AuditLog } from './audit';
export interface PoolConfig {
    resources: string[];
}
export interface PoolStatus {
    total: number;
    available: number;
    inUse: number;
    waiters: number;
}
export declare class ResourcePool {
    private pools;
    private audit;
    constructor(audit: AuditLog);
    register(poolName: string, config: PoolConfig): void;
    acquire(poolName: string, agentId: string, timeoutMs?: number): Promise<string>;
    release(poolName: string, agentId: string, resource: string): boolean;
    status(poolName: string): PoolStatus | undefined;
    listPools(): string[];
}
//# sourceMappingURL=pool.d.ts.map