export type AuditEventType = 'claim_granted' | 'claim_denied' | 'claim_expired' | 'claim_released' | 'signal_published' | 'signal_delivered' | 'pool_acquired' | 'pool_released' | 'deadlock_detected' | 'deadlock_resolved' | 'starvation_detected' | 'healer_action';
export interface AuditEntry {
    seq: number;
    ts: number;
    type: AuditEventType;
    agentId: string;
    resourceId?: string;
    signalId?: string;
    conflictId?: string;
    deadlockId?: string;
    causedBySignalId?: string;
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
export interface AuditFilter {
    agentId?: string;
    resourceId?: string;
    type?: AuditEventType;
    since?: number;
    limit?: number;
}
export declare class AuditLog {
    private entries;
    private conflicts;
    private deadlocks;
    private seq;
    private maxEntries;
    private appendListeners;
    readonly enabled: boolean;
    constructor(maxEntries?: number, enabled?: boolean);
    append(type: AuditEventType, agentId: string, fields?: Partial<Omit<AuditEntry, 'seq' | 'ts' | 'type' | 'agentId'>>): void;
    /** Subscribe to all appended entries in real time. Returns an unsubscribe fn. */
    onAppend(listener: (entry: AuditEntry) => void): () => void;
    /** Return a snapshot of all entries (unfiltered, chronological order). */
    getAll(): AuditEntry[];
    query(filter?: AuditFilter): AuditEntry[];
    getTimeline(agentId: string, since?: number): AuditEntry[];
    recordConflict(entry: Omit<ConflictEntry, 'conflictId' | 'ts' | 'resolution'>): ConflictEntry;
    resolveConflict(conflictId: string, resolution: ConflictEntry['resolution']): void;
    resolveConflictsByResource(resourceId: string, resolution: ConflictEntry['resolution']): void;
    queryConflicts(filter?: {
        agentId?: string;
        resourceId?: string;
    }): ConflictEntry[];
    getConflict(conflictId: string): ConflictEntry | undefined;
    recordDeadlock(entry: Omit<DeadlockEntry, 'deadlockId' | 'ts' | 'resolution'>): DeadlockEntry;
    resolveDeadlock(deadlockId: string, resolution: DeadlockEntry['resolution']): void;
    queryDeadlocks(): DeadlockEntry[];
    getDeadlock(deadlockId: string): DeadlockEntry | undefined;
}
//# sourceMappingURL=audit.d.ts.map