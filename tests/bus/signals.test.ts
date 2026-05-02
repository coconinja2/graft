import { SignalBus } from '../../src/bus/signals'
import { AuditLog } from '../../src/bus/audit'

function makeBus() {
  const audit = new AuditLog()
  const bus = new SignalBus(audit)
  return { bus, audit }
}

describe('SignalBus', () => {
  test('subscribe registers agent for signal types', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-a', ['interface_change'])
    const signals = bus.peekPending('agent-a')
    expect(signals).toEqual([])
  })

  test('published signal is delivered to subscribed agents (not sender)', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-a', ['interface_change'])
    bus.subscribe('agent-b', ['interface_change'])
    bus.publish({ type: 'interface_change', from: 'agent-a', message: 'AuthConfig changed' })
    // agent-b should receive, agent-a (sender) should not
    expect(bus.peekPending('agent-b').length).toBe(1)
    expect(bus.peekPending('agent-a').length).toBe(0)
  })

  test('unsubscribed agent does not receive signals', () => {
    const { bus } = makeBus()
    bus.subscribe('agent-a', ['interface_change'])
    bus.subscribe('agent-b', ['schema_change']) // different type
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
    const first = bus.getPending('agent-b')
    expect(first.length).toBe(1)
    const second = bus.getPending('agent-b')
    expect(second.length).toBe(0)
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
    const entries = audit.query({ type: 'signal_published' })
    expect(entries.length).toBe(1)
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
