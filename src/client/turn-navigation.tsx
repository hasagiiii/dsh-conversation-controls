import { createElement, useId, useMemo, type ComponentType } from 'react'

const DELETED_TURNS_PROJECTION = 'conversationControlsDeletedTurns'
const VIEW_SLOT = 'conversation.view'

interface NavigationItem { readonly turn: number }
interface ChatSnapshot {
  readonly navigation?: { items(): readonly NavigationItem[] }
  readonly timeline?: { turns: ReadonlyMap<number, { data: { get(key: string): unknown } }> }
}
type UseChat = <T>(selector: (snapshot: ChatSnapshot) => T) => T
export interface NavigationViewProps {
  useChat?: UseChat
  useProjection?: (key: string) => unknown
  [key: string]: unknown
}
export interface NavigationSlotEntry {
  readonly options: { readonly id?: string; readonly key?: string }
  component: ComponentType<NavigationViewProps>
}
export interface NavigationSlots {
  entries?(key: string): readonly NavigationSlotEntry[]
  subscribe?(key: string, listener: () => void): () => void
}

/** Preserve reference identity for selector subscriptions and the rail's memo. */
export function navigationFilter(deleted: ReadonlySet<number>) {
  const arrays = new WeakMap<readonly NavigationItem[], readonly NavigationItem[]>()
  const snapshots = new WeakMap<ChatSnapshot, ChatSnapshot>()
  function items<T extends NavigationItem>(source: readonly T[]): readonly T[] {
    const cached = arrays.get(source)
    if (cached !== undefined) return cached as readonly T[]
    const filtered = source.filter(item => !deleted.has(item.turn))
    const result = filtered.length === source.length ? source : filtered
    arrays.set(source, result)
    return result
  }
  return {
    deletedTurns: [...deleted],
    items,
    snapshot(source: ChatSnapshot): ChatSnapshot {
      if (source.navigation === undefined || deleted.size === 0) return source
      let result = snapshots.get(source)
      if (result === undefined) {
        // Do not alter the host's mutable navigation index or its published snapshot.
        result = { ...source, navigation: { items: () => items(source.navigation!.items()) } }
        snapshots.set(source, result)
      }
      return result
    },
  }
}

function loadedDeletions(snapshot: ChatSnapshot): string {
  const turns: number[] = []
  for (const [turn, entry] of snapshot.timeline?.turns ?? []) {
    const value = entry.data.get('turn-delete') as { hidden?: unknown } | undefined
    if (value?.hidden === true) turns.push(turn)
  }
  // A primitive selector result stays stable on unrelated token updates.
  return turns.join(',')
}

export function withDeletedTurnNavigation(Component: ComponentType<NavigationViewProps>): ComponentType<NavigationViewProps> {
  function FilteredNavigation(props: NavigationViewProps) {
    const scope = encodeURIComponent(useId())
    const useChat = props.useChat!
    const useProjection = props.useProjection!
    const projected = useProjection(DELETED_TURNS_PROJECTION)
    const loaded = useChat(loadedDeletions)
    const filter = useMemo(() => {
      const deleted = new Set<number>(loaded === '' ? [] : loaded.split(',').map(Number))
      if (Array.isArray(projected)) {
        for (const turn of projected) if (Number.isSafeInteger(turn) && turn >= 0) deleted.add(turn)
      }
      return navigationFilter(deleted)
    }, [projected, loaded])
    const adapted = useMemo(() => ({
      useChat: <T,>(selector: (snapshot: ChatSnapshot) => T) => useChat(snapshot => selector(filter.snapshot(snapshot))),
      useProjection: (key: string) => {
        const value = useProjection(key)
        return key === 'turnOutline' && Array.isArray(value) ? filter.items(value) : value
      },
    }), [useChat, useProjection, filter])
    // DSH 0.2.1 renders memoized, sometimes nested group seats independently of
    // navigation/order. Their explicit turn attribute is stable even when a
    // tombstone does not rerender the tail slot. Scope the rule to this chat so
    // live projection updates and later history mounts both hide the whole turn.
    // display:contents preserves the host's flex/grid layout and scroll owner.
    const hiddenRows = filter.deletedTurns.map(turn =>
      `[data-dsh-conversation-controls="${scope}"] [data-chat-turn="${turn}"]`,
    ).join(',')
    return <div data-dsh-conversation-controls={scope} style={{ display: 'contents' }}>
      {hiddenRows !== '' && <style>{`${hiddenRows}{display:none!important}`}</style>}
      {createElement(Component, { ...props, ...adapted })}
    </div>
  }
  // Older chat versions have neither navigation nor projection hooks. Keep their
  // component tree and hook order intact, without requiring a newer host service.
  return function NavigationCompatibility(props) {
    return typeof props.useChat === 'function' && typeof props.useProjection === 'function'
      ? createElement(FilteredNavigation, props)
      : createElement(Component, props)
  }
}

/**
 * DSH 0.2.x renders entry.component directly but exposes no navigation filter.
 * Adapt the existing chat seat, preserving its child slots, injectors, store and
 * tab identity. A second registration would create duplicate Chat tabs. This
 * narrow compatibility adapter must be revisited if the renderer contract changes.
 */
export function installTurnNavigationFilter(slots: NavigationSlots): () => void {
  if (slots.entries === undefined) return () => {}
  const patched = new Map<NavigationSlotEntry, {
    original: ComponentType<NavigationViewProps>
    wrapped: ComponentType<NavigationViewProps>
  }>()
  const install = () => {
    for (const entry of slots.entries!(VIEW_SLOT)) {
      if (entry.options.id !== 'chat' || patched.has(entry)) continue
      const descriptor = Object.getOwnPropertyDescriptor(entry, 'component')
      if (descriptor?.writable !== true) continue
      const original = entry.component
      const wrapped = withDeletedTurnNavigation(original)
      entry.component = wrapped
      patched.set(entry, { original, wrapped })
    }
  }
  const unsubscribe = slots.subscribe?.(VIEW_SLOT, install)
  install()
  return () => {
    unsubscribe?.()
    for (const [entry, { original, wrapped }] of patched) {
      if (entry.component === wrapped) entry.component = original
    }
    patched.clear()
  }
}
