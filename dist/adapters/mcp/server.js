"use strict";
/**
 * MCP server exposing Graft coordination tools.
 * Run with: graft mcp --port 7434
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpServer = createMcpServer;
exports.startMcpServer = startMcpServer;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const nodeHttp = __importStar(require("http"));
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const client_1 = require("../../sdk/client");
const TOOLS = [
    {
        name: 'graft_claim',
        description: 'Claim exclusive write access to a resource before modifying it.',
        inputSchema: {
            type: 'object',
            properties: {
                resource_id: { type: 'string', description: 'Resource identifier (file path, port, schema name)' },
                intent: { type: 'string', description: 'What you plan to do with this resource' },
                ttl: { type: 'number', description: 'Seconds before claim auto-expires (default: 120)' },
            },
            required: ['resource_id', 'intent'],
        },
    },
    {
        name: 'graft_release',
        description: 'Release your claim on a resource.',
        inputSchema: {
            type: 'object',
            properties: {
                resource_id: { type: 'string', description: 'Resource identifier to release' },
            },
            required: ['resource_id'],
        },
    },
    {
        name: 'graft_publish_signal',
        description: 'Publish a signal to notify other agents about a discovery.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Signal type (interface_change, security_finding, schema_change, resource_conflict, new_utility)' },
                message: { type: 'string', description: 'Description of what you discovered' },
                affected_resources: { type: 'array', items: { type: 'string' }, description: 'Affected resource IDs' },
                severity: { type: 'string', description: 'low | medium | high | critical' },
            },
            required: ['type', 'message'],
        },
    },
    {
        name: 'graft_get_signals',
        description: 'Get and consume pending signals from other agents.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'graft_acquire_pool',
        description: 'Acquire an exclusive resource from a named pool.',
        inputSchema: {
            type: 'object',
            properties: {
                pool_name: { type: 'string', description: 'Pool name (e.g. test_database, dev_port)' },
                timeout_ms: { type: 'number', description: 'Wait timeout in milliseconds' },
            },
            required: ['pool_name'],
        },
    },
    {
        name: 'graft_release_pool',
        description: 'Return a pool resource back to the pool.',
        inputSchema: {
            type: 'object',
            properties: {
                pool_name: { type: 'string', description: 'Pool name' },
                resource: { type: 'string', description: 'Resource value to release' },
            },
            required: ['pool_name', 'resource'],
        },
    },
];
async function createMcpServer(options = {}) {
    const { busUrl = 'http://localhost:7433', agentId = `mcp-agent-${Date.now()}` } = options;
    const server = new index_js_1.Server({ name: 'graft', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;
        const client = new client_1.GraftClient({ busUrl, agentId });
        try {
            let result;
            switch (name) {
                case 'graft_claim': {
                    result = await client.claim({
                        resourceId: args.resource_id,
                        intent: args.intent,
                        ttl: args.ttl,
                    });
                    break;
                }
                case 'graft_release': {
                    result = { released: await client.release(args.resource_id) };
                    break;
                }
                case 'graft_publish_signal': {
                    result = await client.publish({
                        type: args.type,
                        message: args.message,
                        affectedResources: args.affected_resources,
                        severity: args.severity,
                    });
                    break;
                }
                case 'graft_get_signals': {
                    result = await client.getPendingSignals();
                    break;
                }
                case 'graft_acquire_pool': {
                    const resource = await client.acquirePool(args.pool_name, args.timeout_ms);
                    result = { resource };
                    break;
                }
                case 'graft_release_pool': {
                    result = { released: await client.releasePool(args.pool_name, args.resource) };
                    break;
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err.message}` }],
                isError: true,
            };
        }
    });
    return server;
}
async function startMcpServer(options = {}) {
    const server = await createMcpServer(options);
    const transport = options.transport ?? 'stdio';
    if (transport === 'stdio') {
        const t = new stdio_js_1.StdioServerTransport();
        await server.connect(t);
        console.error(`Graft MCP server running on stdio (bus: ${options.busUrl ?? 'http://localhost:7433'})`);
    }
    else {
        const port = options.httpPort ?? 7434;
        const t = new streamableHttp_js_1.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(t);
        const httpServer = nodeHttp.createServer(async (req, res) => {
            if (req.url === '/mcp') {
                await t.handleRequest(req, res);
            }
            else {
                res.writeHead(404).end();
            }
        });
        httpServer.listen(port, () => {
            console.log(`Graft MCP server listening on http://localhost:${port}/mcp`);
        });
    }
}
//# sourceMappingURL=server.js.map