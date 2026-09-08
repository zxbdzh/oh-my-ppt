import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/Dialog'
import { Button } from './ui/Button'
import { ipc, type ExternalAgentAuthRequest } from '../lib/ipc'
import { useLang } from '../i18n'
import {
  EXTERNAL_AGENT_DEFAULT_CAPABILITIES,
  type ExternalAgentCapability
} from '@shared/external-agent'

export function ExternalAgentAuthDialog(): React.JSX.Element {
  const { t } = useLang()
  const [request, setRequest] = useState<ExternalAgentAuthRequest | null>(null)
  const [capabilities, setCapabilities] = useState<ExternalAgentCapability[]>([])

  useEffect(() => {
    const apply = (next: ExternalAgentAuthRequest): void => {
      setRequest(next)
      setCapabilities(
        next.defaultCapabilities.length > 0
          ? next.defaultCapabilities
          : [...EXTERNAL_AGENT_DEFAULT_CAPABILITIES]
      )
    }
    void ipc.getPendingExternalAgentAuth().then((pending) => {
      if (pending) apply(pending)
    })
    return ipc.onExternalAgentAuthRequest(apply)
  }, [])

  const respond = async (approved: boolean): Promise<void> => {
    if (!request) return
    await ipc.respondExternalAgentAuth({
      agentId: request.agentId,
      approved,
      capabilities: approved ? capabilities : undefined
    })
    setRequest(null)
  }

  const toggle = (capability: ExternalAgentCapability): void => {
    setCapabilities((current) =>
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability]
    )
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && void respond(false)}>
      <DialogContent showClose={false} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.externalAgentAuthTitle')}</DialogTitle>
          <DialogDescription>{t('settings.externalAgentAuthDescription')}</DialogDescription>
        </DialogHeader>
        {request && (
          <div className="space-y-3 text-sm">
            <p>
              {t('settings.externalAgentAuthName')}: {request.name} ({request.version})
            </p>
            <p className="break-all">
              {t('settings.externalAgentAuthPath')}: {request.executablePath || '-'}
            </p>
            <div className="space-y-2">
              <p>{t('settings.externalAgentCapabilities')}</p>
              {(request.defaultCapabilities.length > 0
                ? request.defaultCapabilities
                : [...EXTERNAL_AGENT_DEFAULT_CAPABILITIES]
              ).map((capability) => (
                <label key={capability} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={capabilities.includes(capability)}
                    onChange={() => toggle(capability)}
                  />
                  <span>{capability}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => void respond(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void respond(true)}>{t('settings.externalAgentApprove')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
