// TypeScript SDK — wraps all Graft bus HTTP endpoints with typed interfaces

export interface Claim {
  resourceId: string
  agentId: string
  intent: string
  ttl: number
  claimedAt: number
  expiresAt: number
  lastHeartbeat: number
  claimType: 'write' | 'read'
}

export interface ClaimResult {
  granted: boolean
  claim?: Claim
  holder?: { agentId: string; intent: string; claimedAt: number; ttl: number }
  conflictId?: string
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

export interface AuditEntry {
  seq: number
  ts: number
  type: string
  agentId: string
  resourceId?: string
  signalId?: string
  conflictId?: string
  deadlockId?: string
  detail: Record<string, unknown>
}

export interface ConflictEntry {
  conflictId: string
  resourceId: string
  requestingAgent: { agentId: string; intent: string }
  holdingAgent: { agentId: string; intent: string; claimedAt: number; ttl: number }
  ts: number
  resolution: 'holder_released' | 'holder_expired' | 'force_released' | 'pending'
  resolvedAt?: number
}

export interface DeadlockEntry {
  deadlockId: string
  ts: number
  cycle: Array<{ agentId: string; waitingFor: string; heldBy: string }>
  resolution: 'expired_oldest_claim' | 'force_released' | 'pending'
  resolvedAt?: number
}

export interface PoolStatus {
  total: number
  available: number
  inUse: number
  waiters: number
}

export interface WaveStatus {
  name: string
  agents: string[]
  completed: string[]
  pending: string[]
  done: boolean
}

export interface GraftClientOptions {
  busUrl?: string
  agentId: string
}

export interface ClaimOptions {
  resourceId: string
  intent: string
  ttl?: number
  claimType?: 'write' | 'read'
}

import type { ChangeSummaryPayload } from '../bus/signals'
export type { ChangeSummaryPayload }

export interface PublishOptions {
  type: string
  message: string
  affectedResources?: string[]
  severity?: 'low' | 'medium' | 'high' | 'critical'
  // Required when type === 'change_summary'. All fields enforced — no fallback.
  changeContext?: ChangeSummaryPayload
}

export interface AuditFilter {
  agentId?: string
  resourceId?: string
  type?: string
  since?: number
  limit?: number
}

export class GraftClient {
  readonly busUrl: string
  readonly agentId: string

  constructor(options: GraftClientOptions) {
    this.busUrl = (options.busUrl ?? 'http://localhost:7433').replace(/\/$/, '')
    this.agentId = options.agentId
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.busUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error((err as { error: string }).error ?? res.statusText)
    }
    return res.json() as Promise<T>
  }

  // ── Claims ──────────────────────────────────────────────────────────────

  async claim(options: ClaimOptions): Promise<ClaimResult> {
    return this.request('POST', '/claims', {
      resource_id: options.resourceId,
      agent_id: this.agentId,
      intent: options.intent,
      ttl: options.ttl,
      claim_type: options.claimType,
    })
  }

  async release(resourceId: string): Promise<boolean> {
    const res = await this.request<{ released: boolean }>(
      'DELETE',
      `/claims/${encodeURIComponent(resourceId)}?agent_id=${encodeURIComponent(this.agentId)}`
    )
    return res.released
  }

  // Blocks until resourceId is released or timeout_ms elapses (default 30s).
  // Returns immediately if resource is already free.
  async waitForRelease(resourceId: string, timeoutMs = 30_000): Promise<void> {
    await this.request(
      'GET',
      `/claims/${encodeURIComponent(resourceId)}/wait?timeout_ms=${timeoutMs}`
    )
  }

  async heartbeat(resourceId: string): Promise<boolean> {
    try {
      await this.request('POST', `/claims/${encodeURIComponent(resourceId)}/heartbeat`, {
        agent_id: this.agentId,
      })
      return true
    } catch {
      return false
    }
  }

  async listClaims(): Promise<Claim[]> {
    return this.request('GET', '/claims')
  }

  async getClaim(resourceId: string): Promise<Claim | null> {
    return this.request('GET', `/claims/${encodeURIComponent(resourceId)}`)
  }

  // ── Signals ─────────────────────────────────────────────────────────────

