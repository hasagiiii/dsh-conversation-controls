import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  isPromptEditEvent,
  loadLastPrompt,
  PromptEditError,
  saveLastPrompt,
  resendLastPrompt,
} from '../src/prompt-edit.ts'

import { isTurnDeleteEvent } from '../src/turn-delete.ts'

type TestSession = ReturnType<Context['sessions']['create']>

function user(id: string, text: string, attachment = false): UserMessage {
  const content: ContentBlock[] = [{ type: 'text', text }]
  if (attachment) content.push({ type: 'file', attachment: {} } as unknown as ContentBlock)
  return { id: MessageId(id), role: 'user', content, source: { kind: 'user' } }
}

function assistant(id: string, text: string) {
  return {
    turn: 1,
    step: 1,
    message: {
      id: MessageId(id),
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
      source: { kind: 'model' as const, provider: 'test', model: 'test' },
    },
    stream: [],
  }
}

async function contextAndSession(id = 'prompt-edit'): Promise<{ ctx: Context; session: TestSession }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { ctx, session: ctx.sessions.create(SessionId(id)) }
}

function idleAgent(session: TestSession, overrides: Partial<Agent> = {}): Agent {
  return {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    ctx: new Context(),
    inbox: { nextTurn: [], nextStep: [] } as unknown as Agent['inbox'],
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    ...overrides,
  } as unknown as Agent
}

function appendOpenPrompt(session: TestSession) {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  return session.append('user/message', user('prompt-1', '原始问题', true), { surfaceOp: 'append' })
}

function errorCode(error: unknown): string {
  return error instanceof PromptEditError ? error.code : String(error)
}

