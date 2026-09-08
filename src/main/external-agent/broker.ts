import {
  COMPATIBLE_EXTERNAL_AGENT_PROTOCOL_VERSIONS,
  createExternalAgentError,
  buildDefaultCapabilitiesOutput,
  isProtocolVersionSupported,
  redactPageSnapshot,
  redactSessionSnapshot,
  type ExternalAgentBrokerRequest,
  type ExternalAgentCapability,
  type ExternalAgentErrorPayload,
  type ExternalAgentFailureResponse,
  type ExternalAgentPageSnapshot,
  type ExternalAgentSessionSnapshot,
  type ExternalAgentStyleSummary,
  type ExternalAgentToolName,
  type InitializeOutput,
  type ListSessionsOutput
} from '@shared/external-agent'
import type { ExternalAgentAuthorizationService } from './authorization'
import { computeRequestHash } from './idempotency'
import { toOperationSummary, type ExternalAgentOperationService } from './operations'
import type { ExternalAgentRuntimeExecutor } from './runtime-executor'

export interface BrokerSessionLookupResult {
  session: Parameters<typeof redactSessionSnapshot>[0]['session'] | null
  pages?: Parameters<typeof redactSessionSnapshot>[0]['pages']
  styleSummary?: ExternalAgentStyleSummary | null
}

export interface ExternalAgentBrokerDataSource {
  listAuthorizedSessions(sessionIds: string[]): Promise<BrokerSessionLookupResult[]>
  getSessionWithPages(sessionId: string): Promise<BrokerSessionLookupResult | null>
  listAvailableStyles?(): Promise<ExternalAgentStyleSummary[]>
}

export type BrokerResponse<T> =
  | { ok: true; data: T; operationId?: string }
  | ExternalAgentFailureResponse

export interface ExternalAgentAuthPromptInput {
  agentId: string
  name: string
  version: string
  executablePath?: string
}

export interface ExternalAgentAuthPromptResult {
  approved: boolean
  capabilities?: ExternalAgentCapability[]
  sessionIds?: string[]
  workspaceRoots?: string[]
}

export type ExternalAgentAuthPrompt = (
  input: ExternalAgentAuthPromptInput
) => Promise<ExternalAgentAuthPromptResult>

const ENQUEUE_TOOLS = new Set<ExternalAgentToolName>([
  'create_session',
  'start_generation',
  'edit_page',
  'edit_deck',
  'import_pptx',
  'import_assets',
  'export_pptx',
  'delete_page',
  'delete_session'
])

function isEnqueueableTool(
  type: ExternalAgentBrokerRequest['type']
): type is ExternalAgentToolName {
  return ENQUEUE_TOOLS.has(type as ExternalAgentToolName)
}

const TOOL_CAPABILITY: Partial<Record<ExternalAgentToolName, ExternalAgentCapability>> = {
  list_sessions: 'read',
  get_session: 'read',
  get_page: 'read',
  create_session: 'create_session',
  start_generation: 'generation',
  edit_page: 'page_edit',
  edit_deck: 'deck_edit',
  import_pptx: 'import_pptx',
  import_assets: 'import_assets',
  export_pptx: 'export_pptx',
  get_operation: 'task_control',
  get_operation_events: 'task_control',
  subscribe_events: 'task_control',
  cancel_operation: 'task_control',
  resume_operation: 'task_control'
}

const fail = (
  error: ExternalAgentErrorPayload,
  operationId?: string
): ExternalAgentFailureResponse => ({
  ok: false,
  error,
  operationId
})

const isErrorPayload = (value: unknown): value is ExternalAgentErrorPayload =>
  Boolean(value) &&
  typeof value === 'object' &&
  'code' in (value as object) &&
  'retryable' in (value as object) &&
  !('id' in (value as object))

export class ExternalAgentBroker {
  constructor(
    private authService: ExternalAgentAuthorizationService,
    private dataSource: ExternalAgentBrokerDataSource,
    private serverVersion: string = '2.3.0',
    private operations?: ExternalAgentOperationService,
    private executor?: ExternalAgentRuntimeExecutor,
    private promptAuth?: ExternalAgentAuthPrompt
  ) {}

