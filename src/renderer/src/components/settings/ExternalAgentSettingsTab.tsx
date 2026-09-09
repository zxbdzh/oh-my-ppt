import { useEffect, useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '../ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card'
import { useToastStore } from '../../store'
import { ipc, type ExternalAgentBridgeConfig, type ExternalAgentSummary } from '../../lib/ipc'
import type { ExternalAgentCapability } from '@shared/external-agent'
import type { I18nKey } from '../../i18n'
import type { SettingsTranslate } from './types'

interface ExternalAgentSettingsTabProps {
  t: SettingsTranslate
}

const CAPABILITY_LABEL_KEYS = {
  read: 'settings.externalAgentCapRead',
  create_session: 'settings.externalAgentCapCreateSession',
  generation: 'settings.externalAgentCapGeneration',
  page_edit: 'settings.externalAgentCapPageEdit',
  deck_edit: 'settings.externalAgentCapDeckEdit',
  import_pptx: 'settings.externalAgentCapImportPptx',
  import_assets: 'settings.externalAgentCapImportAssets',
  export_pptx: 'settings.externalAgentCapExportPptx',
  task_control: 'settings.externalAgentCapTaskControl',
  delete_page: 'settings.externalAgentCapDeletePage',
  delete_session: 'settings.externalAgentCapDeleteSession'
} as const satisfies Record<ExternalAgentCapability, I18nKey>

const SESSION_PREVIEW = 4

function formatRelativeTime(value: string | null | undefined, t: SettingsTranslate): string {
  if (!value) return t('settings.externalAgentNever')
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return value
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000))
  if (minutes < 1) return t('settings.externalAgentJustNow')
  if (minutes < 60) return t('settings.externalAgentMinutesAgo', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('settings.externalAgentHoursAgo', { count: hours })
  const days = Math.round(hours / 24)
  if (days < 7) return t('settings.externalAgentDaysAgo', { count: days })
  return new Date(value).toLocaleString()
}

function sortAgents(agents: ExternalAgentSummary[]): ExternalAgentSummary[] {
  return [...agents].sort((left, right) => {
    if (left.connected !== right.connected) return left.connected ? -1 : 1
    return (
      Date.parse(right.lastUsedAt || right.createdAt) -
      Date.parse(left.lastUsedAt || left.createdAt)
    )
  })
}

