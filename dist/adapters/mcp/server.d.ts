/**
 * MCP server exposing Graft coordination tools.
 * Run with: graft mcp --port 7434
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
export interface McpServerOptions {
    busUrl?: string;
    agentId?: string;
    transport?: 'stdio' | 'http';
    httpPort?: number;
}
export declare function createMcpServer(options?: McpServerOptions): Promise<Server<{
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
    } | undefined;
}, {
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
    } | undefined;
}, {
    [x: string]: unknown;
    _meta?: {
        [x: string]: unknown;
        progressToken?: string | number | undefined;
        "io.modelcontextprotocol/related-task"?: {
            taskId: string;
        } | undefined;
    } | undefined;
}>>;
export declare function startMcpServer(options?: McpServerOptions): Promise<void>;
//# sourceMappingURL=server.d.ts.map