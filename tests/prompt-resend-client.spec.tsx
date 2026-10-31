// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { PromptResendAction, type PromptResendActionProps, type PromptResendResponse } from '../src/client/PromptResendAction.tsx'
import { latestPromptId, withLatestPrompt, withPromptEditButton, installPromptEditPlacement } from '../src/client/prompt-edit-placement.tsx'
import type { NavigationViewProps } from '../src/client/turn-navigation.tsx'
import { zh } from '../src/client/locales.ts'
import { apply } from '../src/client/index.tsx'
import type { ClientContext } from '../src/client/context.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => createElement('button', props, children),
  Tooltip: ({ children }: { children: ReactNode }) => children,
  IconTrashOutlineRegular: () => null,
  Modal: ({ open, title, description, children, footer }: { open: boolean; title: string; description: string; children: ReactNode; footer: ReactNode }) =>
    open ? <div role="dialog"><h2>{title}</h2><p>{description}</p>{children}{footer}</div> : null,
}))
afterEach(() => { cleanup(); document.body.replaceChildren() })
const prompt = { messageId: MessageId('latest'), seq: 7, text: 'original', attachmentCount: 1 }
const t = (key: keyof typeof zh) => zh[key]
function fixture(overrides: Partial<PromptResendActionProps> = {}) {
  const mount = document.createElement('span')
  const host = document.createElement('div')
  const editorRoot = document.createElement('div')
  host.append(mount, editorRoot); document.body.append(host)
  const loadPrompt = vi.fn(async () => ({ ok: true as const, value: prompt }))
  const resendPrompt = vi.fn(async (): Promise<PromptResendResponse> => ({ ok: true, value: { ...prompt, submitted: true } }))
  const props: PromptResendActionProps = { messageId: 'latest', buttonTarget: { element: mount, buttonClass: 'copy-action', messageId: 'latest' },
    loadPrompt, resendPrompt, useSession: select => select({ running: false, subagent: null }), t, ...overrides }
  const result = render(<PromptResendAction {...props} />, { container: editorRoot })
  return { ...result, props, loadPrompt, resendPrompt }
}
async function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: '修改' }))
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveProperty('value', 'original'))
}

describe('prompt resend editor', () => {
  it('loads, preserves attachment notice, and submits edited text exactly once', async () => {
    const { resendPrompt } = fixture()
    await openEditor()
    expect(screen.getByText(zh['edit.attachments'])).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: '修改并重发' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(resendPrompt).toHaveBeenCalledExactlyOnceWith(prompt.messageId, 7, 'edited')
  })
  it('does not allow editing a different latest prompt or while running', async () => {
    const { rerender, props } = fixture({ messageId: 'old', buttonTarget: null })
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<PromptResendAction {...props} messageId="latest" buttonTarget={{ element: document.body, buttonClass: '', messageId: 'latest' }} useSession={select => select({ running: true, subagent: null })} />)
    expect(screen.getByRole('button', { name: '修改' })).toHaveProperty('disabled', true)
  })
  it('rejects a stale row after authoritative load', async () => {
    fixture({ loadPrompt: async () => ({ ok: true, value: { ...prompt, messageId: MessageId('new') } }) })
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(zh['edit.error.changed']))
    expect(screen.getByRole('button', { name: '修改并重发' })).toHaveProperty('disabled', true)
  })
  it('keeps draft and recovery errors after original bubble is removed, retries with recovered seq', async () => {
    let resolve!: (value: PromptResendResponse) => void
    const resendPrompt = vi.fn(() => new Promise<PromptResendResponse>(done => { resolve = done }))
    const { rerender, props } = fixture({ resendPrompt })
    await openEditor()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: '修改并重发' }))
    rerender(<PromptResendAction {...props} messageId={null} buttonTarget={null} />)
    resolve({ ok: false, error: { code: 'RESEND_FAILED', message: 'failed', recovery: { prompt: { ...prompt, seq: 9 }, phase: 'prepare', submitted: false, retryable: true } } })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'edited')
    expect(screen.getByRole('textbox')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '修改并重发' }))
    expect(resendPrompt).toHaveBeenLastCalledWith(prompt.messageId, 9, 'edited')
    resolve({ ok: true, value: { ...prompt, submitted: true } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('blocks repeat submission after transport failure', async () => {
    fixture({ resendPrompt: async () => { throw new Error('network') } })
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: '修改并重发' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(zh['edit.resend.uncertain']))
    expect(screen.getByRole('button', { name: '修改并重发' })).toHaveProperty('disabled', true)
  })
})

