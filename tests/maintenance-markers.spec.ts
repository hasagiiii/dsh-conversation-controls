import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { appendDeletionMarker } from '../src/turn-delete.ts'

async function fixture({ closed = true, head = true } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('maintenance-markers'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  if (head) session.append('system/message', {
    turn: 1, step: 1, message: createSystemMessage('instructions', 'system-prompt'),
  }, { surfaceOp: 'append' })
  const prompt = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'old prompt' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (closed) {
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const v4 = {
    header: { version: 4 },
    get surface() { return session.surface },
    snapshotEvents: () => session.snapshotEvents(),
    append: session.append.bind(session),
  } as unknown as Agent['session']
  const agent = { session: v4, phase: { kind: 'maintenance', lastTurn: 1 } } as unknown as Agent
  return { session, agent, prompt }
}

const message = () => createSystemMessage('', 'dsh-turn-delete')

describe('v4 deletion lifecycle', () => {
  it('writes a complete fresh lifecycle while preserving an empty model replacement', async () => {
    const { session, agent, prompt } = await fixture()
    const marker = appendDeletionMarker(agent, 1, 7, message(), [prompt.seq])
    expect(marker.data).toMatchObject({ turn: 2, step: 1, deletedTurn: 1, maintenance: true })
    expect(session.snapshotEvents().slice(-5).map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
    ])
    expect(session.deriveMessages().map(item => item.role)).toEqual(['system'])
    const next = appendDeletionMarker(agent, 1, 7, message(), [marker.seq])
    expect(next.data).toMatchObject({ turn: 3, step: 1, deletedTurn: 1 })
    expect(session.deriveMessages().map(item => item.role)).toEqual(['system'])
  })

  it.each([{ closed: false, head: true }, { closed: true, head: false }])(
    'rejects unsafe lifecycle or missing protected head before appending: %j', async options => {
      const { session, agent, prompt } = await fixture(options)
      const before = session.snapshotEvents()
      expect(() => appendDeletionMarker(agent, 1, 1, message(), [prompt.seq])).toThrow()
      expect(session.snapshotEvents()).toEqual(before)
    },
  )
})
