import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { PromptEditKey } from './locales.ts'

export interface PromptSnapshot {
  readonly messageId: MessageId
  readonly seq: number
  readonly text: string
  readonly attachmentCount: number
}

export type PromptEditResponse =
  | { ok: true; value: PromptSnapshot }
  | { ok: false; error: { code: string; message: string } }

export interface PromptEditActionProps {
  readonly loadPrompt: () => Promise<PromptEditResponse>
  readonly savePrompt: (messageId: MessageId, expectedSeq: number, text: string) => Promise<PromptEditResponse>
  readonly useSession: <T>(select: (snapshot: { running: boolean; subagent: unknown }) => T) => T
  readonly t: (key: PromptEditKey) => string
}

const actionStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 28,
  padding: '4px 8px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
}

const fieldStyle: CSSProperties = {
  display: 'block',
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 120,
  resize: 'vertical',
  padding: 8,
  border: '1px solid var(--dsw-alias-border-primary)',
  borderRadius: 6,
  background: 'var(--dsw-alias-surface-primary)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  lineHeight: 1.5,
}

const noticeStyle: CSSProperties = {
  marginTop: 8,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: 1.5,
}

const errorStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 13,
  lineHeight: 1.5,
}

export function PromptEditAction({ loadPrompt, savePrompt, useSession, t }: PromptEditActionProps) {
  const running = useSession(snapshot => snapshot.running)
  const subagent = useSession(snapshot => snapshot.subagent)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<PromptSnapshot | null>(null)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  if (subagent !== null) return null
  const unavailable = running || pending
  const load = (): void => {
    if (unavailable) return
    setOpen(true)
    setPending(true)
    setPrompt(null)
    setText('')
    setError(null)
    setSaved(false)
    void loadPrompt().then(result => {
      if (!alive.current) return
      setPending(false)
      if (result.ok) {
        setPrompt(result.value)
        setText(result.value.text)
        return
      }
      setError(result.error.code === 'AGENT_BUSY' ? t('edit.error.busy') : t('edit.error.load'))
    }).catch(() => {
      if (!alive.current) return
      setPending(false)
      setError(t('edit.error.unknown'))
    })
  }
  const close = (): void => {
    if (pending) return
    setOpen(false)
    setError(null)
  }
  const save = (): void => {
    if (unavailable || prompt === null) return
    setPending(true)
    setError(null)
    setSaved(false)
    void savePrompt(prompt.messageId, prompt.seq, text).then(result => {
      if (!alive.current) return
      setPending(false)
      if (result.ok) {
        setPrompt(result.value)
        setText(result.value.text)
        setSaved(true)
        return
      }
      if (result.error.code === 'AGENT_BUSY') setError(t('edit.error.busy'))
      else if (result.error.code === 'PROMPT_CHANGED') setError(t('edit.error.changed'))
      else if (result.error.code === 'TARGET_NOT_FOUND' || result.error.code === 'PROMPT_UNSUPPORTED') setError(t('edit.error.unavailable'))
      else setError(t('edit.error.save'))
    }).catch(() => {
      if (!alive.current) return
      setPending(false)
      setError(t('edit.error.unknown'))
    })
  }

  const label = running ? t('edit.action.busy') : t('edit.action')
  return (
    <>
      <Tooltip label={label} side="bottom">
        <button
          type="button"
          style={{ ...actionStyle, opacity: running ? 0.45 : 1, cursor: unavailable ? 'default' : 'pointer' }}
          aria-label={t('edit.action')}
          aria-disabled={unavailable || undefined}
          onClick={unavailable ? undefined : load}
        >
          {t('edit.action')}
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={close}
        closeLabel={t('edit.cancel')}
        title={t('edit.title')}
        description={t('edit.description')}
        footer={(
          <>
            <Button variant="outline" disabled={pending} onClick={close}>{t('edit.cancel')}</Button>
            <Button variant="outline" disabled={pending || running || prompt === null} onClick={save}>
              {pending ? t('edit.saving') : t('edit.save')}
            </Button>
          </>
        )}
      >
        <textarea aria-label={t('edit.field')} value={text} disabled={pending} onChange={event => { setText(event.target.value); setSaved(false) }} style={fieldStyle} />
        <div style={noticeStyle}>{t('edit.notice')}</div>
        {saved && <div style={noticeStyle} role="status">{t('edit.saved')}</div>}
        {error !== null && <div style={errorStyle} role="alert">{error}</div>}
      </Modal>
    </>
  )
}
