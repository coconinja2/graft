import { AuditLog } from './audit';
export interface ChangeSummaryPayload {
    what: string;
    why: string;
    breakingChange: boolean;
    affectedResources: string[];
    diff?: string;
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
export interface PublishRequest {
    type: string;
    from: string;
    message: string;
    affectedResources?: string[];
    severity?: 'low' | 'medium' | 'high' | 'critical';
    changeContext?: ChangeSummaryPayload;
}
export declare class SignalBus {
    private queues;
    private subscriptions;
    private history;
    private historyIndex;
    private audit;
    constructor(audit: AuditLog);
    subscribe(agentId: string, types: string[]): void;
    publish(req: PublishRequest): Signal;
    getPending(agentId: string): Signal[];
    peekPending(agentId: string): Signal[];
    getHistory(filter?: {
        agentId?: string;
        from?: string;
        type?: string;
    }): SignalHistoryEntry[];
}
//# sourceMappingURL=signals.d.ts.map