import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { deletedTurnsProjectionDefinition as definition, DELETED_TURNS_PROJECTION_KEY } from '../src/deleted-turns-projection.ts'
import { apply } from '../src/index.ts'
import { SYSTEM_PROMPT_SOURCE_KIND, TOMBSTONE_PLUGIN, TOMBSTONE_PROVIDER, TOMBSTONE_MODEL } from '../src/shared.ts'

function tombstone(turn: number, format: 'v3' | 'v4' | 'legacy' = 'v4'): SessionEvent {
  const source = format === 'legacy'
    ? { kind: 'model', provider: TOMBSTONE_PROVIDER, model: TOMBSTONE_MODEL }
    : format === 'v3'
      ? { kind: 'plugin', plugin: TOMBSTONE_PLUGIN }
      : { kind: SYSTEM_PROMPT_SOURCE_KIND }
  return {
    type: format === 'legacy' ? 'assistant/message' : 'system/message',
    seq: 100 + turn,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
    sourceEventSeqs: [1, 2],
    data: { turn, step: 1, message: { content: [], source } },
  } as unknown as SessionEvent
}

function replay(events: readonly SessionEvent[]): readonly number[] {
  return events.reduce(definition.apply, definition.init())
}

describe('whole-log deleted-turn projection', () => {
  it('hides the historical target and its dedicated maintenance turn', () => {
    const event = tombstone(4)
    Object.assign(event.data, { deletedTurn: 1, maintenance: true })
    expect(definition.apply([], event)).toEqual([1, 4])
  })

  it('keeps the real answer visible when a recovered marker uses its open step', () => {
    const event = tombstone(2)
    Object.assign(event.data, { deletedTurn: 1, maintenance: false })
    expect(definition.apply([], event)).toEqual([1])
  })

  it('replays modern, v3 and legacy tombstones without needing their loaded transcript', () => {
    const events = [tombstone(12, 'v4'), tombstone(2, 'v3'), tombstone(7, 'legacy')]
    const state = replay(events)
    expect(definition.key).toBe(DELETED_TURNS_PROJECTION_KEY)
    expect(definition.wire.viewSchema.parse(definition.wire.view(state))).toEqual([2, 7, 12])
    expect(replay(JSON.parse(JSON.stringify(events)))).toEqual(state)
  })

  it('deduplicates and preserves identity for repeated and unrelated events', () => {
    const state = replay([tombstone(4), tombstone(4, 'v3'), tombstone(1)])
    expect(state).toEqual([1, 4])
    expect(definition.apply(state, tombstone(4))).toBe(state)
    expect(definition.apply(state, { type: 'turn/start', data: { turn: 9 } } as SessionEvent)).toBe(state)
    expect(definition.wire.view(state)).toBe(state)
  })

  it('ignores ordinary replacements, append events and invalid turn identities', () => {
    const base = tombstone(2) as unknown as { type: string; surfaceOp: unknown; data: { turn: number; message: { content: unknown[]; source: unknown } } }
    const events = [
      { ...base, surfaceOp: 'append' },
      { ...base, data: { ...base.data, message: { ...base.data.message, content: [{ type: 'text', text: 'prompt edit' }] } } },
      { ...base, data: { ...base.data, message: { ...base.data.message, source: { kind: 'plugin', plugin: 'another-plugin' } } } },
      ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined].map(turn => ({ ...base, data: { ...base.data, turn } })),
    ] as unknown as SessionEvent[]
    const initial = definition.init()
    for (const event of events) expect(definition.apply(initial, event)).toBe(initial)
  })

  it('validates cached state and resumes its fold after round-trip serialization', () => {
    const state = definition.stateSchema.parse(JSON.parse(JSON.stringify(replay([tombstone(3), tombstone(8)]))))
    expect(definition.apply(state, tombstone(5))).toEqual([3, 5, 8])
    for (const invalid of [[1, 1], [2, 1], [-1], [1.5], ['2'], {}, [Number.MAX_SAFE_INTEGER + 1]]) {
      expect(definition.stateSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('keeps routes active without projections and registers when the optional service appears', async () => {
    const ctx = new Context()
    const routes: unknown[] = []
    ctx.provide('webServer', { register: (route: unknown) => { routes.push(route); return () => {} } })
    const registered: unknown[] = []
    const plugin = await ctx.plugin({ apply })
    expect(routes).toHaveLength(2)
    expect(registered).toEqual([])
    ctx.provide('sessionProjections' as never, {
      register: (value: unknown) => { registered.push(value); return () => {} },
    } as never)
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(registered).toEqual([definition])
    await plugin.dispose()
  })
})
