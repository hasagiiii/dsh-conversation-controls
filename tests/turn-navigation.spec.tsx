// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { installTurnNavigationFilter, navigationFilter, withDeletedTurnNavigation, type NavigationSlotEntry, type NavigationViewProps } from '../src/client/turn-navigation.tsx'

afterEach(cleanup)
const KEY = 'conversationControlsDeletedTurns'

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) { value = next; for (const notify of listeners) notify() },
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify) } },
  }
}

function fixture() {
  const loaded = [{ turn: 2 }, { turn: 3 }]
  const chat = source({ navigation: { items: () => loaded }, timeline: { turns: new Map() } })
  const projection = source<Record<string, unknown>>({
    turnOutline: [{ turn: 1 }, { turn: 2 }, { turn: 3 }], [KEY]: [], inbox: 'untouched',
  })
  const props: NavigationViewProps = {
    useChat: selector => useSyncExternalStore(chat.subscribe, () => selector(chat.get())),
    useProjection: key => useSyncExternalStore(projection.subscribe, () => projection.get()[key]),
  }
  function ChatView({ useChat, useProjection }: NavigationViewProps) {
    const items = useChat!(s => s.navigation!.items())
    const outline = useProjection!('turnOutline') as { turn: number }[]
    const inbox = useProjection!('inbox') as string
    const all = new Set([...items, ...outline].map(item => item.turn))
    return <><output data-testid="loaded">{items.map(item => item.turn).join(',')}</output>
      <output data-testid="inbox">{inbox}</output>
      {[...all].sort().map(turn => <button key={turn}>跳转到第 {turn} 轮</button>)}</>
  }
  return { props, projection, chat, Component: withDeletedTurnNavigation(ChatView) }
}

describe('deleted turn navigation', () => {
  it('removes loaded and unloaded marks on live projection updates and retains unrelated hooks', () => {
    const { Component, props, projection } = fixture()
    render(<Component {...props} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    act(() => projection.set({ ...projection.get(), [KEY]: [1, 2] }))
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['跳转到第 3 轮'])
    expect(screen.getByTestId('loaded').textContent).toBe('3')
    expect(screen.getByTestId('inbox').textContent).toBe('untouched')
    // A late history page must not bring a deleted turn back.
    act(() => projection.set({ ...projection.get(), turnOutline: [{ turn: 1 }, { turn: 2 }, { turn: 3 }, { turn: 4 }] }))
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['跳转到第 3 轮', '跳转到第 4 轮'])
  })

  it('replays deletion state on mount and does not leak it across sessions', () => {
    const first = fixture()
    first.projection.set({ ...first.projection.get(), [KEY]: [2] })
    const view = render(<first.Component {...first.props} />)
    expect(screen.queryByRole('button', { name: '跳转到第 2 轮' })).toBeNull()
    const second = fixture()
    view.rerender(<first.Component {...second.props} />)
    expect(screen.getByRole('button', { name: '跳转到第 2 轮' })).toBeTruthy()
  })

  it('uses loaded tombstones while waiting for the whole-session projection', () => {
    const { Component, props, projection, chat } = fixture()
    projection.set({ ...projection.get(), [KEY]: undefined })
    chat.set({ ...chat.get(), timeline: { turns: new Map([[2, { data: new Map([['turn-delete', { hidden: true }]]) }]]) } })
    render(<Component {...props} />)
    expect(screen.queryByRole('button', { name: '跳转到第 2 轮' })).toBeNull()
  })

  it('keeps stable array identities without mutating mutable host indexes', () => {
    const filter = navigationFilter(new Set([2]))
    let items = [{ turn: 1 }, { turn: 2 }]
    const snapshot = { navigation: { items: () => items } }
    const wrapped = filter.snapshot(snapshot)
    expect(wrapped.navigation!.items()).toBe(wrapped.navigation!.items())
    expect(snapshot.navigation.items()).toHaveLength(2)
    items = [{ turn: 2 }, { turn: 3 }]
    expect(filter.snapshot(snapshot)).toBe(wrapped)
    expect(wrapped.navigation!.items()).toEqual([{ turn: 3 }])
  })

  it('adapts a single existing chat seat, supports late registration and restores on disposal', () => {
    const Original = () => null
    const entry: NavigationSlotEntry = { options: { id: 'chat' }, component: Original }
    const entries: NavigationSlotEntry[] = []
    let notify = () => {}
    let unsubscribed = false
    const dispose = installTurnNavigationFilter({
      entries: () => entries,
      subscribe: (_key, listener) => { notify = listener; return () => { unsubscribed = true } },
    })
    entries.push(entry)
    notify()
    const wrapped = entry.component
    expect(wrapped).not.toBe(Original)
    notify()
    expect(entry.component).toBe(wrapped)
    expect(entries).toHaveLength(1)
    dispose()
    expect(entry.component).toBe(Original)
    expect(unsubscribed).toBe(true)
  })

  it('preserves another extension replacement and safely skips unsupported hosts', () => {
    const Original = () => null
    const Other = () => null
    const entry = { options: { id: 'chat' }, component: Original }
    const dispose = installTurnNavigationFilter({ entries: () => [entry] })
    entry.component = Other
    dispose()
    expect(entry.component).toBe(Other)
    expect(() => installTurnNavigationFilter({ entries: () => [Object.freeze(entry)] })()).not.toThrow()
    expect(() => installTurnNavigationFilter({})()).not.toThrow()
  })
})