  async handleRequest(
    agentId: string,
    request: ExternalAgentBrokerRequest
  ): Promise<BrokerResponse<unknown>> {
    if (request.type === 'initialize') {
      const { protocolVersion } = request.input
      if (!isProtocolVersionSupported(protocolVersion)) {
        return fail(
          createExternalAgentError({
            code: 'PROTOCOL_VERSION_UNSUPPORTED',
            message: `不支持的协议版本: ${protocolVersion}。支持的版本: ${COMPATIBLE_EXTERNAL_AGENT_PROTOCOL_VERSIONS.join(', ')}`,
            details: {
              requestedVersion: protocolVersion,
              supportedVersions: [...COMPATIBLE_EXTERNAL_AGENT_PROTOCOL_VERSIONS]
            }
          })
        )
      }

      let access = await this.authService.checkAccess({ agentId })
      const needsPrompt =
        !access.authorized &&
        Boolean(this.promptAuth) &&
        (access.error?.code === 'AUTH_REQUIRED' || access.error?.code === 'AUTH_REVOKED')
      if (needsPrompt && this.promptAuth) {
        const decision = await this.promptAuth({
          agentId,
          name: request.input.clientInfo.name,
          version: request.input.clientInfo.version,
          executablePath: request.input.clientInfo.executablePath
        })
        if (!decision.approved) {
          return fail(
            createExternalAgentError({
              code: 'AUTH_REQUIRED',
              message: '用户拒绝了该 Agent 的首次授权',
              details: { agentId }
            })
          )
        }
        await this.authService.grantInitial({
          agentId,
          name: request.input.clientInfo.name,
          version: request.input.clientInfo.version,
          executablePath: request.input.clientInfo.executablePath,
          capabilities: decision.capabilities,
          sessionIds: decision.sessionIds,
          workspaceRoots: decision.workspaceRoots
        })
        access = await this.authService.checkAccess({ agentId })
      } else if (access.authorized) {
        await this.authService.touchLastUsed(agentId)
      }
      const data: InitializeOutput = {
        protocolVersion,
        supportedProtocolVersions: [...COMPATIBLE_EXTERNAL_AGENT_PROTOCOL_VERSIONS],
        serverInfo: {
          name: 'oh-my-ppt',
          version: this.serverVersion
        },
        authenticated: access.authorized,
        agentId: access.authorized ? agentId : undefined
      }
      return { ok: true, data }
    }

    if (request.type === 'get_capabilities') {
      const availableStyles = this.dataSource.listAvailableStyles
        ? await this.dataSource.listAvailableStyles()
        : []
      return { ok: true, data: buildDefaultCapabilitiesOutput({ availableStyles }) }
    }

    if (request.type === 'list_sessions') {
      const access = await this.authService.checkAccess({ agentId, capability: 'read' })
      if (!access.authorized || !access.grant) {
        return fail(
          access.error ??
            createExternalAgentError({
              code: 'AUTH_REQUIRED',
              message: '需要授权后才能列出 Session'
            })
        )
      }

      const records = await this.dataSource.listAuthorizedSessions(access.grant.sessionIds)
      const sessions = records
        .map((r) => {
          if (!r.session) return null
          const snapshot = redactSessionSnapshot({
            session: r.session,
            pages: r.pages,
            styleSummary: r.styleSummary
          })
          const firstPageTitle = snapshot.pages[0]?.title
          const { pages, ...rest } = snapshot
          void pages
          return {
            ...rest,
            firstPageTitle
          }
        })
        .filter((s): s is NonNullable<typeof s> => Boolean(s))

      const limit = request.input.limit ?? 30
      const data: ListSessionsOutput = { sessions: sessions.slice(0, limit) }
      return { ok: true, data }
    }

    if (request.type === 'get_session') {
      const { sessionId } = request.input
      const access = await this.authService.checkAccess({
        agentId,
        capability: 'read',
        sessionId
      })
      if (!access.authorized) {
        return fail(
          access.error ??
            createExternalAgentError({
              code: 'AUTH_REQUIRED',
              message: '需要授权后才能读取 Session'
            })
        )
      }

      const record = await this.dataSource.getSessionWithPages(sessionId)
      if (!record || !record.session) {
        return fail(
          createExternalAgentError({
            code: 'SESSION_NOT_FOUND',
            message: `未找到 Session: ${sessionId}`,
            details: { sessionId }
          })
        )
      }

      const data: ExternalAgentSessionSnapshot = redactSessionSnapshot({
        session: record.session,
        pages: record.pages,
        styleSummary: record.styleSummary
      })
      return { ok: true, data }
    }

    if (request.type === 'get_page') {
      const { sessionId, pageId } = request.input
      const access = await this.authService.checkAccess({
        agentId,
        capability: 'read',
        sessionId
      })
      if (!access.authorized) {
        return fail(
          access.error ??
            createExternalAgentError({ code: 'AUTH_REQUIRED', message: '需要授权后才能读取页面' })
        )
      }

      const record = await this.dataSource.getSessionWithPages(sessionId)
      if (!record || !record.session) {
        return fail(
          createExternalAgentError({
            code: 'SESSION_NOT_FOUND',
            message: `未找到 Session: ${sessionId}`,
            details: { sessionId }
          })
        )
      }

      const rawPage = record.pages?.find((p) => (p.page_id || p.id) === pageId)
      if (!rawPage) {
        return fail(
          createExternalAgentError({
            code: 'VALIDATION_FAILED',
            message: `在 Session ${sessionId} 中未找到页面 ${pageId}`,
            details: { sessionId, pageId }
          })
        )
      }

      const pageIndex = record.pages?.indexOf(rawPage) ?? 0
      const data: ExternalAgentPageSnapshot = redactPageSnapshot(rawPage, pageIndex + 1)
      return { ok: true, data }
    }

    return this.handleMutationOrTask(agentId, request)
  }

