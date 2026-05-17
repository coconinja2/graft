import { AuditLog } from './audit';
export interface LineRange {
    start: number;
    end: number;
}
export interface Claim {
    claimId: string;
    resourceId: string;
    agentId: string;
    intent: string;
    ttl: number;
    claimedAt: number;
    expiresAt: number;
    lastHeartbeat: number;
    claimType: 'write' | 'read';
    lineRange?: LineRange;
}
export interface ClaimRequest {
    resourceId: string;
    agentId: string;
    intent: string;
    ttl?: number;
    claimType?: 'write' | 'read';
    lineRange?: LineRange;
}
export interface ClaimResult {
    granted: boolean;
    claim?: Claim;
    holder?: {
        agentId: string;
        intent: string;
        claimedAt: number;
        ttl: number;
        lineRange?: LineRange;
    };
    conflictId?: string;
}
export declare class ClaimRegistry {
    private claims;
    private claimsById;
    private waiters;
    private audit;
    private defaultTtl;
    private cleanupTimer;
    constructor(audit: AuditLog, defaultTtl?: number);
    claim(req: ClaimRequest): ClaimResult;
    release(resourceId: string, agentId: string, lineRange?: LineRange): boolean;
    releaseById(claimId: string, agentId: string): boolean;
    forceRelease(resourceId: string): boolean;
    addWaiter(resourceId: string, cb: () => void): () => void;
    private notifyWaiters;
    heartbeat(resourceId: string, agentId: string): boolean;
    heartbeatById(claimId: string, agentId: string): boolean;
    forceReleaseAgent(agentId: string): string[];
    /** Returns all non-expired claims on a resource. Empty array = resource is free. */
    get(resourceId: string): Claim[];
    getById(claimId: string): Claim | undefined;
    list(): Claim[];
    private cleanup;
    stop(): void;
}
//# sourceMappingURL=registry.d.ts.map