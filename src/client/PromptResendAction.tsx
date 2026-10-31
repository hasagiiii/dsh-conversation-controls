import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { PromptEditResponse, PromptSnapshot } from './PromptEditAction.tsx'
import type { PromptEditKey } from './locales.ts'

export type PromptResendResponse =
  | { ok: true; value: PromptSnapshot & { submitted: true } }
  | { ok: false; error: { code: string; message: string; recovery?: {
    prompt: PromptSnapshot; phase: 'save' | 'prepare' | 'submit' | 'persist'; submitted: boolean | 'unknown'; retryable: boolean
  } } }
export interface PromptButtonTarget { element: HTMLElement; buttonClass: string; messageId: string }
export interface PromptResendActionProps {
  readonly messageId: string | null
  readonly buttonTarget: PromptButtonTarget | null
  readonly loadPrompt: () => Promise<PromptEditResponse>
  readonly resendPrompt: (messageId: MessageId, seq: number, text: string) => Promise<PromptResendResponse>
  readonly useSession: <T>(select: (snapshot: { running: boolean; subagent: unknown }) => T) => T
  readonly t: (key: PromptEditKey) => string
}
export function PromptResendAction({ messageId, buttonTarget, loadPrompt, resendPrompt, useSession, t }: PromptResendActionProps) {
  const running = useSession(s => s.running)
  const subagent = useSession(s => s.subagent)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [prompt, setPrompt] = useState<PromptSnapshot | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retryBlocked, setRetryBlocked] = useState(false)
  const [prepared, setPrepared] = useState(false)
  const alive = useRef(true)
  const request = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = async () => {
    if (running || request.current || messageId === null) return
    request.current = true
    setOpen(true); setPending(true); setError(null); setPrompt(null); setText(''); setRetryBlocked(false); setPrepared(false)
    try {
      const result = await loadPrompt()
      if (!alive.current) return
      if (!result.ok) setError(t(result.error.code === 'AGENT_BUSY' ? 'edit.error.busy' : 'edit.error.load'))
      else if (result.value.messageId !== messageId) setError(t('edit.error.changed'))
      else { setPrompt(result.value); setText(result.value.text) }
    } catch { if (alive.current) setError(t('edit.error.unknown')) }
    finally { request.current = false; if (alive.current) setPending(false) }
  }
  const resend = async () => {
    if (running || request.current || prompt === null || retryBlocked || text.trim() === '') return
    request.current = true; setPending(true); setError(null)
    try {
      const result = await resendPrompt(prompt.messageId, prompt.seq, text)
      if (!alive.current) return
      if (result.ok) { setOpen(false); return }
      const recovery = result.error.recovery
      if (recovery !== undefined) {
        setPrompt(recovery.prompt)
        setPrepared(recovery.phase !== 'save')
        setRetryBlocked(!recovery.retryable || recovery.submitted !== false)
        setError(t(recovery.submitted === false && recovery.retryable ? 'edit.resend.retry' : 'edit.resend.uncertain'))
      } else {
        const code = result.error.code
        setRetryBlocked(code === 'PROMPT_CHANGED' || code === 'TARGET_NOT_FOUND' || code === 'PROMPT_UNSUPPORTED')
        setError(t(code === 'AGENT_BUSY' ? 'edit.error.busy' : code === 'PROMPT_CHANGED' ? 'edit.error.changed' : code === 'PROMPT_UNSUPPORTED' || code === 'TARGET_NOT_FOUND' ? 'edit.error.unavailable' : 'edit.error.unknown'))
      }
    } catch {
      if (alive.current) { setRetryBlocked(true); setError(t('edit.resend.uncertain')) }
    } finally { request.current = false; if (alive.current) setPending(false) }
  }
  if (subagent !== null) return null
  const close = () => { if (!request.current) setOpen(false) }
  const target = buttonTarget?.messageId === messageId && buttonTarget.element.isConnected ? buttonTarget : null
  return <>
    {target !== null && createPortal(<Tooltip label={running ? t('edit.action.busy') : t('edit.resend.action')} side="bottom">
      <button type="button" className={target.buttonClass} aria-label={t('edit.resend.action')} disabled={running || pending}
        onClick={() => { void load() }} style={{ opacity: running || pending ? 0.45 : undefined }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-5-5L4 14z" />
        </svg>
      </button>
    </Tooltip>, target.element)}
    <Modal open={open} onClose={close} closeLabel={t('edit.cancel')} title={t('edit.resend.title')} description={t('edit.resend.description')}
      footer={<>
        <Button disabled={pending} onClick={close}>{t('edit.cancel')}</Button>
        <Button disabled={running || pending || prompt === null || retryBlocked || text.trim() === ''}
          onClick={() => { void resend() }}>{pending ? t('edit.resend.pending') : t('edit.resend.submit')}</Button>
      </>}>
      <textarea aria-label={t('edit.field')} value={text} onChange={event => setText(event.target.value)}
        disabled={pending || prepared || retryBlocked || prompt === null} autoFocus
        style={{ width: '100%', minHeight: 160, boxSizing: 'border-box', resize: 'vertical', padding: 8, borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-primary)', background: 'var(--dsw-alias-surface-primary)', color: 'var(--dsw-alias-label-primary)', font: 'inherit' }} />
      {prompt !== null && prompt.attachmentCount > 0 && <p>{t('edit.attachments')}</p>}
      {error !== null && <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}
    </Modal>
  </>
}
