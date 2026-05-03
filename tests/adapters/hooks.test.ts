import { handlePreToolUse, handlePostToolUse } from '../../src/adapters/claude-code/hooks'
import { ChangeSummaryPayload } from '../../src/bus/signals'

// Mock GraftClient so tests don't need a live bus
jest.mock('../../src/sdk/client', () => {
  return {
    GraftClient: jest.fn().mockImplementation(() => ({
      busUrl: 'http://localhost:7433',
      claim: jest.fn().mockResolvedValue({ granted: true }),
      release: jest.fn().mockResolvedValue(true),
      heartbeat: jest.fn().mockResolvedValue(true),
      publish: jest.fn().mockResolvedValue({ signalId: 'sig-1' }),
      getPendingSignals: jest.fn().mockResolvedValue([]),
      subscribe: jest.fn().mockResolvedValue(undefined),
    })),
  }
})

// Suppress ensureBusRunning — tests don't need a real server
jest.mock('child_process', () => ({ spawn: jest.fn(() => ({ unref: jest.fn() })) }))

const { GraftClient } = require('../../src/sdk/client')

function getClientInstance() {
  return GraftClient.mock.results[GraftClient.mock.results.length - 1].value
}

const validSummary: ChangeSummaryPayload = {
  what: 'login now returns JWT token instead of setting cookie',
  why: 'Safari ITP blocks third-party cookies',
  breakingChange: true,
  affectedResources: ['src/auth/login.ts'],
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('handlePostToolUse', () => {
  test('returns broadcasted:true when changeSummary provided for a write tool', async () => {
    const result = await handlePostToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
      changeSummary: validSummary,
    })
    expect(result.broadcasted).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('publishes change_summary signal with full changeContext', async () => {
    await handlePostToolUse({
      toolName: 'Edit',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
      changeSummary: validSummary,
    })
    const client = getClientInstance()
    expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'change_summary',
      changeContext: validSummary,
      message: validSummary.what,
    }))
  })

  test('severity is high when breakingChange is true', async () => {
    await handlePostToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
      changeSummary: validSummary,
    })
    const client = getClientInstance()
    expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({ severity: 'high' }))
  })

  test('severity is low when breakingChange is false', async () => {
    await handlePostToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
      changeSummary: { ...validSummary, breakingChange: false },
    })
    const client = getClientInstance()
    expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({ severity: 'low' }))
  })

  test('returns warning and skips broadcast when changeSummary is missing', async () => {
    const result = await handlePostToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
    })
    expect(result.broadcasted).toBe(false)
    expect(result.warning).toMatch(/change_summary not broadcast/)
    const client = getClientInstance()
    expect(client.publish).not.toHaveBeenCalled()
  })

  test('still heartbeats even when changeSummary is missing', async () => {
    await handlePostToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
    })
    const client = getClientInstance()
    expect(client.heartbeat).toHaveBeenCalledWith('src/auth/login.ts')
  })

  test('releases claim for read tools', async () => {
    const result = await handlePostToolUse({
      toolName: 'Read',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
    })
    const client = getClientInstance()
    expect(client.release).toHaveBeenCalledWith('src/auth/login.ts')
    expect(result.broadcasted).toBe(false)
  })

  test('returns broadcasted:false when no resource can be extracted', async () => {
    const result = await handlePostToolUse({
      toolName: 'Bash',
      toolInput: { command: 'echo hello' },
      agentId: 'agent-a',
    })
    expect(result.broadcasted).toBe(false)
  })
})

describe('handlePreToolUse', () => {
  test('proceeds when claim is granted', async () => {
    const result = await handlePreToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
    })
    expect(result.proceed).toBe(true)
  })

  test('blocks when claim is denied and includes holder context', async () => {
    GraftClient.mockImplementationOnce(() => ({
      busUrl: 'http://localhost:7433',
      claim: jest.fn().mockResolvedValue({
        granted: false,
        holder: { agentId: 'agent-b', intent: 'adding rate limiting' },
        conflictId: 'conflict-1',
      }),
      getPendingSignals: jest.fn().mockResolvedValue([]),
    }))

    const result = await handlePreToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
    })
    expect(result.proceed).toBe(false)
    expect(result.message).toContain('agent-b')
    expect(result.message).toContain('adding rate limiting')
  })

  test('delivers pending signals with changeContext in message', async () => {
    GraftClient.mockImplementationOnce(() => ({
      busUrl: 'http://localhost:7433',
      claim: jest.fn().mockResolvedValue({ granted: true }),
      getPendingSignals: jest.fn().mockResolvedValue([{
        signalId: 'sig-1',
        type: 'change_summary',
        from: 'agent-b',
        message: validSummary.what,
        affectedResources: validSummary.affectedResources,
        changeContext: validSummary,
        ts: Date.now(),
      }]),
    }))

    const result = await handlePreToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/session/handler.ts' },
      agentId: 'agent-a',
    })
    expect(result.message).toContain(validSummary.what)
    expect(result.message).toContain(validSummary.why)
    expect(result.message).toContain('breaking: yes')
    expect(result.message).toContain('decide how to proceed')
  })

  test('proceeds without message when no pending signals and claim granted', async () => {
    const result = await handlePreToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/unrelated/file.ts' },
      agentId: 'agent-a',
    })
    expect(result.proceed).toBe(true)
    expect(result.message).toBeUndefined()
  })

  test('fails open when bus is unreachable', async () => {
    GraftClient.mockImplementationOnce(() => ({
      busUrl: 'http://localhost:7433',
      claim: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      getPendingSignals: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    }))

    const result = await handlePreToolUse({
      toolName: 'Write',
      toolInput: { file_path: 'src/auth/login.ts' },
      agentId: 'agent-a',
    })
    expect(result.proceed).toBe(true)
  })
})
