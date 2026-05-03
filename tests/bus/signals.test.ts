import { SignalBus, ChangeSummaryPayload } from '../../src/bus/signals'
import { AuditLog } from '../../src/bus/audit'

function makeBus() {
  const audit = new AuditLog()
  const bus = new SignalBus(audit)
  return { bus, audit }
}

const changeSummary: ChangeSummaryPayload = {
  what: 'login now returns JWT token instead of setting a cookie',
  why: 'Safari ITP blocks third-party cookies',
  breakingChange: true,
  affectedResources: ['src/auth/login.ts', 'src/auth/types.ts'],
}

describe('SignalBus', () => {
  test('subscribe registers agent for signal types', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-a', ['interface_change'])
    expect(bus.peekPending('agent-a')).toEqual([])
  })

  test('published signal is delivered to subscribed agents (not sender)', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-a', ['interface_change'])
    bus.subscribe('agent-b', ['interface_change'])
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'AuthConfig changed' })
    expect(bus.peekPending('agent-b').length).toBe(1)
    expect(bus.peekPending('agent-a').length).toBe(0)
  })

  test('unsubscribed agent does not receive signals', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-a', ['interface_change'])
    bus.subscribe('agent-b', ['schema_change'])
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'x' })
    expect(bus.peekPending('agent-b').length).toBe(0)
  })

  test('wildcard subscription receives all signal types', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['*'])
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'x' })
    bus.publish({ type: 'schema_change', from: 'agent-a', message: 'y' })
    expect(bus.peekPending('agent-b').length).toBe(2)
  })

  test('getPending consumes signals (queue is empty after)', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['interface_change'])
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'x' })
    expect(bus.getPending('agent-b').length).toBe(1)
    expect(bus.getPending('agent-b').length).toBe(0)
  })

  test('getPending marks signals as delivered in history', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['interface_change'])
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'x' })
    bus.getPending('agent-b')
    const history = bus.getHistory({ agentId: 'agent-b' })
    expect(history[0].status).toBe('delivered')
    expect(history[0].deliveredTo).toBe('agent-b')
  })

  test('publish writes signal_published audit entry', () => {
    const { bus, audit } = makeBus()
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'x' })
    expect(audit.query({ type: 'signal_published' }).length).toBe(1)
  })

  test('getPending writes signal_delivered audit entries', () => {
    const { bus, audit } = makeBus()
    bus.subscribe('agent-b', ['interface_change'])
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'x' })
    bus.getPending('agent-b')
    const entries = audit.query({ type: 'signal_delivered' })
    expect(entries.length).toBe(1)
    expect(entries[0].agentId).toBe('agent-b')
  })

  test('getHistory filters by from agent', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-c', ['*'])
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'from a' })
    bus.publish({ type: 'schema_change', from: 'agent-b', message: 'from b' })
    bus.getPending('agent-c')
    const fromA = bus.getHistory({ from: 'agent-a' })
    expect(fromA.length).toBe(1)
    expect(fromA[0].from).toBe('agent-a')
  })

  test('signal includes all published fields', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['security_finding'])
    const signal = bus.publish({
      type: 'security_finding',
      from: 'agent-a',
      message: 'SQL injection risk',
      affectedResources: ['src/db/query.ts'],
      severity: 'high',
    })
    expect(signal.type).toBe('security_finding')
    expect(signal.affectedResources).toEqual(['src/db/query.ts'])
    expect(signal.severity).toBe('high')
    expect(signal.signalId).toBeDefined()
    expect(signal.ts).toBeGreaterThan(0)
  })
})

describe('change_summary signals', () => {
  test('changeContext is preserved through publish and getPending', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['change_summary'])
    bus.publish({ type: 'change_summary', from: 'agent-a', message: changeSummary.what, changeContext: changeSummary })
    const [signal] = bus.getPending('agent-b')
    expect(signal.changeContext).toEqual(changeSummary)
  })

  test('changeContext is preserved in history after delivery', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['change_summary'])
    bus.publish({ type: 'change_summary', from: 'agent-a', message: changeSummary.what, changeContext: changeSummary })
    bus.getPending('agent-b')
    const [entry] = bus.getHistory({ agentId: 'agent-b' })
    expect(entry.changeContext?.breakingChange).toBe(true)
    expect(entry.changeContext?.affectedResources).toEqual(changeSummary.affectedResources)
  })

  test('multiple receivers each get the full changeContext', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['change_summary'])
    bus.subscribe('agent-c', ['change_summary'])
    bus.publish({ type: 'change_summary', from: 'agent-a', message: changeSummary.what, changeContext: changeSummary })
    expect(bus.getPending('agent-b')[0].changeContext?.what).toBe(changeSummary.what)
    expect(bus.getPending('agent-c')[0].changeContext?.what).toBe(changeSummary.what)
  })

  test('change_summary without diff is valid', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['change_summary'])
    const noDiff: ChangeSummaryPayload = { ...changeSummary, diff: undefined }
    bus.publish({ type: 'change_summary', from: 'agent-a', message: noDiff.what, changeContext: noDiff })
    const [signal] = bus.getPending('agent-b')
    expect(signal.changeContext?.diff).toBeUndefined()
  })
})

describe('history cap', () => {
  test('history does not exceed 10 000 entries', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['*'])
    for (let i = 0; i < 10_050; i++) {
      bus.publish({ type: 'interface_change', from: 'agent-a', message: `msg-${i}` })
    }
    // getPending so history entries are marked delivered (not affecting cap logic)
    bus.getPending('agent-b')
    const history = bus.getHistory()
    expect(history.length).toBeLessThanOrEqual(10_000)
  })

  test('oldest entries are dropped first when cap is hit', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['*'])
    for (let i = 0; i < 10_050; i++) {
      bus.publish({ type: 'interface_change', from: 'agent-a', message: `msg-${i}` })
    }
    const history = bus.getHistory()
    const messages = history.map(h => h.message)
    // The oldest messages (msg-0 through msg-49) should have been dropped
    expect(messages).not.toContain('msg-0')
    expect(messages).toContain('msg-10049')
  })
})

describe('history index lookup', () => {
  test('delivery marks correct entry even after many publishes', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-b', ['*'])
    for (let i = 0; i < 100; i++) {
      bus.publish({ type: 'interface_change', from: 'agent-a', message: `msg-${i}` })
    }
    bus.getPending('agent-b')
    const history = bus.getHistory({ agentId: 'agent-b' })
    expect(history.every(h => h.status === 'delivered')).toBe(true)
    expect(history.every(h => h.deliveredTo === 'agent-b')).toBe(true)
  })
})
