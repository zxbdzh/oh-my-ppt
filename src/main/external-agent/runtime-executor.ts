import type { GenerateStartPayload } from '@shared/generation'
import type {
  EditDeckInput,
  EditPageInput,
  ExternalAgentBrokerRequest,
  StartGenerationInput
} from '@shared/external-agent'
import type { ExternalAgentOperationRecord, ExternalAgentOperationService } from './operations'
import { mapGenerateChunkToExternalEvent } from './event-map'
import type { ExternalAgentProductRuntime } from './product-runtime'

const EXECUTABLE_TOOLS = new Set(['start_generation', 'edit_page', 'edit_deck'])

export class ExternalAgentRuntimeExecutor {
  private drains = new Map<string, Promise<void>>()

  constructor(
    private operations: ExternalAgentOperationService,
    private product: ExternalAgentProductRuntime
  ) {}

  kick(sessionId?: string): Promise<void> {
    if (!sessionId) return Promise.resolve()
    const existing = this.drains.get(sessionId)
    if (existing) return existing
    const drain = this.drain(sessionId).finally(() => this.drains.delete(sessionId))
    this.drains.set(sessionId, drain)
    return drain
  }

  async cancelProduct(sessionId: string): Promise<boolean> {
    return this.product.cancelSession(sessionId)
  }

  private async drain(sessionId: string): Promise<void> {
    for (;;) {
      const running = await this.operations.listRunning(sessionId)
      if (running.length > 0) return
      const next = await this.operations.peekQueued(sessionId)
      if (!next || !EXECUTABLE_TOOLS.has(next.toolName)) return
      const started = await this.operations.dequeueNext(sessionId)
      if (!started) return
      try {
        const waitingForProduct = await this.execute(started)
        if (waitingForProduct) return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const cancelled = /取消|cancel/i.test(message)
        await this.operations.transition({
          operationId: started.id,
          to: cancelled ? 'cancelled' : 'failed',
          errorCode: cancelled ? undefined : 'INTERNAL_ERROR',
          payload: { message }
        })
      }
    }
  }

  private async execute(record: ExternalAgentOperationRecord): Promise<boolean> {
    const payload = this.toGeneratePayload(record)
    const result =
      record.toolName === 'start_generation'
        ? await this.product.startGeneration(payload)
        : record.toolName === 'edit_page'
          ? await this.product.startPageEdit(payload)
          : await this.product.startDeckEdit(payload)

    if (result.alreadyRunning) {
      await this.operations.transition({
        operationId: record.id,
        to: 'queued',
        payload: { waitingFor: result.runId ?? null }
      })
      return true
    }

    await this.operations.transition({
      operationId: record.id,
      to: 'running',
      resultRef: result.runId,
      eventType: 'started',
      payload: { runId: result.runId ?? null, queued: result.queued ?? false }
    })
    return false
  }

  observeChunk(
    sessionId: string,
    chunk: Parameters<typeof mapGenerateChunkToExternalEvent>[0]
  ): Promise<void> {
    return this.forwardChunk(sessionId, chunk)
  }

  private async forwardChunk(
    sessionId: string,
    chunk: Parameters<typeof mapGenerateChunkToExternalEvent>[0]
  ): Promise<void> {
    const mapped = mapGenerateChunkToExternalEvent(chunk)
    if (!mapped) return
    const running = await this.operations.listRunning(sessionId)
    const target = running[0]
    if (!target) return
    if (mapped.type === 'completed' || mapped.type === 'failed' || mapped.type === 'cancelled') {
      await this.operations.transition({
        operationId: target.id,
        to: mapped.type,
        progress: mapped.progress ?? target.progress,
        checkpoint: mapped.checkpoint ?? target.checkpoint,
        eventType: mapped.type,
        payload: mapped.payload
      })
      this.kick(sessionId)
      return
    }
    await this.operations.transition({
      operationId: target.id,
      to: 'running',
      progress: mapped.progress ?? target.progress,
      checkpoint: mapped.checkpoint ?? target.checkpoint,
      eventType: mapped.type,
      payload: mapped.payload
    })
  }

  private toGeneratePayload(record: ExternalAgentOperationRecord): GenerateStartPayload {
    let parsed: ExternalAgentBrokerRequest | null = null
    if (record.requestJson) {
      try {
        parsed = JSON.parse(record.requestJson) as ExternalAgentBrokerRequest
      } catch {
        parsed = null
      }
    }
    if (!parsed || typeof parsed !== 'object' || !('input' in parsed)) {
      throw new Error('operation 缺少可执行请求')
    }
    if (parsed.type === 'start_generation') {
      const input = parsed.input as StartGenerationInput
      const imagePaths = (input.reusedAssetPaths ?? []).filter((item) =>
        item.startsWith('./images/')
      )
      const videoPaths = (input.reusedAssetPaths ?? []).filter((item) =>
        item.startsWith('./videos/')
      )
      const docPaths = (input.reusedAssetPaths ?? []).filter((item) => item.startsWith('./docs/'))
      return {
        sessionId: input.sessionId,
        userMessage: [input.topic, input.prompt].filter(Boolean).join('\n\n'),
        type: 'deck',
        chatType: 'main',
        imagePaths,
        videoPaths,
        docPaths
      }
    }
    if (parsed.type === 'edit_page') {
      const input = parsed.input as EditPageInput
      return {
        sessionId: input.sessionId,
        userMessage: input.instruction,
        type: 'page',
        chatType: 'page',
        chatPageId: input.pageId,
        selectedPageId: input.pageId,
        selector: input.targetSelector,
        autoApply: true,
        imagePaths: (input.reusedAssetPaths ?? []).filter((item) => item.startsWith('./images/')),
        videoPaths: (input.reusedAssetPaths ?? []).filter((item) => item.startsWith('./videos/'))
      }
    }
    if (parsed.type === 'edit_deck') {
      const input = parsed.input as EditDeckInput
      return {
        sessionId: input.sessionId,
        userMessage: input.instruction,
        type: 'page',
        chatType: 'main',
        autoApply: true,
        imagePaths: (input.reusedAssetPaths ?? []).filter((item) => item.startsWith('./images/')),
        videoPaths: (input.reusedAssetPaths ?? []).filter((item) => item.startsWith('./videos/'))
      }
    }
    throw new Error(`不支持执行工具: ${record.toolName}`)
  }
}