  async subscribe(types: string[]): Promise<void> {
    await this.request('POST', '/signals/subscribe', { agent_id: this.agentId, types })
  }

  async publish(options: PublishOptions): Promise<Signal> {
    return this.request('POST', '/signals', {
      type: options.type,
      from: this.agentId,
      message: options.message,
      affected_resources: options.affectedResources,
      severity: options.severity,
      change_context: options.changeContext,
    })
  }

  async getPendingSignals(): Promise<Signal[]> {
    return this.request('GET', `/signals/pending?agent_id=${encodeURIComponent(this.agentId)}`)
  }

  async peekPendingSignals(): Promise<Signal[]> {
    return this.request('GET', `/signals/pending?agent_id=${encodeURIComponent(this.agentId)}&peek=true`)
  }

  async getSignalHistory(filter?: { from?: string; type?: string }): Promise<SignalHistoryEntry[]> {
    const params = new URLSearchParams({ agent: this.agentId })
    if (filter?.from) params.set('from', filter.from)
    if (filter?.type) params.set('type', filter.type)
    return this.request('GET', `/signals/history?${params}`)
  }

  // ── Pool ─────────────────────────────────────────────────────────────────

  async acquirePool(poolName: string, timeoutMs?: number): Promise<string> {
    const res = await this.request<{ acquired: boolean; resource: string }>(
      'POST',
      `/pool/${encodeURIComponent(poolName)}/acquire`,
      { agent_id: this.agentId, timeout_ms: timeoutMs }
    )
    return res.resource
  }

  async releasePool(poolName: string, resource: string): Promise<boolean> {
    const res = await this.request<{ released: boolean }>(
      'DELETE',
      `/pool/${encodeURIComponent(poolName)}/release`,
      { agent_id: this.agentId, resource }
    )
    return res.released
  }

  async poolStatus(poolName: string): Promise<PoolStatus> {
    return this.request('GET', `/pool/${encodeURIComponent(poolName)}/status`)
  }

  // ── Wave ─────────────────────────────────────────────────────────────────

  async waveRegister(name: string, agents?: string[]): Promise<void> {
    await this.request('POST', '/wave/register', { name, agent_id: this.agentId, agents })
  }

  async waveComplete(name: string): Promise<{ done: boolean }> {
    return this.request('POST', '/wave/complete', { name, agent_id: this.agentId })
  }

  async waveStatus(name: string): Promise<WaveStatus> {
    return this.request('GET', `/wave/${encodeURIComponent(name)}`)
  }

  // ── Audit & Debugging ────────────────────────────────────────────────────

  async getAuditLog(filter?: AuditFilter): Promise<AuditEntry[]> {
    const params = new URLSearchParams()
    if (filter?.agentId) params.set('agent', filter.agentId)
    if (filter?.resourceId) params.set('resource', filter.resourceId)
    if (filter?.type) params.set('type', filter.type)
    if (filter?.since != null) params.set('since', String(filter.since))
    if (filter?.limit != null) params.set('limit', String(filter.limit))
    return this.request('GET', `/audit?${params}`)
  }

  async getConflicts(filter?: { agentId?: string; resourceId?: string }): Promise<ConflictEntry[]> {
    const params = new URLSearchParams()
    if (filter?.agentId) params.set('agent', filter.agentId)
    if (filter?.resourceId) params.set('resource', filter.resourceId)
    return this.request('GET', `/conflicts?${params}`)
  }

  async getConflict(conflictId: string): Promise<ConflictEntry> {
    return this.request('GET', `/conflicts/${encodeURIComponent(conflictId)}`)
  }

  async getDeadlocks(): Promise<DeadlockEntry[]> {
    return this.request('GET', '/deadlocks')
  }

  async getDeadlock(deadlockId: string): Promise<DeadlockEntry> {
    return this.request('GET', `/deadlocks/${encodeURIComponent(deadlockId)}`)
  }

  async getTimeline(agentId?: string, since?: number): Promise<AuditEntry[]> {
    const target = agentId ?? this.agentId
    const params = since != null ? `?since=${since}` : ''
    return this.request('GET', `/timeline/${encodeURIComponent(target)}${params}`)
  }

  async health(): Promise<{ status: string; uptime: number; claims: number; ts: number }> {
    return this.request('GET', '/health')
  }
}
