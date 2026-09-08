import type { GenerateStartPayload } from '@shared/generation'
import type { GenerateJobManager } from '../generation/job-manager'
import type { PageEditJobService } from '../edit-jobs/page-edit-job-service'
import type { DeckEditJobService } from '../edit-jobs/deck-edit-job-service'
import { resolveDeckContext, executeDeckGeneration } from '../generation/deck-flow'
import { createEmitAssistantMessage } from '../generation/generation-utils'
import { finalizeGenerationFailure } from '../generation/finalization'

export type ExternalAgentProductStartResult = {
  success: boolean
  runId?: string
  queued?: boolean
  alreadyRunning?: boolean
}

export interface ExternalAgentProductRuntime {
  startGeneration(payload: GenerateStartPayload): Promise<ExternalAgentProductStartResult>
  startPageEdit(payload: GenerateStartPayload): Promise<ExternalAgentProductStartResult>
  startDeckEdit(payload: GenerateStartPayload): Promise<ExternalAgentProductStartResult>
  cancelSession(sessionId: string): Promise<boolean>
}

// SAFETY: resolveDeckContext / page-edit start ignore the IPC event object.
const unusedIpcEvent = {} as Electron.IpcMainInvokeEvent

export function createIpcProductRuntime(args: {
  jobManager: GenerateJobManager
  pageEditJobs: PageEditJobService
  deckEditJobs: DeckEditJobService
}): ExternalAgentProductRuntime {
  return {
    startGeneration: (payload) => startGenerationViaJobManager(args.jobManager, payload),
    startPageEdit: (payload) => args.pageEditJobs.start(unusedIpcEvent, payload),
    startDeckEdit: (payload) => args.deckEditJobs.start(unusedIpcEvent, payload),
    cancelSession: async (sessionId) => {
      if (await args.pageEditJobs.cancel(sessionId)) return true
      if (await args.deckEditJobs.cancel(sessionId)) return true
      return args.jobManager.cancel(sessionId)
    }
  }
}

export async function startGenerationViaJobManager(
  jobManager: GenerateJobManager,
  payload: GenerateStartPayload
): Promise<ExternalAgentProductStartResult> {
  const ctx = jobManager.generationContext
  const reservation = await jobManager.reserve(
    'external-agent:start_generation',
    payload.sessionId,
    crypto.randomUUID()
  )
  if (reservation.alreadyRunning) {
    return { success: true, runId: reservation.runId, alreadyRunning: true }
  }
  const reserved = reservation.reservation
  let handedToBackground = false
  let context: Awaited<ReturnType<typeof resolveDeckContext>> | null = null
  try {
    context = await resolveDeckContext(ctx, unusedIpcEvent, payload, {
      runId: reserved.jobId,
      abortSignal: reserved.signal
    })
    jobManager.assertNotCancelled(reserved)
    const emitAssistant = createEmitAssistantMessage(ctx.db, ctx.runtimeEmitters.emitGenerateChunk)
    const result = await jobManager.enqueue({
      reservation: reserved,
      kind: 'standard',
      context,
      totalPages: context.totalPages,
      execute: (deckContext) => executeDeckGeneration(ctx, emitAssistant, deckContext)
    })
    handedToBackground = true
    return { success: true, runId: result.runId, queued: result.queued }
  } catch (error) {
    if (context && !handedToBackground) {
      await finalizeGenerationFailure(ctx, context, error)
    }
    throw error
  } finally {
    if (!handedToBackground) jobManager.release(reserved)
  }
}