describe('latest prompt placement', () => {
  const nodes = new Map([
    ['a', { id: 'older', key: 'a', kind: 'user', location: { turn: { turn: 1 } } }],
    ['b', { id: 'latest', key: 'b', kind: 'user', location: { turn: { turn: 2 } } }],
    ['c', { id: 'answer', key: 'c', kind: 'assistant' }],
  ])
  const snapshot = { order: ['a', 'b', 'c'], nodes, timeline: { turns: new Map() } }
  const olderSnapshot = { ...snapshot, order: ['a'] }
  it('selects from the full chat order and excludes deleted turns', () => {
    expect(latestPromptId(snapshot)).toBe('latest')
    expect(latestPromptId({ ...snapshot, timeline: { turns: new Map([[2, { data: new Map([['turn-delete', { hidden: true }]]) }]]) } })).toBe('older')
    expect(latestPromptId({ order: [], nodes })).toBeNull()
  })
  it('inserts only before the latest copy control and follows new latest identity', () => {
    const copy = vi.fn()
    const User = withPromptEditButton(({ node }: NavigationViewProps) => <div className="hash_userRow" data-testid={(node as { id: string }).id}>
      <div>Prompt content <button aria-label="copy">attachment</button></div>
      <div className="hash_actions"><time>12:00</time><button className="hash_action" aria-label="copy" onClick={copy}>copy</button></div>
    </div>)
    const Chat = withLatestPrompt(() => <>{['a', 'b'].map(key => <User key={key} node={nodes.get(key)} t={(key: string) => key} />)}</>)
    const factory = (_name: string, props: Record<string, unknown>) => <PromptResendAction {...props as unknown as PromptResendActionProps}
      useSession={select => select({ running: false, subagent: null })} t={t}
      loadPrompt={async () => ({ ok: true, value: prompt })} resendPrompt={async () => ({ ok: true, value: { ...prompt, submitted: true } })} />
    const { rerender } = render(<Chat useChat={select => select(snapshot)} renderFactorySlot={factory} />)
    const newest = screen.getByTestId('latest')
    expect(within(screen.getByTestId('older')).queryByRole('button', { name: '修改' })).toBeNull()
    const button = within(newest).getByRole('button', { name: '修改' })
    expect(button.parentElement?.nextElementSibling?.getAttribute('aria-label')).toBe('copy')
    fireEvent.click(newest.querySelector('.hash_actions > button')!)
    expect(copy).toHaveBeenCalledOnce()
    rerender(<Chat useChat={select => select(olderSnapshot)} renderFactorySlot={factory} />)
    expect(within(newest).queryByRole('button', { name: '修改' })).toBeNull()
    expect(within(screen.getByTestId('older')).getByRole('button', { name: '修改' })).toBeTruthy()
  })
  it('restores both navigation and prompt wrappers when plugin effects dispose in forward order', () => {
    const original = () => null
    const view = { options: { id: 'chat' }, component: original }
    const user = { options: { key: 'user' }, component: original }
    const disposers: Array<() => void> = []
    const noop = () => {}
    const registerFactory = vi.fn(() => noop)
    apply({
      uiConversation: { events: { register: noop } },
      locale: { register: () => noop },
      effect: (setup: () => (() => void)) => { disposers.push(setup()) },
      slots: { registerFactory, register: () => noop, inject: (_name: string, setup: () => void) => setup(),
        entries: (name: string) => name === 'conversation.view' ? [view] : [user], subscribe: () => noop },
    } as unknown as ClientContext)
    expect(registerFactory).toHaveBeenCalledWith(expect.objectContaining({ name: 'conversation-controls.prompt-edit', scope: 'session' }), PromptResendAction)
    expect(view.component).not.toBe(original)
    expect(user.component).not.toBe(original)
    for (const dispose of disposers) dispose()
    expect(view.component).toBe(original)
    expect(user.component).toBe(original)
  })
  it('restores components and unsubscribes the adapter', () => {
    const original = () => null
    const view = { options: { id: 'chat' }, component: original }
    const user = { options: { key: 'user' }, component: original }
    const dispose = vi.fn()
    const cleanupAdapter = installPromptEditPlacement({ entries: name => name === 'conversation.view' ? [view] : [user], subscribe: () => dispose })
    expect(view.component).not.toBe(original)
    expect(user.component).not.toBe(original)
    cleanupAdapter()
    expect(view.component).toBe(original)
    expect(user.component).toBe(original)
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
