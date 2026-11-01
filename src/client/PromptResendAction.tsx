import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
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
/**
 * Where the latest user row lets this factory render: `element` sits right
 * before the row's Copy control (the Edit button), `editorElement` is an empty
 * sibling of the row that replaces it while the prompt is edited in place.
 */
export interface PromptButtonTarget { element: HTMLElement; editorElement: HTMLElement | null; buttonClass: string; messageId: string }
export interface PromptResendActionProps {
  readonly messageId: string | null
  readonly buttonTarget: PromptButtonTarget | null
  /** Tells the chat which row is being edited in place, so it hides that bubble. */
  readonly onEditingChange?: (messageId: string | null) => void
  readonly loadPrompt: () => Promise<PromptEditResponse>
  readonly resendPrompt: (messageId: MessageId, seq: number, text: string) => Promise<PromptResendResponse>
  readonly useSession: <T>(select: (snapshot: { running: boolean; subagent: unknown }) => T) => T
  readonly t: (key: PromptEditKey) => string
}

const editorStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, boxSizing: 'border-box', width: '100%', padding: '10px 12px',
  borderRadius: 'var(--dsw-radius-xl, 16px)', background: 'var(--dsw-specific-bubble, var(--dsw-alias-surface-primary))',
  border: '1px solid var(--dsw-alias-border-primary, transparent)',
}
const fieldStyle: CSSProperties = {
  display: 'block', boxSizing: 'border-box', width: '100%', minHeight: 44, maxHeight: '50vh', margin: 0, padding: 0,
  resize: 'none', overflowY: 'auto', border: 'none', outline: 'none', background: 'transparent',
  color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 'var(--dsh-content-font-size, 14px)',
  lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
}
const footerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }
const noteStyle: CSSProperties = { marginRight: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }
const errorStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: 1.5 }
const modalFieldStyle: CSSProperties = {
  width: '100%', minHeight: 160, boxSizing: 'border-box', resize: 'vertical', padding: 8, borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-primary)', background: 'var(--dsw-alias-surface-primary)', color: 'var(--dsw-alias-label-primary)', font: 'inherit',
}

export function PromptResendAction({ messageId, buttonTarget, onEditingChange, loadPrompt, resendPrompt, useSession, t }: PromptResendActionProps) {
  const running = useSession(s => s.running)
  const subagent = useSession(s => s.subagent)
  /** Row being edited; null while the editor is closed. */
  const [editing, setEditing] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [prompt, setPrompt] = useState<PromptSnapshot | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retryBlocked, setRetryBlocked] = useState(false)
  const [prepared, setPrepared] = useState(false)
  const alive = useRef(true)
  const request = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = async () => {
    if (running || request.current || messageId === null) return
    request.current = true
    setPending(true); setError(null); setPrompt(null); setText(''); setRetryBlocked(false); setPrepared(false)
    try {
      const result = await loadPrompt()
      if (!alive.current) return
      if (!result.ok) { setRetryBlocked(true); setError(t(result.error.code === 'AGENT_BUSY' ? 'edit.error.busy' : 'edit.error.load')) }
      else if (result.value.messageId !== messageId) { setRetryBlocked(true); setError(t('edit.error.changed')) }
      else { setPrompt(result.value); setText(result.value.text) }
    } catch { if (alive.current) { setRetryBlocked(true); setError(t('edit.error.unknown')) } }
    finally {
      request.current = false
      // Open only once loaded, so the original bubble never flashes an empty field.
      if (alive.current) { setPending(false); setEditing(messageId) }
    }
  }
  const resend = async () => {
    if (running || request.current || prompt === null || retryBlocked || text.trim() === '') return
    request.current = true; setPending(true); setError(null)
    try {
      const result = await resendPrompt(prompt.messageId, prompt.seq, text)
      if (!alive.current) return
      if (result.ok) { setEditing(null); return }
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
  const cancel = () => { if (!request.current) { setEditing(null); setError(null) } }

  // Edit in place only on the exact row that was opened. If that row goes away
  // mid-request (the old turn is hidden during resend), keep the draft and the
  // recovery state in a dialog instead of losing them.
  const inline = editing !== null && buttonTarget?.messageId === editing && buttonTarget.editorElement?.isConnected === true
    ? buttonTarget.editorElement : null
  const inlineId = inline === null ? null : editing
  useEffect(() => { onEditingChange?.(inlineId) }, [inlineId, onEditingChange])
  useEffect(() => () => { onEditingChange?.(null) }, [onEditingChange])
  useLayoutEffect(() => {
    const element = field.current
    if (element === null || inline === null) return
    element.style.height = 'auto'
    element.style.height = `${String(element.scrollHeight)}px`
  }, [text, inline])
  useEffect(() => {
    const element = field.current
    if (inline === null || element === null) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [inline])

  if (subagent !== null) return null
  const canSend = !running && !pending && prompt !== null && !retryBlocked && text.trim() !== ''
  const fieldDisabled = pending || prepared || retryBlocked || prompt === null
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); cancel() }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void resend() }
  }
  const sendLabel = pending ? t('edit.resend.pending') : t('edit.resend.submit')
  const notes: ReactNode = error !== null
    ? <p role="alert" style={{ ...errorStyle, marginRight: 'auto' }}>{error}</p>
    : <span style={noteStyle}>
      {t('edit.resend.inlineNotice')}{prompt !== null && prompt.attachmentCount > 0 ? ` ${t('edit.attachments')}` : ''}
    </span>
  const target = buttonTarget?.messageId === messageId && buttonTarget.element.isConnected ? buttonTarget : null
  return <>
    {target !== null && createPortal(<Tooltip label={running ? t('edit.action.busy') : t('edit.resend.action')} side="bottom">
      <button type="button" className={target.buttonClass} aria-label={t('edit.resend.action')} disabled={running || pending || editing !== null}
        onClick={() => { void load() }} style={{ opacity: running || pending ? 0.45 : undefined }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-5-5L4 14z" />
        </svg>
      </button>
    </Tooltip>, target.element)}
    {inline !== null && createPortal(<div role="group" aria-label={t('edit.resend.title')} data-prompt-editor="" style={editorStyle}>
      <textarea ref={field} aria-label={t('edit.field')} value={text} rows={1} disabled={fieldDisabled}
        onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} style={fieldStyle} />
      <div style={footerStyle}>
        {notes}
        <Button variant="outline" size="sm" disabled={pending} onClick={cancel}>{t('edit.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={!canSend} onClick={() => { void resend() }}>{sendLabel}</Button>
      </div>
    </div>, inline)}
    <Modal open={editing !== null && inline === null && !pending} onClose={cancel} closeLabel={t('edit.cancel')} title={t('edit.resend.title')} description={t('edit.resend.description')}
      footer={<>
        <Button disabled={pending} onClick={cancel}>{t('edit.cancel')}</Button>
        <Button disabled={!canSend} onClick={() => { void resend() }}>{sendLabel}</Button>
      </>}>
      <textarea aria-label={t('edit.field')} value={text} onChange={event => setText(event.target.value)} disabled={fieldDisabled} style={modalFieldStyle} />
      {prompt !== null && prompt.attachmentCount > 0 && <p>{t('edit.attachments')}</p>}
      {error !== null && <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}
    </Modal>
  </>
}
