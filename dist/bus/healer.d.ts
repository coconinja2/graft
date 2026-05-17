import { AuditLog } from './audit';
import { ClaimRegistry } from './registry';
export interface HealerConfig {
    enabled: boolean;
    intervalMs: number;
    starvationThresholdMs: number;
    autoHeal: boolean;
}
export declare class SelfHealer {
    private audit;
    private registry;
    private config;
    private timer;
    private healCount;
    constructor(audit: AuditLog, registry: ClaimRegistry, config: HealerConfig);
    start(): void;
    stop(): void;
    getHealCount(): number;
    private heal;
    private checkStarvation;
}
//# sourceMappingURL=healer.d.ts.map