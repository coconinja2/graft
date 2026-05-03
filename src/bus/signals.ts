import { randomUUID } from 'crypto'
import { AuditLog } from './audit'

// Required payload when broadcasting a change_summary signal.
// Every field except diff is mandatory — receiving agents need this to make
// an informed decision about whether the change affects their work.
export interface ChangeSummaryPayload {
  what: string          // what changed ("rewrote login to return JWT token instead of setting a cookie")
  why: string           // why it changed ("Safari ITP blocks third-party cookies in our auth flow")
  breakingChange: boolean
  affectedResources: string[]   // file paths or resource IDs touched
  diff?: string         // optional short diff excerpt
}

export interface Signal {
  signalId: string
  type: string
  from: string
  message: string
  affectedResources?: string[]
  severity?: 'low' | 'medium' | 'high' | 'critical'
  changeContext?: ChangeSummaryPayload
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
  changeContext?: ChangeSummaryPayload
}

const HISTORY_CAP = 10_000

export class SignalBus {
  private queues: Map<string, Signal[]> = new Map()
  private subscriptions: Map<string, Set<string>> = new Map()
  private history: SignalHistoryEntry[] = []
  private historyIndex: Map<string, SignalHistoryEntry> = new Map()
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
        const entry: SignalHistoryEntry = { ...signal, status: 'pending' }
        this.historyIndex.set(signal.signalId, entry)
        this.history.push(entry)
        if (this.history.length > HISTORY_CAP) {
          const dropped = this.history.shift()!
          this.historyIndex.delete(dropped.signalId)
        }
      }
    }

    return signal
  }

  getPending(agentId: string): Signal[] {
    if (!this.queues.has(agentId)) this.queues.set(agentId, [])
    const pending = this.queues.get(agentId)!.splice(0)
    const now = Date.now()

    for (const signal of pending) {
      const entry = this.historyIndex.get(signal.signalId)
      if (entry && entry.status === 'pending') {
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