describe('prompt editing', () => {
  it('resends once with attachments after removing old answer and tool context', async () => {
    const { ctx, session } = await contextAndSession('resend')
    const prompt = appendOpenPrompt(session)
    session.append('assistant/message', assistant('old', 'old answer'), { surfaceOp: 'append' })
    session.append('user/message', { ...user('tool-context', 'old tool context'), source: { kind: 'plugin', plugin: 'test' } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    let sends = 0
    const agent = idleAgent(session, { send(message, target, wakeup) {
      sends += 1
      expect(target).toBe('next-turn')
      expect(wakeup).toBe(true)
      expect(session.deriveMessages()).toEqual([])
      expect(message.content[1]).toEqual(prompt.data.content[1])
      expect(message.source).toEqual(prompt.data.source)
      expect(message.id).not.toBe(prompt.data.id)
      session.append('turn/start', { turn: 2 })
      session.append('step/start', { turn: 2, step: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
    } })
    const result = await resendLastPrompt(ctx, agent, { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'new question' })
    expect(result.submitted).toBe(true)
    expect(sends).toBe(1)
    expect(session.deriveMessages()).toHaveLength(1)
    expect((await loadLastPrompt(ctx, agent)).text).toBe('new question')
    await expect(resendLastPrompt(ctx, agent, { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'duplicate' })).rejects.toMatchObject({ code: 'PROMPT_CHANGED' })
  })

  it.each([1, 2])('recovers a flush failure at stage %s without losing input', async failAt => {
    const { ctx, session } = await contextAndSession(`recover-${failAt}`)
    const prompt = appendOpenPrompt(session)
    session.append('assistant/message', assistant('old', 'old answer'), { surfaceOp: 'append' })
    let flushes = 0
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    ctx.sessions.flush = async target => { if (++flushes === failAt) throw new Error('disk failure'); return flush(target) }
    let sends = 0
    const agent = idleAgent(session, { send(message) { sends += 1; session.append('user/message', message, { surfaceOp: 'append' }) } })
    const error = await resendLastPrompt(ctx, agent, { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'recover me' }).catch(error => error as PromptEditError)
    expect(error).toMatchObject({ code: 'RESEND_FAILED', recovery: { submitted: false, retryable: true, prompt: { text: 'recover me' } } })
    const recovered = await loadLastPrompt(ctx, agent)
    if (!(error instanceof PromptEditError)) throw new Error('expected resend failure')
    expect(recovered).toEqual(error.recovery?.prompt)
    expect(sends).toBe(0)
    await resendLastPrompt(ctx, agent, { messageId: recovered.messageId, expectedSeq: recovered.seq, text: recovered.text })
    expect(sends).toBe(1)
    expect(session.deriveMessages()).toHaveLength(1)
  })

  it.each(['submit', 'persist'])('does not advertise a blind retry after %s failure', async phase => {
    const { ctx, session } = await contextAndSession(`accepted-${phase}`)
    const prompt = appendOpenPrompt(session)
    let flushes = 0
    ctx.sessions.flush = async () => { if (++flushes === 3) throw new Error('durability failure'); return true }
    const agent = idleAgent(session, { send() { if (phase === 'submit') throw new Error('ambiguous send failure') } })
    await expect(resendLastPrompt(ctx, agent, { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'new' })).rejects.toMatchObject({
      code: 'RESEND_FAILED', recovery: { phase, submitted: phase === 'submit' ? 'unknown' : true, retryable: false },
    })
  })

  it('rejects queued input and overlapping maintenance without mutation', async () => {
    const { ctx, session } = await contextAndSession('busy-resend')
    const prompt = appendOpenPrompt(session)
    const input = { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'new' }
    const before = session.snapshotEvents().length
    await expect(resendLastPrompt(ctx, idleAgent(session, { inbox: { nextTurn: [user('queued', 'queued')], nextStep: [] } as unknown as Agent['inbox'] }), input)).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    await expect(resendLastPrompt(ctx, idleAgent(session, { runMaintenance() { throw new Error('already has active work') } }), input)).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    expect(session.snapshotEvents()).toHaveLength(before)
  })

  it('hides continuation turns and recovers the prepared revision after replay', async () => {
    const { ctx, session } = await contextAndSession('continuation-resend')
    const prompt = appendOpenPrompt(session)
    session.append('assistant/message', assistant('first-answer', 'old answer'), { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', { ...assistant('continued-answer', 'old continuation'), turn: 2 }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    let flushes = 0
    ctx.sessions.flush = async () => { if (++flushes === 2) throw new Error('prepare failed'); return true }
    await expect(resendLastPrompt(ctx, idleAgent(session), { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'edited' })).rejects.toMatchObject({ recovery: { phase: 'prepare', submitted: false } })
    expect(session.snapshotEvents().filter(isTurnDeleteEvent).map(event => event.data.turn)).toEqual([1, 2])
    expect(session.deriveMessages()).toEqual([])
    const replay = ctx.sessions.create(SessionId('replayed-resend'), { seed: structuredClone(session.snapshotEvents()) })
    const agent = idleAgent(replay, { send(message) { replay.append('user/message', message, { surfaceOp: 'append' }) } })
    const recovered = await loadLastPrompt(ctx, agent)
    expect(recovered.text).toBe('edited')
    await resendLastPrompt(ctx, agent, { messageId: recovered.messageId, expectedSeq: recovered.seq, text: recovered.text })
    expect(replay.snapshotEvents().filter(isTurnDeleteEvent)).toHaveLength(2)
    expect(replay.deriveMessages()).toHaveLength(1)
  })

  it('stamps every resend marker with a positive step that its turn opened', async () => {
    const { ctx, session } = await contextAndSession('marker-coordinates')
    const prompt = appendOpenPrompt(session)
    session.append('assistant/message', assistant('first-answer', 'old answer'), { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    session.append('assistant/message', { ...assistant('second-step', 'more'), step: 2 }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', { ...assistant('continued-answer', 'old continuation'), turn: 2 }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const agent = idleAgent(session, { send(message) { session.append('user/message', message, { surfaceOp: 'append' }) } })
    await resendLastPrompt(ctx, agent, { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'edited' })
    const markers = session.snapshotEvents().filter(isTurnDeleteEvent)
    expect(markers.map(event => [event.data.turn, event.data.step])).toEqual([[1, 2], [2, 1]])
  })

  it.each(['cancel', 'queued'] as const)('does not submit when %s arrives during persistence', async change => {
    const { ctx, session } = await contextAndSession(`race-${change}`)
    const prompt = appendOpenPrompt(session)
    const controller = new AbortController()
    const queued: UserMessage[] = []
    let sends = 0
    const agent = idleAgent(session, {
      inbox: { nextTurn: [], nextStep: queued } as unknown as Agent['inbox'],
      runMaintenance: task => task(controller.signal),
      send() { sends += 1 },
    })
    ctx.sessions.flush = async () => {
      if (change === 'cancel') controller.abort()
      else queued.push(user('foreign-input', 'queued elsewhere'))
      return true
    }
    await expect(resendLastPrompt(ctx, agent, { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'new' })).rejects.toMatchObject({ recovery: { submitted: false, retryable: true, prompt: { text: 'new' } } })
    expect(sends).toBe(0)
    expect(session.snapshotEvents().filter(isTurnDeleteEvent)).toEqual([])
  })

  it('refuses a changed surface after prepare flush and does not advertise stale recovery', async () => {
    const { ctx, session } = await contextAndSession('changed-during-prepare')
    const prompt = appendOpenPrompt(session)
    let flushes = 0
    let sends = 0
    ctx.sessions.flush = async () => {
      if (++flushes === 2) session.append('user/message', user('newer', 'newer human prompt'), { surfaceOp: 'append' })
      return true
    }
    await expect(resendLastPrompt(ctx, idleAgent(session, { send() { sends += 1 } }), { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'edited' })).rejects.toMatchObject({ recovery: { submitted: false, retryable: false, prompt: { text: 'edited' } } })
    expect(sends).toBe(0)
    expect((await loadLastPrompt(ctx, idleAgent(session))).messageId).toBe('newer')
  })

  it('preserves earlier conversation messages when resending the latest prompt', async () => {
    const { ctx, session } = await contextAndSession('earlier-history')
    session.append('user/message', user('earlier', 'keep this'), { surfaceOp: 'append' })
    const prompt = appendOpenPrompt(session)
    session.append('assistant/message', assistant('old-answer', 'remove this'), { surfaceOp: 'append' })
    const agent = idleAgent(session, { send(message) { session.append('user/message', message, { surfaceOp: 'append' }) } })
    await resendLastPrompt(ctx, agent, { messageId: 'prompt-1', expectedSeq: Number(prompt.seq), text: 'replacement' })
    expect(session.deriveMessages().map(message => message.content[0])).toEqual([{ type: 'text', text: 'keep this' }, { type: 'text', text: 'replacement' }])
  })

  it('loads an open-turn prompt and counts attachments', async () => {
    const { ctx, session } = await contextAndSession()
    appendOpenPrompt(session)
    const result = await loadLastPrompt(ctx, idleAgent(session))
    expect(result).toEqual({ messageId: 'prompt-1', seq: 2, text: '原始问题', attachmentCount: 1 })
  })

  it('replaces one user node, preserves identity/source/attachments, and flushes', async () => {
    const { ctx, session } = await contextAndSession('save-prompt')
    const original = appendOpenPrompt(session)
    const oldAssistant = session.append('assistant/message', assistant('answer-1', '既有回答'), { surfaceOp: 'append' })
    let flushes = 0
    const context = ctx as Context & { sessions: typeof ctx.sessions }
    const originalFlush = context.sessions.flush.bind(context.sessions)
    context.sessions.flush = async target => {
      flushes += 1
      return originalFlush(target)
    }

    const result = await saveLastPrompt(ctx, idleAgent(session), {
      messageId: 'prompt-1',
      expectedSeq: Number(original.seq),
      text: '修改后的问题',
    })

    expect(result).toEqual({ messageId: 'prompt-1', seq: 4, text: '修改后的问题', attachmentCount: 1 })
    expect(flushes).toBe(1)
    const replacement = session.eventAt(SessionSeq(result.seq))
    expect(replacement?.type).toBe('user/message')
    if (replacement?.type === 'user/message') {
      expect(replacement.data.id).toBe(original.data.id)
      expect(replacement.data.source).toEqual(original.data.source)
      expect(replacement.data.content).toHaveLength(2)
      expect(isPromptEditEvent(replacement, session.snapshotEvents())).toBe(true)
      expect(replacement.sourceEventSeqs).toEqual([original.seq])
      expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: original.seq, endSeq: original.seq })
    }
    expect(session.eventAt(oldAssistant.seq)).toEqual(oldAssistant)
    expect(session.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: '修改后的问题' }, { type: 'file', attachment: {} }],
      [{ type: 'text', text: '既有回答' }],
    ])
  })

  it('supports repeated edits through a same-id replacement chain', async () => {
    const { ctx, session } = await contextAndSession('repeat-prompt')
    const original = appendOpenPrompt(session)
    const agent = idleAgent(session)
    const first = await saveLastPrompt(ctx, agent, {
      messageId: 'prompt-1', expectedSeq: Number(original.seq), text: '第一次修改',
    })
    const second = await saveLastPrompt(ctx, agent, {
      messageId: first.messageId, expectedSeq: first.seq, text: '第二次修改',
    })
    expect(second.text).toBe('第二次修改')
    expect(session.surface.nodes).toContain(second.seq)
    expect(session.surface.nodes).not.toContain(original.seq)
  })

  it('does not fall back to an older prompt after the latest original is shadowed', async () => {
    const { ctx, session } = await contextAndSession('shadowed-latest')
    appendOpenPrompt(session)
    const latest = session.append('user/message', user('prompt-2', '最新问题'), { surfaceOp: 'append' })
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('shadow'),
        role: 'system',
        content: [],
        source: { kind: 'plugin', plugin: 'test' },
      },
    }, {
      surfaceOp: { op: 'replace', startSeq: latest.seq, endSeq: latest.seq },
      sourceEventSeqs: [latest.seq],
    })
    await expect(loadLastPrompt(ctx, idleAgent(session))).rejects.toSatisfy(
      error => errorCode(error) === 'TARGET_NOT_FOUND',
    )
  })

  it('rejects stale windows, active agents, detached sessions, subagents, and oversized text', async () => {
    const { ctx, session } = await contextAndSession('errors-prompt')
    const original = appendOpenPrompt(session)
    await expect(saveLastPrompt(ctx, idleAgent(session), {
      messageId: 'prompt-1', expectedSeq: Number(original.seq) + 1, text: '新问题',
    })).rejects.toSatisfy(error => errorCode(error) === 'PROMPT_CHANGED')

    await expect(loadLastPrompt(ctx, idleAgent(session, { status: 'running' }))).rejects.toSatisfy(
      error => errorCode(error) === 'AGENT_BUSY',
    )
    await expect(loadLastPrompt(ctx, idleAgent(session, {
      options: { subagent: true } as unknown as Agent['options'],
    }))).rejects.toSatisfy(error => errorCode(error) === 'PROMPT_UNSUPPORTED')

    const detached = await contextAndSession('detached-prompt')
    appendOpenPrompt(detached.session)
    const detachedAgent = idleAgent(detached.session)
    const detach = detached.ctx.sessions.list()[0]
    expect(detach).toBe(detached.session)
    ;(detached.ctx.sessions as unknown as { get: (id: string) => Session | undefined }).get = () => undefined
    await expect(loadLastPrompt(detached.ctx, detachedAgent)).rejects.toSatisfy(
      error => errorCode(error) === 'TARGET_NOT_FOUND',
    )

    await expect(saveLastPrompt(ctx, idleAgent(session), {
      messageId: 'prompt-1', expectedSeq: Number(original.seq), text: '字'.repeat(256 * 1024),
    })).rejects.toSatisfy(error => errorCode(error) === 'PROMPT_UNSUPPORTED')
  })
})
