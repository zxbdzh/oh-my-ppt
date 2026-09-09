import type { GenerateStartPayload } from '@shared/generation'
import type {
  CreateSessionInput,
  EditDeckInput,
  EditPageInput,
  ExportPptxInput,
  ExternalAgentBrokerRequest,
  ImportPptxInput,
  StartGenerationInput
} from '@shared/external-agent'
import type { ExternalAgentOperationRecord, ExternalAgentOperationService } from './operations'
import { mapGenerateChunkToExternalEvent } from './event-map'
import type { ExternalAgentProductRuntime } from './product-runtime'
import type { ExternalAgentAuthorizationService } from './authorization'

const EXECUTABLE_TOOLS = new Set([
  'create_session',
  'start_generation',
  'edit_page',
  'edit_deck',
  'export_pptx',
  'import_pptx'
])

export class ExternalAgentRuntimeExecutor {
  private drains = new Map<string, Promise<void>>()

  constructor(
    private operations: ExternalAgentOperationService,
    private product: ExternalAgentProductRuntime,
    private auth?: ExternalAgentAuthorizationService
  ) {}

  kick(sessionId?: string): Promise<void> {
    if (sessionId) return this.drainKeyed(sessionId)
    return this.drainKeyed('')
  }

  private drainKeyed(key: string): Promise<void> {
    const existing = this.drains.get(key)
    if (existing) return existing
    const drain = this.drain(key).finally(() => this.drains.delete(key))
    this.drains.set(key, drain)
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
      if (!next) return
      if (!EXECUTABLE_TOOLS.has(next.toolName)) {
        await this.operations.transition({
          operationId: next.id,
          to: 'failed',
          errorCode: 'VALIDATION_FAILED',
          payload: { message: `工具暂未接通: ${next.toolName}` }
        })
        continue
      }
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
    if (record.toolName === 'create_session') {
      const input = this.toCreateSessionInput(record)
      const result = await this.product.createSession({
        title: input.title,
        topic: input.topic,
        styleId: input.styleId,
        slideSizeId: input.slideSizeId,
        pageCount: input.pageCount
      })
      if (!result.sessionId) throw new Error('创建 Session 未返回 sessionId')
      await this.auth?.attachSession(record.agentId, result.sessionId)
      await this.operations.transition({
        operationId: record.id,
        to: 'completed',
        progress: 100,
        sessionId: result.sessionId,
        resultRef: result.sessionId,
        eventType: 'completed',
        payload: { sessionId: result.sessionId }
      })
      return false
    }

    if (record.toolName === 'export_pptx') {
      const input = this.toExportPptxInput(record)
      const result = await this.product.exportPptx({
        sessionId: input.sessionId,
        outputPath: input.outputPath,
        overwrite: input.overwrite === true
      })
      await this.operations.transition({
        operationId: record.id,
        to: 'completed',
        progress: 100,
        resultRef: result.outputPath,
        eventType: 'completed',
        payload: { outputPath: result.outputPath }
      })
      return false
    }

    if (record.toolName === 'import_pptx') {
      const input = this.toImportPptxInput(record)
      const result = await this.product.importPptx({
        sourcePath: input.sourcePath,
        title: input.title,
        styleId: input.styleId
      })
      if (!result.sessionId) throw new Error('导入 PPTX 未返回 sessionId')
      await this.auth?.attachSession(record.agentId, result.sessionId)
      await this.operations.transition({
        operationId: record.id,
        to: 'completed',
        progress: 100,
        sessionId: result.sessionId,
        resultRef: result.sessionId,
        eventType: 'completed',
        payload: { sessionId: result.sessionId }
      })
      return false
    }

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
        pageCount: input.pageCount,
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

  private parseRequest(record: ExternalAgentOperationRecord): ExternalAgentBrokerRequest {
    if (!record.requestJson) throw new Error('operation 缺少可执行请求')
    try {
      const parsed = JSON.parse(record.requestJson) as ExternalAgentBrokerRequest
      if (!parsed || typeof parsed !== 'object' || !('input' in parsed)) {
        throw new Error('operation 缺少可执行请求')
      }
      return parsed
    } catch {
      throw new Error('operation 缺少可执行请求')
    }
  }

  private toCreateSessionInput(record: ExternalAgentOperationRecord): CreateSessionInput {
    const parsed = this.parseRequest(record)
    if (parsed.type !== 'create_session') throw new Error('operation 不是 create_session')
    return parsed.input
  }

  private toExportPptxInput(record: ExternalAgentOperationRecord): ExportPptxInput {
    const parsed = this.parseRequest(record)
    if (parsed.type !== 'export_pptx') throw new Error('operation 不是 export_pptx')
    return parsed.input
  }

  private toImportPptxInput(record: ExternalAgentOperationRecord): ImportPptxInput {
    const parsed = this.parseRequest(record)
    if (parsed.type !== 'import_pptx') throw new Error('operation 不是 import_pptx')
    return parsed.input
  }
}
