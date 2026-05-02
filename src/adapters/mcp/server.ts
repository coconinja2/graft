/**
 * MCP server exposing Graft coordination tools.
 * Run with: graft mcp --port 7434
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as nodeHttp from 'http'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { GraftClient } from '../../sdk/client'

export interface McpServerOptions {
  busUrl?: string
  agentId?: string
  transport?: 'stdio' | 'http'
  httpPort?: number
}

const TOOLS = [
  {
    name: 'graft_claim',
    description: 'Claim exclusive write access to a resource before modifying it.',
    inputSchema: {
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
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
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'graft_acquire_pool',
    description: 'Acquire an exclusive resource from a named pool.',
    inputSchema: {
      type: 'object' as const,
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
      type: 'object' as const,
      properties: {
        pool_name: { type: 'string', description: 'Pool name' },
        resource: { type: 'string', description: 'Resource value to release' },
      },
      required: ['pool_name', 'resource'],
    },
  },
]

export async function createMcpServer(options: McpServerOptions = {}) {
  const { busUrl = 'http://localhost:7433', agentId = `mcp-agent-${Date.now()}` } = options

  const server = new Server(
    { name: 'graft', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    const client = new GraftClient({ busUrl, agentId })

    try {
      let result: unknown

      switch (name) {
        case 'graft_claim': {
          result = await client.claim({
            resourceId: args.resource_id as string,
            intent: args.intent as string,
            ttl: args.ttl as number | undefined,
          })
          break
        }
        case 'graft_release': {
          result = { released: await client.release(args.resource_id as string) }
          break
        }
        case 'graft_publish_signal': {
          result = await client.publish({
            type: args.type as string,
            message: args.message as string,
            affectedResources: args.affected_resources as string[] | undefined,
            severity: args.severity as 'low' | 'medium' | 'high' | 'critical' | undefined,
          })
          break
        }
        case 'graft_get_signals': {
          result = await client.getPendingSignals()
          break
        }
        case 'graft_acquire_pool': {
          const resource = await client.acquirePool(
            args.pool_name as string,
            args.timeout_ms as number | undefined
          )
          result = { resource }
          break
        }
        case 'graft_release_pool': {
          result = { released: await client.releasePool(args.pool_name as string, args.resource as string) }
          break
        }
        default:
          throw new Error(`Unknown tool: ${name}`)
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  })

  return server
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = await createMcpServer(options)
  const transport = options.transport ?? 'stdio'

  if (transport === 'stdio') {
    const t = new StdioServerTransport()
    await server.connect(t)
    console.error(`Graft MCP server running on stdio (bus: ${options.busUrl ?? 'http://localhost:7433'})`)
  } else {
    const port = options.httpPort ?? 7434
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(t)
    const httpServer = nodeHttp.createServer(async (req, res) => {
      if (req.url === '/mcp') {
        await t.handleRequest(req, res)
      } else {
        res.writeHead(404).end()
      }
    })
    httpServer.listen(port, () => {
      console.log(`Graft MCP server listening on http://localhost:${port}/mcp`)
    })
  }
}
