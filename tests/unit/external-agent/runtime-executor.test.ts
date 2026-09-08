import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
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
      createSession: vi.fn(async () => ({ success: true, sessionId: 'sess-new' })),
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
      input: { idempotencyKey: 'gen-1', sessionId: 'sess-1', topic: '季度复盘', pageCount: 6 }
    })
    expect(created.ok).toBe(true)
    await executor.kick('sess-1')
    expect(product.startGeneration).toHaveBeenCalledTimes(1)
    expect(product.startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', pageCount: 6 })
    )
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
      createSession: vi.fn(async () => ({ success: true, sessionId: 'sess-new' })),
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

  it('creates a session without a prior sessionId and attaches it to the grant', async () => {
    const operations = new ExternalAgentOperationService(new InMemoryExternalAgentOperationStore())
    const product: ExternalAgentProductRuntime = {
      startGeneration: vi.fn(async () => ({ success: true })),
      startPageEdit: vi.fn(async () => ({ success: true })),
      startDeckEdit: vi.fn(async () => ({ success: true })),
      createSession: vi.fn(async () => ({ success: true, sessionId: 'sess-created' })),
      cancelSession: vi.fn(async () => true)
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-create-'))
    const auth = new ExternalAgentAuthorizationService(
      new InMemoryExternalAgentAuthorizationStore()
    )
    await auth.grantInitial({
      agentId: 'pi',
      name: 'pi',
      version: '1.0.0',
      workspaceRoots: [workspace]
    })
    const executor = new ExternalAgentRuntimeExecutor(operations, product, auth)
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
      type: 'create_session',
      input: {
        idempotencyKey: 'create-1',
        title: '新演示',
        styleId: 'modern',
        workspaceRootPath: workspace
      }
    })
    expect(created.ok).toBe(true)
    await executor.kick()
    expect(product.createSession).toHaveBeenCalledTimes(1)
    const record = await operations.get((created as { operationId?: string }).operationId || '')
    expect(record?.status).toBe('completed')
    expect(record?.sessionId).toBe('sess-created')
    expect(record?.resultRef).toBe('sess-created')
    const access = await auth.checkAccess({
      agentId: 'pi',
      capability: 'read',
      sessionId: 'sess-created'
    })
    expect(access.authorized).toBe(true)
  })

  it('creates a session using the granted workspace when workspaceRootPath is omitted', async () => {
    const operations = new ExternalAgentOperationService(new InMemoryExternalAgentOperationStore())
    const product: ExternalAgentProductRuntime = {
      startGeneration: vi.fn(async () => ({ success: true })),
      startPageEdit: vi.fn(async () => ({ success: true })),
      startDeckEdit: vi.fn(async () => ({ success: true })),
      createSession: vi.fn(async () => ({ success: true, sessionId: 'sess-default' })),
      cancelSession: vi.fn(async () => true)
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-create-default-'))
    const auth = new ExternalAgentAuthorizationService(
      new InMemoryExternalAgentAuthorizationStore()
    )
    await auth.grantInitial({
      agentId: 'pi',
      name: 'pi',
      version: '1.0.0',
      workspaceRoots: [workspace]
    })
    const executor = new ExternalAgentRuntimeExecutor(operations, product, auth)
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
      type: 'create_session',
      input: {
        idempotencyKey: 'create-default',
        title: '默认工作区演示'
      }
    })
    expect(created.ok).toBe(true)
    await executor.kick()
    expect(product.createSession).toHaveBeenCalledTimes(1)
    const record = await operations.get((created as { operationId?: string }).operationId || '')
    expect(record?.status).toBe('completed')
    expect(record?.sessionId).toBe('sess-default')
  })

  it('fails queued file tools that are not yet executable', async () => {
    const operations = new ExternalAgentOperationService(new InMemoryExternalAgentOperationStore())
    const product: ExternalAgentProductRuntime = {
      startGeneration: vi.fn(async () => ({ success: true })),
      startPageEdit: vi.fn(async () => ({ success: true })),
      startDeckEdit: vi.fn(async () => ({ success: true })),
      createSession: vi.fn(async () => ({ success: true, sessionId: 'sess-new' })),
      cancelSession: vi.fn(async () => true)
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-import-'))
    const sourcePath = path.join(workspace, 'deck.pptx')
    fs.writeFileSync(sourcePath, 'pptx')
    const auth = new ExternalAgentAuthorizationService(
      new InMemoryExternalAgentAuthorizationStore()
    )
    await auth.grantInitial({
      agentId: 'pi',
      name: 'pi',
      version: '1.0.0',
      workspaceRoots: [workspace]
    })
    const executor = new ExternalAgentRuntimeExecutor(operations, product, auth)
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

    const imported = await broker.handleRequest('pi', {
      type: 'import_pptx',
      input: {
        idempotencyKey: 'import-1',
        sourcePath
      }
    })
    expect(imported.ok).toBe(true)
    await executor.kick()
    const record = await operations.get((imported as { operationId?: string }).operationId || '')
    expect(record?.status).toBe('failed')
    expect(record?.errorCode).toBe('VALIDATION_FAILED')
  })
})
