import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId, type SystemMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { appendDeletionMarker, deletedTurnOf, tombstoneSource, validateDeletionMaintenance } from './turn-delete.ts'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'

const MAX_TEXT_BYTES = 256 * 1024

type UserMessageEvent = SessionEvent<'user/message'>

type SessionLike = {
  readonly id: string
  snapshotEvents?: () => readonly SessionEvent[]
  events?: readonly SessionEvent[]
  surface: { nodes: readonly SessionSeq[] }
  append: SessionEvent['type'] extends never ? never : (
    type: 'user/message',
    data: UserMessage,
    opts: {
      surfaceOp: { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
      sourceEventSeqs: SessionSeq[]
    },
  ) => UserMessageEvent
}

type AgentLike = Agent & { session: SessionLike }

export type PromptEditErrorCode =
  | 'AGENT_BUSY'
  | 'TARGET_NOT_FOUND'
  | 'PROMPT_CHANGED'
  | 'PROMPT_UNSUPPORTED'
  | 'EDIT_FAILED'
  | 'RESEND_FAILED'

export class PromptEditError extends Error {
  override readonly name = 'PromptEditError'

  constructor(readonly code: PromptEditErrorCode, message: string, options?: ErrorOptions,
    readonly recovery?: PromptResendRecovery) {
    super(message, options)
  }
}

export interface LastPrompt {
  readonly messageId: string
  readonly seq: number
  readonly text: string
  readonly attachmentCount: number
}

export interface PromptEditReceipt extends LastPrompt {}

export interface PromptResendReceipt extends LastPrompt {
  readonly submitted: true
}

export interface PromptResendRecovery {
  readonly prompt: LastPrompt
  readonly phase: 'save' | 'prepare' | 'submit' | 'persist'
  readonly submitted: boolean | 'unknown'
  readonly retryable: boolean
}

const RESEND_MARKER = 'conversation-controls:resend:'

/** A durable prepared resend keeps its edited input in the cited revision. */
function preparedResend(agent: AgentLike): UserMessageEvent | undefined {
  const events = sessionEvents(agent.session)
  const tail = agent.session.surface.nodes.at(-1)
  const marker = events.find(event => event.seq === tail)
  if (marker?.type !== 'system/message'
    || !String(marker.data.message.id).startsWith(RESEND_MARKER)
    || marker.data.message.content.length !== 0) return undefined
  const sourceSeq = Number(String(marker.data.message.id).slice(RESEND_MARKER.length))
  const bySeq = new Map(events.map(event => [Number(event.seq), event]))
  let current: SessionEvent | undefined = marker
  while (current !== undefined && Number(current.seq) !== sourceSeq) {
    if (current.type !== 'system/message' || current.data.message.id !== marker.data.message.id) return undefined
    const operation = current.surfaceOp
    if (typeof operation !== 'object' || operation.op !== 'replace'
      || Number(operation.startSeq) >= Number(current.seq)
      || current.sourceEventSeqs?.[0] !== operation.startSeq) return undefined
    current = bySeq.get(Number(operation.startSeq))
  }
  const origin = latestOriginalPrompt(events)
  return current !== undefined && isHumanPrompt(current) && isPromptEditEvent(current, events)
    && origin !== undefined && replacementChainReaches(origin, current, events) ? current : undefined
}

export interface SaveLastPromptInput {
  readonly messageId: string
  readonly expectedSeq: number
  readonly text: string
}

function sessionEvents(session: SessionLike): readonly SessionEvent[] {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

function isHumanPrompt(event: SessionEvent): event is UserMessageEvent {
  if (event.type !== 'user/message') return false
  const source = event.data.source
  return typeof source === 'object' && source !== null && source.kind === 'user'
}

function currentSurfaceUserPrompt(agent: AgentLike, events: readonly SessionEvent[]): UserMessageEvent | undefined {
  const bySeq = new Map(events.map(event => [Number(event.seq), event] as const))
  for (let index = agent.session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = agent.session.surface.nodes[index]
    if (seq === undefined) continue
    const event = bySeq.get(Number(seq))
    if (event !== undefined && isHumanPrompt(event)) return event
  }
  return undefined
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Identify the single-node, same-message replacement emitted by this editor.
 * Supplying the event log additionally verifies that the cited source is the
 * same user message and source object; without it the marker shape is checked.
 */
export function isPromptEditEvent(event: SessionEvent, events?: readonly SessionEvent[]): boolean {
  if (!isHumanPrompt(event)) return false
  const candidate = event as SessionEvent & {
    surfaceOp?: unknown
    sourceEventSeqs?: readonly SessionSeq[]
  }
  const operation = candidate.surfaceOp
  if (typeof operation !== 'object' || operation === null) return false
  const replacement = operation as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (replacement.op !== 'replace' || replacement.startSeq !== replacement.endSeq) return false
  const sources = candidate.sourceEventSeqs
  if (sources === undefined || sources.length !== 1 || sources[0] !== replacement.startSeq) return false
  if (events === undefined) return true
  const source = events.find(item => item.seq === sources[0])
  return source !== undefined && isHumanPrompt(source)
    && String(source.data.id) === String(event.data.id)
    && sameJson(source.data.source, event.data.source)
}

function latestOriginalPrompt(events: readonly SessionEvent[]): UserMessageEvent | undefined {
  return events.findLast(event => isHumanPrompt(event) && isAppendSurfaceEvent(event))
}

function replacementChainReaches(
  origin: UserMessageEvent,
  target: UserMessageEvent,
  events: readonly SessionEvent[],
): boolean {
  if (origin.seq === target.seq) return true
  const bySeq = new Map(events.map(event => [Number(event.seq), event] as const))
  let current: SessionEvent = target
  const seen = new Set<number>()
  while (current.seq !== origin.seq) {
    const currentNumber = Number(current.seq)
    if (seen.has(currentNumber) || !isPromptEditEvent(current, events)) return false
    seen.add(currentNumber)
    const sourceSeq = (current as SessionEvent & { sourceEventSeqs: readonly SessionSeq[] }).sourceEventSeqs[0]
    const previous = bySeq.get(Number(sourceSeq))
    if (previous === undefined) return false
    current = previous
  }
  return current === origin
}

function textOf(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function attachmentCount(message: UserMessage): number {
  return message.content.filter(block => block.type === 'image' || block.type === 'file').length
}

function snapshot(event: UserMessageEvent): LastPrompt {
  return {
    messageId: String(event.data.id),
    seq: Number(event.seq),
    text: textOf(event.data),
    attachmentCount: attachmentCount(event.data),
  }
}

function assertText(text: string): void {
  if (text.length === 0) throw new PromptEditError('PROMPT_UNSUPPORTED', 'prompt text must not be empty')
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
    throw new PromptEditError('PROMPT_UNSUPPORTED', 'prompt text exceeds 256 KiB')
  }
}

function replaceText(content: readonly ContentBlock[], text: string): ContentBlock[] {
  let replaced = false
  const next: ContentBlock[] = []
  for (const block of content) {
    if (block.type !== 'text') {
      next.push(block)
      continue
    }
    if (!replaced) {
      next.push({ type: 'text', text })
      replaced = true
    }
  }
  if (!replaced) next.unshift({ type: 'text', text })
  return next
}

function ensureSessionAttached(ctx: Context, agent: AgentLike): void {
  const sessions = ctx.sessions as unknown as { get?: (id: SessionSeq | string) => unknown } | undefined
  if (sessions === undefined || typeof sessions.get !== 'function' || sessions.get(agent.session.id) !== agent.session) {
    throw new PromptEditError('TARGET_NOT_FOUND', 'the agent session is no longer attached')
  }
}

function rejectSubagent(agent: AgentLike): void {
  const options = (agent as AgentLike & { options?: { subagent?: unknown } }).options
  if (options?.subagent) throw new PromptEditError('PROMPT_UNSUPPORTED', 'subagent sessions cannot edit prompts')
}

function findPrompt(agent: AgentLike): UserMessageEvent {
  const events = sessionEvents(agent.session)
  const origin = latestOriginalPrompt(events)
  const target = currentSurfaceUserPrompt(agent, events)
  if (origin === undefined || target === undefined) {
    throw new PromptEditError('TARGET_NOT_FOUND', 'no editable human prompt was found')
  }
  if (String(origin.data.id) !== String(target.data.id)
    || !sameJson(origin.data.source, target.data.source)
    || !replacementChainReaches(origin, target, events)) {
    throw new PromptEditError('TARGET_NOT_FOUND', 'the latest human prompt is no longer editable')
  }
  if (target.data.content.some(block => block.type === 'tool-result' || block.type === 'tool-call')) {
    throw new PromptEditError('PROMPT_UNSUPPORTED', 'the last human prompt contains tool content')
  }
  return target
}

function busyError(error: unknown): PromptEditError {
  const message = error instanceof Error ? error.message : String(error)
  return new PromptEditError('AGENT_BUSY', message || 'agent is busy')
}

function runWhenIdle<T>(agent: AgentLike, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (agent.status !== 'idle') return Promise.reject(new PromptEditError('AGENT_BUSY', 'agent is busy'))
  let started = false
  const guardedTask = async (signal: AbortSignal): Promise<T> => {
    started = true
    return task(signal)
  }
  let result: Promise<T>
  try {
    result = agent.runMaintenance(guardedTask)
  } catch (error: unknown) {
    return Promise.reject(busyError(error))
  }
  return result.catch(error => {
    if (!started) throw busyError(error)
    throw error
  })
}

export function loadLastPrompt(ctx: Context, agent: Agent): Promise<LastPrompt> {
  return runWhenIdle(agent as AgentLike, async signal => {
    signal.throwIfAborted()
    const typedAgent = agent as AgentLike
    ensureSessionAttached(ctx, typedAgent)
    rejectSubagent(typedAgent)
    const target = preparedResend(typedAgent) ?? findPrompt(typedAgent)
    return snapshot(target)
  })
}

/**
 * Save a durable revision, shadow the old response, then wake a fresh turn.
 * Both supported loops latch send(..., true) behind the maintenance lease.
 * Keeping the revision as the marker's cited source makes preparation failures
 * recoverable after a process restart without resubmitting accepted work.
 */
export async function resendLastPrompt(
  ctx: Context,
  agent: Agent,
  input: SaveLastPromptInput,
): Promise<PromptResendReceipt> {
  assertText(input.text)
  if (!Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0) {
    throw new PromptEditError('PROMPT_UNSUPPORTED', 'expectedSeq must be a non-negative integer')
  }
  return runWhenIdle(agent as AgentLike, async signal => {
    const typedAgent = agent as AgentLike
    signal.throwIfAborted()
    ensureSessionAttached(ctx, typedAgent)
    rejectSubagent(typedAgent)
    if (typeof agent.send !== 'function') throw new PromptEditError('PROMPT_UNSUPPORTED', 'agent does not support resend')
    try { validateDeletionMaintenance(agent) } catch (cause) {
      throw new PromptEditError('PROMPT_UNSUPPORTED', 'host does not support safe resend maintenance', { cause })
    }
    if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length !== 0) throw new PromptEditError('AGENT_BUSY', 'agent has queued messages')
    const prepared = preparedResend(typedAgent)
    let revision = prepared ?? findPrompt(typedAgent)
    if (String(revision.data.id) !== input.messageId || Number(revision.seq) !== input.expectedSeq) {
      throw new PromptEditError('PROMPT_CHANGED', 'the prompt changed while it was being edited')
    }
    if (prepared !== undefined && textOf(prepared.data) !== input.text) {
      throw new PromptEditError('PROMPT_CHANGED', 'retry the prepared prompt before making another edit')
    }
    let phase: PromptResendRecovery['phase'] = 'save'
    let submitted: PromptResendRecovery['submitted'] = false
    try {
      if (prepared === undefined) {
        revision = typedAgent.session.append('user/message', {
          ...revision.data, content: replaceText(revision.data.content, input.text),
        }, {
          surfaceOp: { op: 'replace', startSeq: revision.seq, endSeq: revision.seq },
          sourceEventSeqs: [revision.seq],
        })
      }
      await ctx.sessions.flush(agent.session)
      signal.throwIfAborted()
      ensureSessionAttached(ctx, typedAgent)
      if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length !== 0) throw new Error('agent received queued messages during preparation')
      phase = 'prepare'
      const events = sessionEvents(typedAgent.session)
      const origin = latestOriginalPrompt(events)
      if (origin === undefined || !replacementChainReaches(origin, revision, events)) throw new Error('latest prompt changed during preparation')
      const markerId = MessageId(`${RESEND_MARKER}${Number(revision.seq)}`)
      const turns = new Set<number>()
      const hiddenTurns = new Set<number>()
      const maintenanceTurns = new Set(events.filter(event => event.type === 'system/message'
        && (event.data as { maintenance?: boolean }).maintenance === true)
        .map(event => (event as SessionEvent<'system/message'>).data.turn))
      const lastSteps = new Map<number, number>()
      let currentTurn = 0
      for (const event of events) {
        if (event.type === 'turn/start') currentTurn = event.data.turn
        if (event.type === 'step/start') lastSteps.set(event.data.turn, Math.max(lastSteps.get(event.data.turn) ?? 0, event.data.step))
        if (Number(event.seq) >= Number(origin.seq) && !maintenanceTurns.has(currentTurn)) turns.add(currentTurn)
        if (event.type === 'system/message' && event.data.message.id === markerId) hiddenTurns.add(deletedTurnOf(event))
      }
      const markerStep = (turn: number): number => lastSteps.get(turn) ?? 1
      for (const turn of turns) {
        if (!hiddenTurns.has(turn) && (!Number.isSafeInteger(turn) || turn < 1)) {
          throw new Error(`prompt turn ${String(turn)} cannot carry a resend marker`)
        }
      }
      // One range replacement clears every old response/tool node. Additional
      // single-node tombstones mark automatic continuation turns for the UI's
      // durable deleted-turn projection, without adding any model messages.
      let anchor = prepared === undefined ? revision.seq : agent.session.surface.nodes.at(-1)!
      for (const turn of turns) {
        if (hiddenTurns.has(turn)) continue
        const nodes = [...agent.session.surface.nodes]
        const start = nodes.indexOf(anchor)
        if (start < 0) throw new Error('prompt surface changed during preparation')
        const selected = nodes.slice(start)
        const formatVersion = (agent.session as unknown as { header?: { version?: number } }).header?.version
        const marker = appendDeletionMarker(agent, turn, markerStep(turn), {
          id: markerId, role: 'system', content: [],
          source: tombstoneSource(formatVersion) as SystemMessage['source'],
        }, selected)
        anchor = marker.seq
      }
      await ctx.sessions.flush(agent.session)
      signal.throwIfAborted()
      ensureSessionAttached(ctx, typedAgent)
      if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length !== 0) throw new Error('agent received queued messages during preparation')
      if (preparedResend(typedAgent)?.seq !== revision.seq) throw new Error('prompt surface changed before submission')
      phase = 'submit'
      // A fresh identity keeps the new turn separate from the hidden old bubble
      // in clients whose node projections group messages by message id.
      const queued = createUserMessage({ content: revision.data.content, source: revision.data.source })
      // A throwing send can have committed its inbox splice before notification
      // or wake failed. Never advise a blind retry when acceptance is ambiguous.
      submitted = 'unknown'
      agent.send(queued, 'next-turn', true)
      submitted = true
      phase = 'persist'
      await ctx.sessions.flush(agent.session)
      return { ...snapshot(revision), submitted: true }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      let retryable = false
      if (submitted === false) {
        try {
          ensureSessionAttached(ctx, typedAgent)
          retryable = (preparedResend(typedAgent) ?? findPrompt(typedAgent)).seq === revision.seq
        } catch { /* A changed or detached target cannot safely retry this revision. */ }
      }
      throw new PromptEditError('RESEND_FAILED', message || 'failed to resend prompt', { cause: error }, {
        prompt: snapshot(revision), phase, submitted, retryable,
      })
    }
  })
}

