import { randomUUID } from 'crypto'
import { AuditLog } from './audit'

export interface Signal {
  signalId: string
  type: string
  from: string
  message: string
  affectedResources?: string[]
  severity?: 'low' | 'medium' | 'high' | 'critical'
  // Richer context for change_summary signals — receiving agent uses this to decide how to respond
  changeContext?: {
    what: string        // what was changed ("rewrote login to pass JWT token instead of cookie")
    why?: string        // why it was changed ("session cookies blocked by Safari ITP")
    breakingChange: boolean
    diff?: string       // optional short diff excerpt
  }
  ts: number
}

export interface SignalHistoryEntry extends Signal {
  deliveredTo?: string
  deliveredAt?: number
  status: 'pending' | 'delivered' | 'expired'
}

export interface PublishRequest {
  type: string
  from: string
  message: string
  affectedResources?: string[]
  severity?: 'low' | 'medium' | 'high' | 'critical'
  changeContext?: Signal['changeContext']
}

export class SignalBus {
  private queues: Map<string, Signal[]> = new Map()
  private subscriptions: Map<string, Set<string>> = new Map()
  private history: SignalHistoryEntry[] = []
  private audit: AuditLog

  constructor(audit: AuditLog) {
    this.audit = audit
  }

  subscribe(agentId: string, types: string[]): void {
    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, new Set())
    }
    for (const type of types) {
      this.subscriptions.get(agentId)!.add(type)
    }
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, [])
    }
  }

  publish(req: PublishRequest): Signal {
    const signal: Signal = {
      signalId: randomUUID(),
      type: req.type,
      from: req.from,
      message: req.message,
      affectedResources: req.affectedResources,
      severity: req.severity,
      changeContext: req.changeContext,
      ts: Date.now(),
    }

    this.audit.append('signal_published', req.from, {
      signalId: signal.signalId,
      detail: { type: req.type, message: req.message, severity: req.severity },
    })

    for (const [agentId, types] of this.subscriptions) {
      if (agentId === req.from) continue
      if (types.has(req.type) || types.has('*')) {
        this.queues.get(agentId)!.push(signal)
        this.history.push({ ...signal, status: 'pending' })
      }
    }

    return signal
  }

  getPending(agentId: string): Signal[] {
    if (!this.queues.has(agentId)) this.queues.set(agentId, [])
    const pending = this.queues.get(agentId)!.splice(0)
    const now = Date.now()

    for (const signal of pending) {
      // Mark first matching pending history entry as delivered
      const entry = [...this.history].reverse().find(
        (h: SignalHistoryEntry) => h.signalId === signal.signalId && h.status === 'pending'
      )
      if (entry) {
        entry.status = 'delivered'
        entry.deliveredTo = agentId
        entry.deliveredAt = now
      }
      this.audit.append('signal_delivered', agentId, {
        signalId: signal.signalId,
        detail: { type: signal.type, from: signal.from },
      })
    }

    return pending
  }

  peekPending(agentId: string): Signal[] {
    return [...(this.queues.get(agentId) ?? [])]
  }

  getHistory(filter: { agentId?: string; from?: string; type?: string } = {}): SignalHistoryEntry[] {
    let result = this.history.slice()
    if (filter.agentId) result = result.filter(h => h.deliveredTo === filter.agentId)
    if (filter.from) result = result.filter(h => h.from === filter.from)
    if (filter.type) result = result.filter(h => h.type === filter.type)
    return result.sort((a, b) => b.ts - a.ts)
  }
}