  private async handleMutationOrTask(
    agentId: string,
    request: ExternalAgentBrokerRequest
  ): Promise<BrokerResponse<unknown>> {
    if (!this.operations) {
      return fail(
        createExternalAgentError({
          code: 'VALIDATION_FAILED',
          message: `工具未就绪或未支持: ${request.type}`
        })
      )
    }

    if (request.type === 'initialize') {
      return fail(
        createExternalAgentError({
          code: 'VALIDATION_FAILED',
          message: 'initialize 不应进入写路径'
        })
      )
    }
    const capability = TOOL_CAPABILITY[request.type]
    const sessionId = this.sessionIdOf(request)
    const needsSession =
      request.type !== 'create_session' &&
      request.type !== 'import_pptx' &&
      request.type !== 'get_operation' &&
      request.type !== 'get_operation_events' &&
      request.type !== 'subscribe_events' &&
      request.type !== 'cancel_operation' &&
      request.type !== 'resume_operation'

    const access = await this.authService.checkAccess({
      agentId,
      capability:
        request.type === 'delete_page' || request.type === 'delete_session'
          ? undefined
          : capability,
      sessionId: needsSession ? sessionId : undefined
    })
    if (!access.authorized) {
      return fail(
        access.error ??
          createExternalAgentError({ code: 'AUTH_REQUIRED', message: '需要授权后才能调用该工具' })
      )
    }

    if (request.type === 'get_operation') {
      return this.readOperation(agentId, request.input.operationId)
    }
    if (request.type === 'get_operation_events' || request.type === 'subscribe_events') {
      return this.readEvents(
        agentId,
        request.input.operationId,
        request.input.afterSequence ?? 0,
        request.type === 'get_operation_events' ? (request.input.limit ?? 50) : 200
      )
    }
    if (request.type === 'cancel_operation') {
      return this.cancelOperation(agentId, request)
    }
    if (request.type === 'resume_operation') {
      return this.resumeOperation(agentId, request)
    }

    if (!isEnqueueableTool(request.type)) {
      return fail(
        createExternalAgentError({
          code: 'VALIDATION_FAILED',
          message: `工具未就绪或未支持: ${request.type}`
        })
      )
    }

    const idempotencyKey =
      'idempotencyKey' in request.input ? request.input.idempotencyKey : undefined
    if (!idempotencyKey) {
      return fail(
        createExternalAgentError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: '缺少幂等键 idempotencyKey'
        })
      )
    }

    const requestHash = computeRequestHash(request.input)
    const existing = await this.operations.getByIdempotency(agentId, idempotencyKey)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          createExternalAgentError({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: `幂等键 ${idempotencyKey} 已被其他请求使用`,
            details: { idempotencyKey, existingOperationId: existing.id }
          }),
          existing.id
        )
      }
      return {
        ok: true,
        data: toOperationSummary(existing),
        operationId: existing.id
      }
    }

    const awaitingConfirmation =
      request.type === 'delete_page' ||
      request.type === 'delete_session' ||
      (request.type === 'export_pptx' && request.input.overwrite === true)

    const record = await this.operations.enqueue({
      agentId,
      sessionId,
      toolName: request.type,
      idempotencyKey,
      requestHash,
      requestJson: JSON.stringify(request),
      initialStatus: awaitingConfirmation ? 'awaiting_confirmation' : 'queued'
    })
    this.executor?.kick(sessionId)
    return {
      ok: true,
      data: toOperationSummary(record),
      operationId: record.id
    }
  }

  private sessionIdOf(request: ExternalAgentBrokerRequest): string | undefined {
    if (!('input' in request) || !request.input || typeof request.input !== 'object')
      return undefined
    const sessionId = (request.input as { sessionId?: unknown }).sessionId
    return typeof sessionId === 'string' ? sessionId : undefined
  }

  private async readOperation(
    agentId: string,
    operationId: string
  ): Promise<BrokerResponse<unknown>> {
    const record = await this.operations?.get(operationId)
    if (!record) {
      return fail(
        createExternalAgentError({
          code: 'OPERATION_NOT_FOUND',
          message: `未找到 operation: ${operationId}`,
          details: { operationId }
        })
      )
    }
    if (record.agentId !== agentId) {
      return fail(
        createExternalAgentError({
          code: 'NOT_AUTHORIZED',
          message: '只能查询自己发起的 operation',
          details: { operationId }
        })
      )
    }
    return { ok: true, data: toOperationSummary(record), operationId: record.id }
  }

  private async readEvents(
    agentId: string,
    operationId: string,
    afterSequence: number,
    limit: number
  ): Promise<BrokerResponse<unknown>> {
    const record = await this.operations?.get(operationId)
    if (!record) {
      return fail(
        createExternalAgentError({
          code: 'OPERATION_NOT_FOUND',
          message: `未找到 operation: ${operationId}`,
          details: { operationId }
        })
      )
    }
    if (record.agentId !== agentId) {
      return fail(
        createExternalAgentError({
          code: 'NOT_AUTHORIZED',
          message: '只能查询自己发起的 operation 事件',
          details: { operationId }
        })
      )
    }
    const events = await this.operations?.listEvents(operationId, afterSequence, limit)
    return {
      ok: true,
      data: { events: events ?? [], nextSequence: events?.at(-1)?.sequence ?? afterSequence },
      operationId
    }
  }

  private async cancelOperation(
    agentId: string,
    request: Extract<ExternalAgentBrokerRequest, { type: 'cancel_operation' }>
  ): Promise<BrokerResponse<unknown>> {
    const current = await this.operations?.get(request.input.operationId)
    const result = await this.operations?.cancel({
      operationId: request.input.operationId,
      agentId,
      reason: request.input.reason
    })
    if (!result) {
      return fail(
        createExternalAgentError({
          code: 'VALIDATION_FAILED',
          message: 'operation 服务未就绪'
        })
      )
    }
    if (isErrorPayload(result)) return fail(result, request.input.operationId)
    if (current?.sessionId) {
      await this.executor?.cancelProduct(current.sessionId)
      this.executor?.kick(current.sessionId)
    }
    return { ok: true, data: toOperationSummary(result), operationId: result.id }
  }

  private async resumeOperation(
    agentId: string,
    request: Extract<ExternalAgentBrokerRequest, { type: 'resume_operation' }>
  ): Promise<BrokerResponse<unknown>> {
    const current = await this.operations?.get(request.input.operationId)
    if (!current) {
      return fail(
        createExternalAgentError({
          code: 'OPERATION_NOT_FOUND',
          message: `未找到 operation: ${request.input.operationId}`,
          details: { operationId: request.input.operationId }
        })
      )
    }
    if (current.agentId !== agentId) {
      return fail(
        createExternalAgentError({
          code: 'NOT_AUTHORIZED',
          message: '只能恢复自己发起的 operation',
          details: { operationId: current.id }
        })
      )
    }
    if (!current.resumable || current.status !== 'interrupted') {
      return fail(
        createExternalAgentError({
          code: 'OPERATION_NOT_RESUMABLE',
          message: '该 operation 不可恢复',
          details: { operationId: current.id, status: current.status }
        }),
        current.id
      )
    }
    const resumed = await this.operations?.transition({
      operationId: current.id,
      to: 'queued',
      payload: { resumedWith: request.input.idempotencyKey }
    })
    if (!resumed || isErrorPayload(resumed)) {
      return fail(
        isErrorPayload(resumed)
          ? resumed
          : createExternalAgentError({
              code: 'VALIDATION_FAILED',
              message: '恢复 operation 失败'
            }),
        current.id
      )
    }
    this.executor?.kick(resumed.sessionId)
    return { ok: true, data: toOperationSummary(resumed), operationId: resumed.id }
  }
}
