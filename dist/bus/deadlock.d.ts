import { AuditLog } from './audit';
import { ClaimRegistry } from './registry';
export declare class DeadlockDetector {
    private waitEdges;
    private audit;
    private registry;
    private detectTimer;
    constructor(audit: AuditLog, registry: ClaimRegistry);
    recordWait(agentId: string, resourceId: string, heldByAgentId: string): void;
    clearWait(agentId: string): void;
    detect(): void;
    private findCycle;
    private resolveDeadlock;
    stop(): void;
}
//# sourceMappingURL=deadlock.d.ts.map