export function saveLastPrompt(
  ctx: Context,
  agent: Agent,
  input: SaveLastPromptInput,
): Promise<PromptEditReceipt> {
  try {
    assertText(input.text)
    if (!Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0) {
      throw new PromptEditError('PROMPT_UNSUPPORTED', 'expectedSeq must be a non-negative integer')
    }
  } catch (error: unknown) {
    return Promise.reject(error)
  }
  return runWhenIdle(agent as AgentLike, async signal => {
    signal.throwIfAborted()
    const typedAgent = agent as AgentLike
    ensureSessionAttached(ctx, typedAgent)
    rejectSubagent(typedAgent)
    const target = findPrompt(typedAgent)
    if (String(target.data.id) !== input.messageId || Number(target.seq) !== input.expectedSeq) {
      throw new PromptEditError('PROMPT_CHANGED', 'the prompt changed while it was being edited')
    }
    const replacement: UserMessage = {
      ...target.data,
      content: replaceText(target.data.content, input.text),
    }
    try {
      signal.throwIfAborted()
      const event = typedAgent.session.append('user/message', replacement, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq],
      })
      await ctx.sessions.flush(typedAgent.session)
      return snapshot(event)
    } catch (error: unknown) {
      if (error instanceof PromptEditError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new PromptEditError('EDIT_FAILED', message || 'failed to save prompt', { cause: error })
    }
  })
}
