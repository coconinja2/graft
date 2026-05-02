/**
 * OpenAI Agents SDK tool definitions for Graft.
 * Add these to your agent's tools list to give it native Graft coordination.
 */

import { GraftClient } from '../../sdk/client'

export interface GraftToolsOptions {
  busUrl?: string
  agentId: string
}

// Tool return type compatible with OpenAI Agents SDK
type ToolFn = (args: Record<string, unknown>) => Promise<string>

interface AgentTool {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
  execute: ToolFn
}

export function graftTools(options: GraftToolsOptions): AgentTool[] {
  const client = new GraftClient(options)

  return [
    {
      name: 'graft_claim',
      description: 'Claim exclusive write access to a resource (file path, port, DB name) before modifying it. Returns whether the claim was granted and, if not, who holds it.',
      parameters: {
        type: 'object',
        properties: {
          resource_id: { type: 'string', description: 'Resource identifier (file path, port number, schema name, etc.)' },
          intent: { type: 'string', description: 'Human-readable description of what you plan to do with this resource' },
          ttl: { type: 'number', description: 'Seconds before the claim auto-expires (default: 120)' },
        },
        required: ['resource_id', 'intent'],
      },
      execute: async (args) => {
        const result = await client.claim({
          resourceId: args.resource_id as string,
          intent: args.intent as string,
          ttl: args.ttl as number | undefined,
        })
        if (result.granted) return JSON.stringify({ granted: true })
        return JSON.stringify({
          granted: false,
          holder: result.holder,
          conflictId: result.conflictId,
        })
      },
    },

    {
      name: 'graft_release',
      description: 'Release your claim on a resource after you have finished modifying it.',
      parameters: {
        type: 'object',
        properties: {
          resource_id: { type: 'string', description: 'Resource identifier to release' },
        },
        required: ['resource_id'],
      },
      execute: async (args) => {
        const released = await client.release(args.resource_id as string)
        return JSON.stringify({ released })
      },
    },

    {
      name: 'graft_publish_signal',
      description: 'Publish a signal to notify other agents about something important you discovered (e.g. an interface change, security finding, or new shared utility).',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Signal type',
            enum: ['interface_change', 'security_finding', 'schema_change', 'resource_conflict', 'new_utility'],
          },
          message: { type: 'string', description: 'Human-readable description of what you discovered' },
          affected_resources: { type: 'string', description: 'Comma-separated list of affected resource IDs' },
          severity: { type: 'string', description: 'Signal severity', enum: ['low', 'medium', 'high', 'critical'] },
        },
        required: ['type', 'message'],
      },
      execute: async (args) => {
        const signal = await client.publish({
          type: args.type as string,
          message: args.message as string,
          affectedResources: args.affected_resources
            ? (args.affected_resources as string).split(',').map(s => s.trim())
            : undefined,
          severity: args.severity as 'low' | 'medium' | 'high' | 'critical' | undefined,
        })
        return JSON.stringify({ signalId: signal.signalId, published: true })
      },
    },

    {
      name: 'graft_get_signals',
      description: 'Retrieve and consume any signals that other agents have published for you. Call this at each major decision point to stay informed.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const signals = await client.getPendingSignals()
        return JSON.stringify({ signals, count: signals.length })
      },
    },

    {
      name: 'graft_acquire_pool',
      description: 'Acquire an exclusive resource from a named pool (e.g. a test database or dev port). The resource is yours until you release it.',
      parameters: {
        type: 'object',
        properties: {
          pool_name: { type: 'string', description: 'Name of the pool (e.g. "test_database", "dev_port")' },
          timeout_ms: { type: 'number', description: 'Milliseconds to wait if pool is exhausted (default: 30000)' },
        },
        required: ['pool_name'],
      },
      execute: async (args) => {
        const resource = await client.acquirePool(args.pool_name as string, args.timeout_ms as number | undefined)
        return JSON.stringify({ resource })
      },
    },

    {
      name: 'graft_release_pool',
      description: 'Return a pool resource back to the pool so other agents can use it.',
      parameters: {
        type: 'object',
        properties: {
          pool_name: { type: 'string', description: 'Name of the pool' },
          resource: { type: 'string', description: 'The resource value to release (as returned by graft_acquire_pool)' },
        },
        required: ['pool_name', 'resource'],
      },
      execute: async (args) => {
        const released = await client.releasePool(args.pool_name as string, args.resource as string)
        return JSON.stringify({ released })
      },
    },

    {
      name: 'graft_wave_complete',
      description: 'Signal that you have completed your work in the current wave. The bus will track when all agents in the wave are done.',
      parameters: {
        type: 'object',
        properties: {
          wave_name: { type: 'string', description: 'Name of the wave to mark complete' },
        },
        required: ['wave_name'],
      },
      execute: async (args) => {
        const result = await client.waveComplete(args.wave_name as string)
        return JSON.stringify(result)
      },
    },
  ]
}
