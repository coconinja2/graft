/**
 * OpenAI Agents SDK tool definitions for Graft.
 * Add these to your agent's tools list to give it native Graft coordination.
 */
export interface GraftToolsOptions {
    busUrl?: string;
    agentId: string;
}
type ToolFn = (args: Record<string, unknown>) => Promise<string>;
interface AgentTool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description: string;
            enum?: string[];
        }>;
        required: string[];
    };
    execute: ToolFn;
}
export declare function graftTools(options: GraftToolsOptions): AgentTool[];
export {};
//# sourceMappingURL=tools.d.ts.map