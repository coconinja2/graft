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
export interface Signal {
    signalId: string;
    type: string;
    from: string;
    message: string;
    affectedResources?: string[];
    severity?: 'low' | 'medium' | 'high' | 'critical';
    changeContext?: ChangeSummaryPayload;
    ts: number;
}
export interface SignalHistoryEntry extends Signal {
    deliveredTo?: string;
    deliveredAt?: number;
    status: 'pending' | 'delivered' | 'expired';
}
export interface AuditEntry {
    seq: number;
    ts: number;
    type: string;
    agentId: string;
    resourceId?: string;
    signalId?: string;
    conflictId?: string;
    deadlockId?: string;
    detail: Record<string, unknown>;
}
export interface ConflictEntry {
    conflictId: string;
    resourceId: string;
    requestingAgent: {
        agentId: string;
        intent: string;
    };
    holdingAgent: {
        agentId: string;
        intent: string;
        claimedAt: number;
        ttl: number;
    };
    ts: number;
    resolution: 'holder_released' | 'holder_expired' | 'force_released' | 'pending';
    resolvedAt?: number;
}
export interface DeadlockEntry {
    deadlockId: string;
    ts: number;
    cycle: Array<{
        agentId: string;
        waitingFor: string;
        heldBy: string;
    }>;
    resolution: 'expired_oldest_claim' | 'force_released' | 'pending';
    resolvedAt?: number;
}
export interface PoolStatus {
    total: number;
    available: number;
    inUse: number;
    waiters: number;
}
export interface WaveStatus {
    name: string;
    agents: string[];
    completed: string[];
    pending: string[];
    done: boolean;
}
export interface GraftClientOptions {
    busUrl?: string;
    agentId: string;
}
export interface ClaimOptions {
    resourceId: string;
    intent: string;
    ttl?: number;
    claimType?: 'write' | 'read';
    wait?: boolean;
}
import type { ChangeSummaryPayload } from '../bus/signals';
export type { ChangeSummaryPayload };
export interface PublishOptions {
    type: string;
    message: string;
    affectedResources?: string[];
    severity?: 'low' | 'medium' | 'high' | 'critical';
    changeContext?: ChangeSummaryPayload;
}
export interface AuditFilter {
    agentId?: string;
    resourceId?: string;
    type?: string;
    since?: number;
    limit?: number;
}
export declare class GraftClient {
    readonly busUrl: string;
    readonly agentId: string;
    constructor(options: GraftClientOptions);
    private request;
    claim(options: ClaimOptions): Promise<ClaimResult>;
    release(resourceId: string): Promise<boolean>;
    waitForRelease(resourceId: string, timeoutMs?: number): Promise<void>;
    heartbeat(resourceId: string): Promise<boolean>;
    forceReleaseAgent(agentId: string): Promise<{
        agentId: string;
        released: string[];
        count: number;
    }>;
    listClaims(): Promise<Claim[]>;
    getClaim(resourceId: string): Promise<Claim | null>;
    subscribe(types: string[]): Promise<void>;
    publish(options: PublishOptions): Promise<Signal>;
    getPendingSignals(): Promise<Signal[]>;
    peekPendingSignals(): Promise<Signal[]>;
    getSignalHistory(filter?: {
        from?: string;
        type?: string;
    }): Promise<SignalHistoryEntry[]>;
    acquirePool(poolName: string, timeoutMs?: number): Promise<string>;
    releasePool(poolName: string, resource: string): Promise<boolean>;
    poolStatus(poolName: string): Promise<PoolStatus>;
    waveRegister(name: string, agents?: string[]): Promise<void>;
    waveComplete(name: string): Promise<{
        done: boolean;
    }>;
    waveStatus(name: string): Promise<WaveStatus>;
    getAuditLog(filter?: AuditFilter): Promise<AuditEntry[]>;
    getConflicts(filter?: {
        agentId?: string;
        resourceId?: string;
    }): Promise<ConflictEntry[]>;
    getConflict(conflictId: string): Promise<ConflictEntry>;
    getDeadlocks(): Promise<DeadlockEntry[]>;
    getDeadlock(deadlockId: string): Promise<DeadlockEntry>;
    getTimeline(agentId?: string, since?: number): Promise<AuditEntry[]>;
    health(): Promise<{
        status: string;
        uptime: number;
        claims: number;
        ts: number;
    }>;
}
//# sourceMappingURL=client.d.ts.map