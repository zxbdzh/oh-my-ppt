import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card'
import { ipc, type ExternalAgentSummary } from '../../lib/ipc'
import type { SettingsTranslate } from './types'

interface ExternalAgentSettingsTabProps {
  t: SettingsTranslate
}

function formatLocalTime(value?: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function ExternalAgentSettingsTab({ t }: ExternalAgentSettingsTabProps): React.JSX.Element {
  const [agents, setAgents] = useState<ExternalAgentSummary[]>([])
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [command, setCommand] = useState('')

  const load = async (active = true): Promise<void> => {
    const [nextAgents, bridge] = await Promise.all([
      ipc.listExternalAgents(),
      ipc.getExternalAgentBridgeCommand()
    ])
    if (!active) return
    setAgents(nextAgents)
    setCommand(bridge.command)
  }

  useEffect(() => {
    let active = true
    const loadAgents = async (): Promise<void> => {
      await load(active)
    }
    void loadAgents()
    const timer = window.setInterval(() => {
      void load(active)
    }, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const handleRevoke = async (agent: ExternalAgentSummary): Promise<void> => {
    if (!window.confirm(t('settings.externalAgentRevokeConfirm', { name: agent.name }))) return
    setRevokingId(agent.id)
    try {
      await ipc.revokeExternalAgent(agent.id)
      await load()
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader className="p-5 pb-3">
        <CardTitle className="text-base">{t('settings.externalAgentSection')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-5 pt-0">
        <p className="text-xs text-muted-foreground">{t('settings.externalAgentHint')}</p>
        {command ? (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t('settings.externalAgentCommandLabel')}
            </p>
            <code className="block break-all rounded-md border border-[#d8ccb5]/80 bg-[#fff9ef] px-3 py-2 text-xs">
              {command}
            </code>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('settings.externalAgentCommandHint')}
            </p>
          </div>
        ) : null}
        {agents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d8ccb5]/85 bg-[#fff9ef]/70 p-6 text-sm text-muted-foreground">
            {t('settings.externalAgentEmpty')}
          </div>
        ) : (
          agents.map((agent) => (
            <div
              key={agent.id}
              className="flex flex-col gap-3 rounded-lg border border-[#d8ccb5]/80 bg-[#fffdf8]/78 p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-[#33402a]">{agent.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {agent.executablePath || agent.id}
                </p>
                <p className="text-xs text-muted-foreground">
                  {agent.connected
                    ? t('settings.externalAgentConnected')
                    : t('settings.externalAgentRevoked')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('settings.externalAgentCapabilities')}: {agent.capabilities.join(', ') || '-'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('settings.externalAgentSessions')}: {agent.sessionIds.join(', ') || '-'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('settings.externalAgentWorkspaces')}: {agent.workspaceRoots.join(', ') || '-'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('settings.externalAgentCreatedAt')}: {formatLocalTime(agent.createdAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('settings.externalAgentLastUsed')}: {formatLocalTime(agent.lastUsedAt)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(agent.revokedAt) || revokingId === agent.id}
                onClick={() => void handleRevoke(agent)}
              >
                {t('settings.externalAgentRevoke')}
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