export function ExternalAgentSettingsTab({ t }: ExternalAgentSettingsTabProps): React.JSX.Element {
  const { success, error } = useToastStore()
  const [agents, setAgents] = useState<ExternalAgentSummary[]>([])
  const [bridge, setBridge] = useState<ExternalAgentBridgeConfig | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const mcpJson = useMemo(() => {
    if (!bridge) return ''
    return JSON.stringify(
      {
        mcpServers: {
          'oh-my-ppt': {
            command: bridge.executable,
            args: bridge.args
          }
        }
      },
      null,
      2
    )
  }, [bridge])

  const load = async (active = true): Promise<void> => {
    const [nextAgents, nextBridge] = await Promise.all([
      ipc.listExternalAgents(),
      ipc.getExternalAgentBridgeCommand()
    ])
    if (!active) return
    setAgents(sortAgents(nextAgents))
    setBridge(nextBridge)
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

  const handleCopy = async (): Promise<void> => {
    if (!mcpJson) return
    try {
      await navigator.clipboard.writeText(mcpJson)
      setCopied(true)
      success(t('settings.externalAgentCopied'))
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      error(t('settings.externalAgentCopyFailed'))
    }
  }

  const handleRevoke = async (agent: ExternalAgentSummary): Promise<void> => {
    if (!window.confirm(t('settings.externalAgentRevokeConfirm', { name: agent.id }))) return
    setRevokingId(agent.id)
    try {
      await ipc.revokeExternalAgent(agent.id)
      await load()
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="p-5 pb-3">
          <CardTitle className="text-base">{t('settings.externalAgentSection')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 p-5 pt-0">
          <div className="flex items-center gap-2 text-xs text-[#4a5a3d]">
            <span className="h-2 w-2 rounded-full bg-[#6f8159]" />
            {t('settings.externalAgentRunning')}
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.externalAgentHint')}</p>
          <ol className="grid gap-2 sm:grid-cols-3">
            {[
              t('settings.externalAgentStep1'),
              t('settings.externalAgentStep2'),
              t('settings.externalAgentStep3')
            ].map((label, index) => (
              <li
                key={label}
                className="flex items-start gap-2 rounded-lg border border-[#d8ccb5]/80 bg-[#fff9ef]/80 px-3 py-2"
              >
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#6f8159] text-[11px] font-medium text-white">
                  {index + 1}
                </span>
                <span className="text-xs leading-5 text-[#33402a]">{label}</span>
              </li>
            ))}
          </ol>
          {mcpJson ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('settings.externalAgentConfigLabel')}
                </p>
                <Button size="sm" variant="outline" onClick={() => void handleCopy()}>
                  {copied ? (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {copied
                    ? t('settings.externalAgentCopied')
                    : t('settings.externalAgentCopyConfig')}
                </Button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-[#d8ccb5]/80 bg-[#fff9ef] px-3 py-2 font-mono text-xs leading-5 text-[#33402a]">
                {mcpJson}
              </pre>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {bridge?.packaged
                  ? t('settings.externalAgentCommandHint')
                  : t('settings.externalAgentCommandHintDev')}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-5 pb-3">
          <CardTitle className="text-base">{t('settings.externalAgentAuthorizedTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-5 pt-0">
          {agents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#d8ccb5]/85 bg-[#fff9ef]/70 p-6 text-sm text-muted-foreground">
              {t('settings.externalAgentEmpty')}
            </div>
          ) : (
            agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                revoking={revokingId === agent.id}
                t={t}
                onRevoke={() => void handleRevoke(agent)}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AgentCard({
  agent,
  revoking,
  t,
  onRevoke
}: {
  agent: ExternalAgentSummary
  revoking: boolean
  t: SettingsTranslate
  onRevoke: () => void
}): React.JSX.Element {
  const sessions = agent.sessions ?? agent.sessionIds.map((id) => ({ id, title: id }))
  const visibleSessions = sessions.slice(0, SESSION_PREVIEW)
  const hiddenSessionCount = Math.max(0, sessions.length - visibleSessions.length)

  return (
    <div
      className={`rounded-lg border border-[#d8ccb5]/80 bg-[#fffdf8]/78 p-3 ${
        agent.connected ? '' : 'opacity-70'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-[#33402a]">{agent.id}</p>
          <p className="truncate text-xs text-muted-foreground">
            {[agent.name !== agent.id ? agent.name : null, agent.version, agent.executablePath]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              agent.connected ? 'bg-[#e7f0dc] text-[#4a5a3d]' : 'bg-[#eee8dc] text-muted-foreground'
            }`}
          >
            {agent.connected
              ? t('settings.externalAgentConnected')
              : t('settings.externalAgentRevoked')}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!agent.connected || revoking}
            onClick={onRevoke}
          >
            {t('settings.externalAgentRevoke')}
          </Button>
        </div>
      </div>
      {agent.capabilities.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {agent.capabilities.map((capability) => (
            <span
              key={capability}
              className="rounded-full border border-[#d8ccb5]/80 bg-[#fff9ef] px-2 py-0.5 text-[11px] text-[#4a5a3d]"
            >
              {t(CAPABILITY_LABEL_KEYS[capability])}
            </span>
          ))}
        </div>
      ) : null}
      <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline text-[#6b735f]">{t('settings.externalAgentSessions')}: </dt>
          <dd className="inline">
            {visibleSessions.length > 0
              ? [
                  ...visibleSessions.map((session) => session.title),
                  hiddenSessionCount > 0
                    ? t('settings.externalAgentMoreSessions', { count: hiddenSessionCount })
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ')
              : t('settings.externalAgentNoSessions')}
          </dd>
        </div>
        <div>
          <dt className="inline text-[#6b735f]">{t('settings.externalAgentWorkspaces')}: </dt>
          <dd className="inline break-all">
            {agent.workspaceRoots.join(' · ') || t('settings.externalAgentNoWorkspace')}
          </dd>
        </div>
        <div>
          <dt className="inline text-[#6b735f]">{t('settings.externalAgentLastUsed')}: </dt>
          <dd className="inline">{formatRelativeTime(agent.lastUsedAt, t)}</dd>
        </div>
      </dl>
    </div>
  )
}
