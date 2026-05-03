import { AuditLog } from './audit';
export interface Claim {
    resourceId: string;
    agentId: string;
    intent: string;
    ttl: number;
    claimedAt: number;
    expiresAt: number;
    lastHeartbeat: number;
    claimType: 'write' | 'read';
}
export interface ClaimRequest {
    resourceId: string;
    agentId: string;
    intent: string;
    ttl?: number;
    claimType?: 'write' | 'read';
}
export interface ClaimResult {
    granted: boolean;
    claim?: Claim;
    holder?: {
        agentId: string;
        intent: string;
        claimedAt: number;
        ttl: number;
    };
    conflictId?: string;
}
export declare class ClaimRegistry {
    private claims;
    private waiters;
    private audit;
    private defaultTtl;
    private cleanupTimer;
    constructor(audit: AuditLog, defaultTtl?: number);
    claim(req: ClaimRequest): ClaimResult;
    release(resourceId: string, agentId: string): boolean;
    forceRelease(resourceId: string): boolean;
    addWaiter(resourceId: string, cb: () => void): () => void;
    private notifyWaiters;
    heartbeat(resourceId: string, agentId: string): boolean;
    get(resourceId: string): Claim | undefined;
    list(): Claim[];
    private cleanup;
    stop(): void;
}
//# sourceMappingURL=registry.d.ts.map