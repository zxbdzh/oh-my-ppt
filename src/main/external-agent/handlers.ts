import { BrowserWindow, app, ipcMain } from 'electron'
import type { ExternalAgentCapability } from '@shared/external-agent'
import { EXTERNAL_AGENT_DEFAULT_CAPABILITIES } from '@shared/external-agent'
import type { ExternalAgentAuthorizationService } from './authorization'
import type { ExternalAgentAuthPromptInput } from './broker'
import { startExternalAgentHost, type ExternalAgentHost } from './host'
import type { ExternalAgentBroker } from './broker'
import type { ExternalAgentOperationService } from './operations'
import type { ExternalAgentRuntimeExecutor } from './runtime-executor'

export interface ExternalAgentSummary {
  id: string
  name: string
  version: string
  executablePath?: string
  capabilities: ExternalAgentCapability[]
  sessionIds: string[]
  workspaceRoots: string[]
  createdAt: string
  lastUsedAt?: string | null
  revokedAt?: string | null
  connected: boolean
}

type PendingAuthDecision = {
  approved: boolean
  capabilities?: ExternalAgentCapability[]
  sessionIds?: string[]
  workspaceRoots?: string[]
}

const pendingAuth = new Map<
  string,
  {
    payload: {
      agentId: string
      name: string
      version: string
      executablePath?: string
      defaultCapabilities: ExternalAgentCapability[]
    }
    resolve: (value: PendingAuthDecision) => void
  }
>()

function authPayload(input: ExternalAgentAuthPromptInput): {
  agentId: string
  name: string
  version: string
  executablePath?: string
  defaultCapabilities: ExternalAgentCapability[]
} {
  return {
    ...input,
    defaultCapabilities: [...EXTERNAL_AGENT_DEFAULT_CAPABILITIES]
  }
}

export function createRendererAuthPrompt(
  getWindow: () => BrowserWindow | null
): (input: ExternalAgentAuthPromptInput) => Promise<PendingAuthDecision> {
  return (input) =>
    new Promise((resolve) => {
      const payload = authPayload(input)
      pendingAuth.set(input.agentId, { payload, resolve })
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      window.show()
      window.focus()
      window.webContents.send('external-agent:auth-request', payload)
    })
}

export async function startBrokerHost(broker: ExternalAgentBroker): Promise<ExternalAgentHost> {
  return startExternalAgentHost({ broker })
}

export function registerExternalAgentHandlers(args: {
  auth: ExternalAgentAuthorizationService
  operations: ExternalAgentOperationService
  executor: ExternalAgentRuntimeExecutor
  listSessions: () => Promise<Array<{ id: string; title: string }>>
  getStoragePath: () => Promise<string>
}): void {
  ipcMain.handle('external-agent:bridge-command', async () => {
    const exe = app.getPath('exe')
    const quoted = exe.includes(' ') ? `"${exe}"` : exe
    return { command: `${quoted} --mcp` }
  })

  ipcMain.handle('external-agent:auth-options', async () => {
    const [sessions, storagePath] = await Promise.all([args.listSessions(), args.getStoragePath()])
    return {
      sessions,
      defaultWorkspaceRoot: storagePath || ''
    }
  })

  ipcMain.handle('external-agent:pending-auth', async () => {
    const first = pendingAuth.values().next().value
    return first?.payload ?? null
  })

  ipcMain.handle('external-agent:list', async () => {
    const [agents, grants] = await Promise.all([args.auth.listAgents(), args.auth.listGrants()])
    const grantByAgent = new Map(grants.map((grant) => [grant.agentId, grant]))
    return agents.map((agent): ExternalAgentSummary => {
      const grant = grantByAgent.get(agent.id)
      return {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        executablePath: agent.executablePath,
        capabilities: grant?.capabilities ?? [],
        sessionIds: grant?.sessionIds ?? [],
        workspaceRoots: grant?.workspaceRoots ?? [],
        createdAt: agent.createdAt,
        lastUsedAt: agent.lastUsedAt ?? grant?.lastUsedAt,
        revokedAt: agent.revokedAt ?? grant?.revokedAt,
        connected: !agent.revokedAt && !grant?.revokedAt
      }
    })
  })

  ipcMain.handle('external-agent:revoke', async (_event, agentId: string) => {
    if (!agentId) return { success: false }
    const sessionIds = await args.operations.revokeAgentOperations(agentId)
    for (const sessionId of sessionIds) {
      await args.executor.cancelProduct(sessionId)
    }
    await args.auth.revokeAccess(agentId)
    return { success: true }
  })

  ipcMain.handle(
    'external-agent:auth-respond',
    async (
      _event,
      payload: {
        agentId: string
        approved: boolean
        capabilities?: ExternalAgentCapability[]
        sessionIds?: string[]
        workspaceRoots?: string[]
      }
    ) => {
      const pending = pendingAuth.get(payload.agentId)
      if (!pending) return { success: false }
      pendingAuth.delete(payload.agentId)
      pending.resolve({
        approved: payload.approved,
        capabilities: payload.capabilities,
        sessionIds: payload.sessionIds,
        workspaceRoots: payload.workspaceRoots
      })
      return { success: true }
    }
  )
}
