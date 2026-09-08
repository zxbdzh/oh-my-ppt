import { describe, expect, it, beforeEach } from 'vitest'
import { ExternalAgentBroker } from '../../../src/main/external-agent/broker'
import {
  ExternalAgentAuthorizationService,
  InMemoryExternalAgentAuthorizationStore
} from '../../../src/main/external-agent/authorization'
import {
  ExternalAgentOperationService,
  InMemoryExternalAgentOperationStore
} from '../../../src/main/external-agent/operations'

describe('ExternalAgentBroker write and recovery flow', () => {
  let authService: ExternalAgentAuthorizationService
  let operations: ExternalAgentOperationService
  let broker: ExternalAgentBroker

  beforeEach(() => {
    const authStore = new InMemoryExternalAgentAuthorizationStore()
    authService = new ExternalAgentAuthorizationService(authStore)
    operations = new ExternalAgentOperationService(new InMemoryExternalAgentOperationStore())
    broker = new ExternalAgentBroker(
      authService,
      {
        async listAuthorizedSessions() {
          return []
        },
        async getSessionWithPages() {
          return null
        }
      },
      '2.3.0',
      operations
    )
  })

  it('enqueues generation, replays the same idempotency key, and rejects a reused key', async () => {
    await authService.grantInitial({
      agentId: 'pi',
      name: 'pi',
      version: '1.0.0',
      sessionIds: ['sess-1']
    })

    const first = await broker.handleRequest('pi', {
      type: 'start_generation',
      input: {
        idempotencyKey: 'gen-1',
        sessionId: 'sess-1',
        topic: '季度复盘'
      }
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.operationId).toBeTruthy()
    expect((first.data as { status: string }).status).toBe('queued')

    const replay = await broker.handleRequest('pi', {
      type: 'start_generation',
      input: {
        idempotencyKey: 'gen-1',
        sessionId: 'sess-1',
        topic: '季度复盘'
      }
    })
    expect(replay.ok).toBe(true)
    if (replay.ok) expect(replay.operationId).toBe(first.operationId)

    const reused = await broker.handleRequest('pi', {
      type: 'start_generation',
      input: {
        idempotencyKey: 'gen-1',
        sessionId: 'sess-1',
        topic: '另一份主题'
      }
    })
    expect(reused.ok).toBe(false)
    if (!reused.ok) expect(reused.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('replays events after a cursor and cancels the operation', async () => {
    await authService.grantInitial({
      agentId: 'pi',
      name: 'pi',
      version: '1.0.0',
      sessionIds: ['sess-1']
    })
    const created = await broker.handleRequest('pi', {
      type: 'edit_page',
      input: {
        idempotencyKey: 'edit-1',
        sessionId: 'sess-1',
        pageId: 'page-1',
        instruction: '改标题'
      }
    })
    expect(created.ok).toBe(true)
    if (!created.ok || !created.operationId) return

    await operations.dequeueNext('sess-1')
    const events = await broker.handleRequest('pi', {
      type: 'get_operation_events',
      input: { operationId: created.operationId, afterSequence: 0, limit: 20 }
    })
    expect(events.ok).toBe(true)
    if (events.ok) {
      const data = events.data as { events: Array<{ sequence: number; type: string }> }
      expect(data.events.map((event) => event.type)).toEqual(['queued', 'started'])
    }

    const replay = await broker.handleRequest('pi', {
      type: 'get_operation_events',
      input: { operationId: created.operationId, afterSequence: 1, limit: 20 }
    })
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      const data = replay.data as { events: Array<{ sequence: number }> }
      expect(data.events).toHaveLength(1)
      expect(data.events[0].sequence).toBe(2)
    }

    const cancelled = await broker.handleRequest('pi', {
      type: 'cancel_operation',
      input: {
        idempotencyKey: 'cancel-1',
        operationId: created.operationId
      }
    })
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect((cancelled.data as { status: string }).status).toBe('cancelled')
  })

  it('creates confirmation operations for delete and overwrite export', async () => {
    await authService.grantInitial({
      agentId: 'pi',
      name: 'pi',
      version: '1.0.0',
      sessionIds: ['sess-1']
    })
    const deleted = await broker.handleRequest('pi', {
      type: 'delete_session',
      input: { idempotencyKey: 'del-1', sessionId: 'sess-1' }
    })
    expect(deleted.ok).toBe(true)
    if (deleted.ok)
      expect((deleted.data as { status: string }).status).toBe('awaiting_confirmation')

    const exported = await broker.handleRequest('pi', {
      type: 'export_pptx',
      input: {
        idempotencyKey: 'exp-1',
        sessionId: 'sess-1',
        outputPath: 'F:\\out\\deck.pptx',
        overwrite: true
      }
    })
    expect(exported.ok).toBe(true)
    if (exported.ok)
      expect((exported.data as { status: string }).status).toBe('awaiting_confirmation')
  })
})
