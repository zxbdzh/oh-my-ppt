import { describe, expect, it, vi } from 'vitest'
import {
  ExternalAgentAuthorizationService,
  InMemoryExternalAgentAuthorizationStore
} from '../../../src/main/external-agent/authorization'
import { ExternalAgentBroker } from '../../../src/main/external-agent/broker'
import {
  ExternalAgentOperationService,
  InMemoryExternalAgentOperationStore
} from '../../../src/main/external-agent/operations'
import type { ExternalAgentProductRuntime } from '../../../src/main/external-agent/product-runtime'
import { ExternalAgentRuntimeExecutor } from '../../../src/main/external-agent/runtime-executor'

describe('external agent runtime executor', () => {
  it('dequeues start_generation through the product runtime and maps completion chunks', async () => {
    const operations = new ExternalAgentOperationService(new InMemoryExternalAgentOperationStore())
    const product: ExternalAgentProductRuntime = {
      startGeneration: vi.fn(async () => ({ success: true, runId: 'run-1', queued: false })),
      startPageEdit: vi.fn(async () => ({ success: true, runId: 'run-edit' })),
      startDeckEdit: vi.fn(async () => ({ success: true, runId: 'run-deck' })),
      cancelSession: vi.fn(async () => true)
    }
    const executor = new ExternalAgentRuntimeExecutor(operations, product)
    const auth = new ExternalAgentAuthorizationService(
      new InMemoryExternalAgentAuthorizationStore()
    )
    await auth.grantInitial({
      agentId: 'pi',
      name: 'pi',
      version: '1.0.0',
      sessionIds: ['sess-1']
    })
    const broker = new ExternalAgentBroker(
      auth,
      {
        async listAuthorizedSessions() {
          return []
        },
        async getSessionWithPages() {
          return null
        }
      },
      '2.3.0',
      operations,
      executor
    )

    const created = await broker.handleRequest('pi', {
      type: 'start_generation',
      input: { idempotencyKey: 'gen-1', sessionId: 'sess-1', topic: '季度复盘' }
    })
    expect(created.ok).toBe(true)
    await executor.kick('sess-1')
    expect(product.startGeneration).toHaveBeenCalledTimes(1)
    const running = await operations.listRunning('sess-1')
    expect(running).toHaveLength(1)
    expect(running[0].resultRef).toBe('run-1')

    await executor.observeChunk('sess-1', {
      type: 'run_completed',
      payload: { runId: 'run-1', totalPages: 3, completedPageCount: 3, failedPageCount: 0 }
    })
    expect((await operations.get(running[0].id))?.status).toBe('completed')
  })

  it('requeues when JobCoordinator is already running and cancels the product session', async () => {
    const operations = new ExternalAgentOperationService(new InMemoryExternalAgentOperationStore())
    const product: ExternalAgentProductRuntime = {
      startGeneration: vi.fn(async () => ({
        success: true,
        runId: 'busy-run',
        alreadyRunning: true
      })),
      startPageEdit: vi.fn(async () => ({ success: true })),
      startDeckEdit: vi.fn(async () => ({ success: true })),
      cancelSession: vi.fn(async () => true)
    }
    const executor = new ExternalAgentRuntimeExecutor(operations, product)
    const auth = new ExternalAgentAuthorizationService(
      new InMemoryExternalAgentAuthorizationStore()
    )
    await auth.grantInitial({
      agentId: 'pi',
      name: 'pi',
      version: '1.0.0',
      sessionIds: ['sess-1']
    })
    const broker = new ExternalAgentBroker(
      auth,
      {
        async listAuthorizedSessions() {
          return []
        },
        async getSessionWithPages() {
          return null
        }
      },
      '2.3.0',
      operations,
      executor
    )

    const created = await broker.handleRequest('pi', {
      type: 'start_generation',
      input: { idempotencyKey: 'gen-busy', sessionId: 'sess-1', topic: '主题' }
    })
    expect(created.ok).toBe(true)
    await executor.kick('sess-1')
    const queued = await operations.peekQueued('sess-1')
    expect(queued?.status).toBe('queued')

    const cancelled = await broker.handleRequest('pi', {
      type: 'cancel_operation',
      input: { idempotencyKey: 'cancel-1', operationId: queued?.id || '' }
    })
    expect(cancelled.ok).toBe(true)
    expect(product.cancelSession).toHaveBeenCalledWith('sess-1')
  })
})
