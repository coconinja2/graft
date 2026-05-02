import { ResourcePool } from '../../src/bus/pool'
import { AuditLog } from '../../src/bus/audit'

function makePool() {
  const audit = new AuditLog()
  const pool = new ResourcePool(audit)
  return { pool, audit }
}

describe('ResourcePool', () => {
  test('acquire returns a free resource', async () => {
    const { pool } = makePool()
    pool.register('db', { resources: ['postgres://localhost/test_1'] })
    const resource = await pool.acquire('db', 'agent-a')
    expect(resource).toBe('postgres://localhost/test_1')
  })

  test('acquire from unknown pool rejects', async () => {
    const { pool } = makePool()
    await expect(pool.acquire('nonexistent', 'agent-a')).rejects.toThrow("Pool 'nonexistent' not found")
  })

  test('release returns resource back to pool', async () => {
    const { pool } = makePool()
    pool.register('db', { resources: ['postgres://localhost/test_1'] })
    const resource = await pool.acquire('db', 'agent-a')
    pool.release('db', 'agent-a', resource)
    const again = await pool.acquire('db', 'agent-b')
    expect(again).toBe(resource)
  })

  test('release returns false for wrong owner', async () => {
    const { pool } = makePool()
    pool.register('db', { resources: ['postgres://localhost/test_1'] })
    await pool.acquire('db', 'agent-a')
    expect(pool.release('db', 'agent-b', 'postgres://localhost/test_1')).toBe(false)
  })

  test('pool status tracks acquired vs available', async () => {
    const { pool } = makePool()
    pool.register('ports', { resources: ['3001', '3002'] })
    expect(pool.status('ports')).toEqual({ total: 2, available: 2, inUse: 0, waiters: 0 })
    await pool.acquire('ports', 'agent-a')
    expect(pool.status('ports')).toEqual({ total: 2, available: 1, inUse: 1, waiters: 0 })
  })

  test('second acquire on exhausted pool waits and resolves when released', async () => {
    const { pool } = makePool()
    pool.register('db', { resources: ['db1'] })
    const r1 = await pool.acquire('db', 'agent-a')
    // Start second acquire — will queue
    const pendingAcquire = pool.acquire('db', 'agent-b', 5000)
    // Release from first agent — should unblock second
    pool.release('db', 'agent-a', r1)
    const r2 = await pendingAcquire
    expect(r2).toBe('db1')
  })

  test('acquire times out if pool stays exhausted', async () => {
    const { pool } = makePool()
    pool.register('db', { resources: ['db1'] })
    await pool.acquire('db', 'agent-a')
    await expect(pool.acquire('db', 'agent-b', 50)).rejects.toThrow('Timeout')
  })

  test('acquire writes pool_acquired audit entry', async () => {
    const { pool, audit } = makePool()
    pool.register('db', { resources: ['db1'] })
    await pool.acquire('db', 'agent-a')
    const entries = audit.query({ type: 'pool_acquired' })
    expect(entries.length).toBe(1)
    expect(entries[0].agentId).toBe('agent-a')
  })

  test('release writes pool_released audit entry', async () => {
    const { pool, audit } = makePool()
    pool.register('db', { resources: ['db1'] })
    await pool.acquire('db', 'agent-a')
    pool.release('db', 'agent-a', 'db1')
    const entries = audit.query({ type: 'pool_released' })
    expect(entries.length).toBe(1)
  })

  test('multiple pools are independent', async () => {
    const { pool } = makePool()
    pool.register('db', { resources: ['db1'] })
    pool.register('ports', { resources: ['3001'] })
    const db = await pool.acquire('db', 'agent-a')
    const port = await pool.acquire('ports', 'agent-a')
    expect(db).toBe('db1')
    expect(port).toBe('3001')
  })

  test('status returns undefined for unknown pool', () => {
    const { pool } = makePool()
    expect(pool.status('unknown')).toBeUndefined()
  })
})
