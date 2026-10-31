import { createContext, createElement, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type Dispatch, type SetStateAction } from 'react'
import type { PromptButtonTarget } from './PromptResendAction.tsx'
import type { NavigationSlots, NavigationViewProps } from './turn-navigation.tsx'

export const PROMPT_EDIT_FACTORY = 'conversation-controls.prompt-edit'
interface UserNode {
  readonly id: string
  readonly key: string
  readonly kind: string
  readonly visibility?: string
  readonly location?: { turn?: { turn: number } }
}
interface PromptChatSnapshot {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): UserNode | undefined }
  readonly timeline?: { turns: ReadonlyMap<number, { data: { get(key: string): unknown } }> }
}
const LatestPrompt = createContext<{ latest: string | null; setTarget: Dispatch<SetStateAction<PromptButtonTarget | null>> } | null>(null)

/** Read inside the selector: the host's node store is mutable. */
export function latestPromptId(snapshot: PromptChatSnapshot): string | null {
  for (let index = snapshot.order.length - 1; index >= 0; index--) {
    const node = snapshot.nodes.get(snapshot.order[index]!)
    if (node?.kind !== 'user' || node.visibility === 'hidden') continue
    const turn = node.location?.turn?.turn
    const deletion = turn === undefined ? undefined : snapshot.timeline?.turns.get(turn)?.data.get('turn-delete') as { hidden?: boolean } | undefined
    if (!deletion?.hidden) return node.id
  }
  return null
}

export function withLatestPrompt(Component: ComponentType<NavigationViewProps>) {
  function Provider(props: NavigationViewProps) {
    const useChat = props.useChat as <T>(select: (snapshot: PromptChatSnapshot) => T) => T
    const latest = useChat(latestPromptId)
    const [target, setTarget] = useState<PromptButtonTarget | null>(null)
    const value = useMemo(() => ({ latest, setTarget }), [latest])
    const renderFactory = props.renderFactorySlot as ((name: string, props: Record<string, unknown>) => ReactNode) | undefined
    return <LatestPrompt.Provider value={value}>
      {createElement(Component, props)}
      {renderFactory?.(PROMPT_EDIT_FACTORY, { messageId: latest, buttonTarget: target })}
    </LatestPrompt.Provider>
  }
  return function PromptView(props: NavigationViewProps) {
    return props.useChat === undefined ? createElement(Component, props) : <Provider {...props} />
  }
}

export function withPromptEditButton(Component: ComponentType<NavigationViewProps>) {
  return function PromptRow(props: NavigationViewProps) {
    const context = useContext(LatestPrompt)
    const node = props.node as UserNode | undefined
    const t = props.t as ((key: string) => string) | undefined
    const copyLabel = t?.('copy')
    const copiedLabel = t?.('copied')
    const root = useRef<HTMLDivElement>(null)
    const setTarget = context?.setTarget
    const active = context !== null && node?.id === context.latest && context.latest !== null
    useLayoutEffect(() => {
      if (!active || root.current === null || copyLabel === undefined || copiedLabel === undefined) return
      // Match the copy control itself, scoped to this exact user row. Never
      // select an attachment's copy control or move any React-owned host node.
      const actions = root.current.querySelector('[class$="_userRow"] > [class*="_actions"]')
      const copy = actions === null ? undefined : [...actions.querySelectorAll('button')].find(button =>
        button.getAttribute('aria-label') === copyLabel || button.getAttribute('aria-label') === copiedLabel)
      if (copy?.parentElement === null || copy === undefined) return
      const element = document.createElement('span')
      element.dataset.promptEditMount = ''
      element.style.display = 'inline-flex'
      copy.parentElement.insertBefore(element, copy)
      setTarget?.({ element, buttonClass: copy.className, messageId: node!.id })
      return () => {
        element.remove()
        setTarget?.(current => current?.element === element ? null : current)
      }
    }, [active, node?.id, copyLabel, copiedLabel, setTarget])
    return <div ref={root} style={{ display: 'contents' }}>{createElement(Component, props)}</div>
  }
}

/** Reversible adapter for DSH 0.2.x, which has no user-message actions slot. */
export function installPromptEditPlacement(slots: NavigationSlots): () => void {
  if (slots.entries === undefined) return () => {}
  const patched = new Map<ReturnType<NonNullable<NavigationSlots['entries']>>[number], {
    original: ComponentType<NavigationViewProps>; wrapped: ComponentType<NavigationViewProps>
  }>()
  const install = () => {
    for (const name of ['conversation.view', 'conversation.chat.node']) {
      for (const entry of slots.entries!(name)) {
        const options = entry.options as { id?: string; key?: string }
        if ((name === 'conversation.view' ? options.id !== 'chat' : options.key !== 'user') || patched.has(entry)) continue
        if (Object.getOwnPropertyDescriptor(entry, 'component')?.writable !== true) continue
        const original = entry.component
        const wrapped = name === 'conversation.view' ? withLatestPrompt(original) : withPromptEditButton(original)
        entry.component = wrapped
        patched.set(entry, { original, wrapped })
      }
    }
  }
  const subscriptions = ['conversation.view', 'conversation.chat.node'].map(name => slots.subscribe?.(name, install))
  install()
  return () => {
    subscriptions.forEach(dispose => dispose?.())
    for (const [entry, { original, wrapped }] of patched) if (entry.component === wrapped) entry.component = original
    patched.clear()
  }
}
