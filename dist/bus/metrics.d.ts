import type { AuditLog } from './audit';
import type { ClaimRegistry } from './registry';
import type { SignalBus } from './signals';
import type { ResourcePool } from './pool';
export interface ContentionEntry {
    resourceId: string;
    denials: number;
    topRequestingAgents: Array<{
        agentId: string;
        count: number;
    }>;
    topBlockingAgents: Array<{
        agentId: string;
        count: number;
    }>;
    lastDeniedAt: number;
}
export interface AgentRosterEntry {
    agentId: string;
    firstSeen: number;
    lastSeen: number;
    claimsGranted: number;
    claimsDenied: number;
    signalsPublished: number;
    signalsReceived: number;
    currentClaims: string[];
    pendingSignals: number;
    active: boolean;
}
export interface HistogramSummary {
    count: number;
    sum: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
    buckets: Array<{
        le: number | '+Inf';
        count: number;
    }>;
}
export interface MetricsSummary {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, HistogramSummary>;
}
export interface GraphNode {
    id: string;
    type: 'agent' | 'resource';
    label: string;
}
export interface GraphEdge {
    from: string;
    to: string;
    type: 'holds' | 'waiting_for';
    intent?: string;
    claimType?: string;
}
export interface DependencyGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    generatedAt: number;
}
export interface AgentEfficiency {
    agentId: string;
    claimsGranted: number;
    claimsDenied: number;
    blockRate: number;
    avgBlockedMs: number;
    efficiencyScore: number;
}
export declare class MetricsCollector {
    private audit;
    private registry;
    private signals;
    private pool;
    constructor(audit: AuditLog, registry: ClaimRegistry, signals: SignalBus, pool: ResourcePool);
    private entries;
    computeCounters(): Record<string, number>;
    computeGauges(): Record<string, number>;
    computeHistograms(): Record<string, HistogramSummary>;
    toJSON(): MetricsSummary;
    toPrometheus(): string;
    computeContention(limit?: number): ContentionEntry[];
    computeGraph(): DependencyGraph;
    computeEfficiency(): AgentEfficiency[];
    computeAgentRoster(): AgentRosterEntry[];
}
//# sourceMappingURL=metrics.d.ts.map