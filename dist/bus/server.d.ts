import { AuditLog } from './audit';
import { ClaimRegistry } from './registry';
import { SignalBus } from './signals';
import { ResourcePool } from './pool';
import { DeadlockDetector } from './deadlock';
interface GraftConfig {
    bus: {
        port: number;
        backend: string;
        audit_max_entries: number;
        audit_enabled: boolean;
    };
    agents: {
        heartbeat_interval: number;
        claim_ttl: number;
    };
    pools: Record<string, {
        resources: string[];
    }>;
    waves: Record<string, {
        agents: string[];
        merge_gate: 'all_complete' | 'majority' | 'any';
    }>;
}
export declare function createServer(configPath?: string): Promise<{
    app: import("fastify").FastifyInstance<import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, import("fastify").FastifyBaseLogger, import("fastify").FastifyTypeProviderDefault> & PromiseLike<import("fastify").FastifyInstance<import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, import("fastify").FastifyBaseLogger, import("fastify").FastifyTypeProviderDefault>>;
    registry: ClaimRegistry;
    signals: SignalBus;
    pool: ResourcePool;
    deadlock: DeadlockDetector;
    audit: AuditLog;
    config: GraftConfig;
}>;
export declare function startServer(port?: number, configPath?: string): Promise<void>;
export {};
//# sourceMappingURL=server.d.ts.map