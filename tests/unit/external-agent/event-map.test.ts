import { describe, expect, it, vi } from 'vitest'
import {
  bindExecutorToRuntimeChunks,
  mapGenerateChunkToExternalEvent,
  type ExecutorRuntimeChunkEvent
} from '../../../src/main/external-agent/event-map'

describe('external agent event map', () => {
  it('maps run_completed without failed pages to completed', () => {
    const mapped = mapGenerateChunkToExternalEvent({
      type: 'run_completed',
      payload: { runId: 'run-1', totalPages: 1 }
    })
    expect(mapped?.type).toBe('completed')
    expect(mapped?.progress).toBe(100)
  })

  it('forwards edit-domain generation.chunk to observeChunk', () => {
    const observeChunk = vi.fn()
    const listeners = new Map<string, (event: ExecutorRuntimeChunkEvent) => void>()
    bindExecutorToRuntimeChunks((filter, listener) => {
      listeners.set(filter.domain, listener)
    }, observeChunk)
    expect([...listeners.keys()]).toEqual(['generation', 'edit'])
    listeners.get('edit')?.({
      type: 'generation.chunk',
      owner: { sessionId: 'sess-1' },
      payload: { type: 'run_completed', payload: { runId: 'run-edit', totalPages: 1 } }
    })
    expect(observeChunk).toHaveBeenCalledWith('sess-1', {
      type: 'run_completed',
      payload: { runId: 'run-edit', totalPages: 1 }
    })
  })
})
