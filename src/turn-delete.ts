import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, type MessageId, type SystemMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isPromptEditEvent } from './prompt-edit.ts'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import {
  SYSTEM_PROMPT_SOURCE_KIND,
  TOMBSTONE_PLUGIN,
  isDeletionMarker,
} from './shared.ts'

export {
  SYSTEM_PROMPT_SOURCE_KIND,
  TOMBSTONE_MODEL,
  TOMBSTONE_PLUGIN,
  TOMBSTONE_PROVIDER,
} from './shared.ts'

export type TurnDeleteErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'TURN_NOT_CLOSED'
  | 'TURN_COMPACTED'
  | 'AGENT_BUSY'
  | 'DELETE_FAILED'

export interface TurnDeleteReceipt {
  readonly turn: number
  readonly seq: number
}

export class TurnDeleteError extends Error {
  override readonly name = 'TurnDeleteError'

  constructor(readonly code: TurnDeleteErrorCode, message: string) {
    super(message)
  }
}

/** The message-producing event types a deletion tombstone may live on. */
type TombstoneEventType = 'system/message' | 'assistant/message'

type TombstoneEvent = SessionEvent<TombstoneEventType> & {
  surfaceOp: { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
}

/**
 * Whether one event is a turn-deletion tombstone written by this plugin.
 *
 * Current kernels write a `system/message` replacement: it is the only surface
 * event type that both cites `sourceEventSeqs` (required to shadow a range) and
 * projects to no wire message (empty system content is dormant). Session format
 * v4 (DSH 0.2.x) forces `source.kind === "system-prompt"` on every system message
 * (measured against the real 0.2.0-rc.1 kernel), so v4 needs explicit deletion
 * metadata or a plugin-owned message ID. Ordinary system cleanup uses the same
 * empty replacement shape. v3 and pre-0.2 sources carry our identity. DSH 0.1.5 forbids
 * `sourceEventSeqs` on `assistant/message`, so the older tombstone shape is
 * read-only replay compatibility: recognizing it keeps old deletions idempotent
 * and keeps them hidden in the browser.
 */
export function isTurnDeleteEvent(event: SessionEvent): event is TombstoneEvent {
  if (event.type !== 'system/message' && event.type !== 'assistant/message') return false
  return isDeletionMarker(event)
}

/**
 * Session format that validates message sources by role instead of by producer.
 *
 * Format 4 (DSH 0.2.x) requires `system-prompt` on every `system/message` and
 * rejects the legacy bare `plugin` kind at admission, while the 0.1.x seed
 * validator requires exactly the opposite ("seed system/message … message must
 * have plugin source"). The tombstone therefore has to match the log it lands in.
 */
const ROLE_SOURCE_FORMAT = 4

/**
 * Source stamped on a deletion tombstone for one session format version.
 *
 * Format 4+ carries no producer identity in the source; deletion metadata or
 * the resend message ID identifies the marker. Older logs use `source.plugin`,
 * which their validators demand. Exported for tests and hosts; see
 * {@link ROLE_SOURCE_FORMAT}.
 */
export function tombstoneSource(formatVersion: number | undefined): {
  kind: string
  plugin?: string
} {
  return formatVersion !== undefined && formatVersion >= ROLE_SOURCE_FORMAT
    ? { kind: SYSTEM_PROMPT_SOURCE_KIND }
    : { kind: 'plugin', plugin: TOMBSTONE_PLUGIN }
}

function sessionFormatVersion(session: unknown): number | undefined {
  const header = (session as { header?: { version?: unknown } } | null | undefined)?.header
  const version = header?.version
  return typeof version === 'number' && Number.isFinite(version) ? version : undefined
}

/**
 * Build the deletion tombstone message for one session.
 *
 * `createSystemMessage` also changed shape across kernel lines: 0.1.x takes the
 * plugin name and emits `{ kind: "plugin", plugin }`, 0.2.x takes no plugin and
 * emits `{ kind: "system-prompt" }`. Both are overridden here, so the source
 * always matches the session's own format (the message is rebuilt as a plain
 * object because kernel messages are frozen). The extra argument satisfies the
 * 0.1.x signature and is ignored by 0.2.x.
 */
const createSystemMessageCompat = createSystemMessage as (
  text: string,
  plugin?: string,
) => ReturnType<typeof createSystemMessage>

function createTombstoneMessage(session: unknown): ReturnType<typeof createSystemMessage> {
  return {
    ...createSystemMessageCompat('', TOMBSTONE_PLUGIN),
    source: tombstoneSource(sessionFormatVersion(session)),
  } as unknown as ReturnType<typeof createSystemMessage>
}

/** The historical target is distinct from the lifecycle carrying new v4 markers. */
export function deletedTurnOf(event: SessionEvent<'system/message' | 'assistant/message'>): number {
  return (event.data as { deletedTurn?: number }).deletedTurn ?? event.data.turn
}

export function markerTurns(event: SessionEvent<'system/message' | 'assistant/message'>): readonly number[] {
  const target = deletedTurnOf(event)
  return (event.data as { maintenance?: boolean }).maintenance === true
    ? [target, event.data.turn] : [target]
}

type MaintenancePhase = { kind: 'maintenance'; lastTurn: number }

/** DSH 0.2.1 keeps a private counter in the lease; fail closed on other shapes. */
export function validateDeletionMaintenance(agent: Agent): MaintenancePhase | undefined {
  if ((sessionFormatVersion(agent.session) ?? 3) < 4) return undefined
  const phase = (agent as unknown as { phase?: MaintenancePhase }).phase
  const writable = phase && Object.getOwnPropertyDescriptor(phase, 'lastTurn')?.writable
  const boundary = sessionEvents(agent.session).findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (!phase || phase.kind !== 'maintenance' || writable !== true
    || !Number.isSafeInteger(phase.lastTurn) || phase.lastTurn < 0
    || phase.lastTurn !== (boundary?.data.turn ?? 0)) {
    throw new Error('host does not support synchronized deletion maintenance')
  }
  if (boundary?.type === 'turn/start') throw new Error('cannot write a deletion marker inside an unfinished turn')
  const head = sessionEvents(agent.session).find(event => event.seq === agent.session.surface.nodes[0])
  if (head?.type !== 'system/message') throw new Error('session has no protected system head for a deletion marker')
  return phase
}

/** Write v4 maintenance messages inside a complete, new lifecycle transaction. */
export function appendDeletionMarker(
  agent: Agent, targetTurn: number, legacyStep: number,
  message: SystemMessage, selected: readonly SessionSeq[],
): SessionEvent<'system/message'> {
  const session = agent.session
  const phase = validateDeletionMaintenance(agent)
  const first = selected[0]
  const last = selected.at(-1)
  if (first === undefined || last === undefined) throw new Error('deletion requires a surface span')
  const options = {
    surfaceOp: { op: 'replace' as const, startSeq: first, endSeq: last },
    sourceEventSeqs: [...selected],
  }
  if ((sessionFormatVersion(session) ?? 3) < 4) {
    return session.append('system/message', { turn: targetTurn, step: legacyStep, message }, options)
  }
  const turn = phase!.lastTurn + 1
  if (!Number.isSafeInteger(turn)) throw new Error('session turn counter is exhausted')
  const data = { turn, step: 1, message, deletedTurn: targetTurn, maintenance: true }
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const marker = session.append('system/message', data, options)
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  // runMaintenance restores idle from this same object and send() may already
  // have requested a wakeup. Synchronize before the lease can wake the driver.
  phase!.lastTurn = turn
  return marker
}

function eventTurn(event: SessionEvent): number | undefined {
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.turn
  return undefined
}

/**
 * Read a Session's event array.
 *
 * DSH 0.1.2-alpha.1 removed the `Session.events` property; the public API is
 * `snapshotEvents()` (plus `ownEvents()` / `eventAt(seq)`). Reading through
 * this helper keeps one build readable on both kernels.
 */
function sessionEvents(session: {
  snapshotEvents?: () => readonly SessionEvent[]
  events?: readonly SessionEvent[]
}): readonly SessionEvent[] {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

function turnBracket(
  events: readonly SessionEvent[],
  turn: number,
  targetSeq: SessionSeq,
): { start: number; end: number } | undefined {
  const start = events.findLast(event =>
    event.seq <= targetSeq && event.type === 'turn/start' && event.data.turn === turn)
  const end = events.find(event =>
    event.seq >= targetSeq && event.type === 'turn/end' && event.data.turn === turn)
  return start === undefined || end === undefined ? undefined : { start: start.seq, end: end.seq }
}

function originBelongsToTurn(
  event: SessionEvent,
  turn: number,
  bracket: { start: number; end: number },
): boolean {
  return (event.seq > bracket.start && event.seq < bracket.end) || eventTurn(event) === turn
}

/**
 * Whether one event carries the Session's system-prompt state rather than turn
 * content.
 *
 * The kernel appends the system prompt lazily, so the first turn's bracket can
 * contain surface node 0. Node 0 is protected: a replacement spanning it is
 * rejected unless it is a single-node `system/message` replacement, and the
 * prompt is infrastructure the Session must keep. Excluding system nodes from
 * the turn's origin set keeps the prompt out of the replaced span while the
 * remaining turn nodes stay contiguous.
 */
function isSystemPromptEvent(event: SessionEvent): boolean {
  return event.type === 'system/message'
}

function surfaceOrigins(
  seq: number,
  events: readonly SessionEvent[],
  memo: Map<number, ReadonlySet<number>>,
  visiting = new Set<number>(),
): ReadonlySet<number> {
  const cached = memo.get(seq)
  if (cached !== undefined) return cached
  if (visiting.has(seq)) return new Set()
  visiting.add(seq)
  const event = events[seq]
  const origins = new Set<number>()
  if (event !== undefined) {
    if (isAppendSurfaceEvent(event)) origins.add(seq)
    const sources = (event as SessionEvent & { sourceEventSeqs?: readonly number[] }).sourceEventSeqs ?? []
    for (const source of sources) {
      for (const origin of surfaceOrigins(source, events, memo, visiting)) origins.add(origin)
    }
  }
  visiting.delete(seq)
  memo.set(seq, origins)
  return origins
}

async function deleteUnderMaintenance(
  ctx: Context,
  agent: Agent,
  assistantMessageId: MessageId,
  signal: AbortSignal,
): Promise<TurnDeleteReceipt> {
  signal.throwIfAborted()
  const session = agent.session
  if (ctx.sessions.get(session.id) !== session) {
    throw new TurnDeleteError('TARGET_NOT_FOUND', `session "${session.id}" is no longer live`)
  }
  const events = sessionEvents(session)
  const target = events.find((event): event is SessionEvent<'assistant/message'> =>
    event.type === 'assistant/message'
    && isAppendSurfaceEvent(event)
    && event.data.message.id === assistantMessageId)
  if (target === undefined) {
    throw new TurnDeleteError('TARGET_NOT_FOUND', `assistant message "${assistantMessageId}" was not found`)
  }
  const turn = target.data.turn
  const existing = events.find(event => isTurnDeleteEvent(event) && deletedTurnOf(event) === turn)
  if (existing !== undefined) {
    await ctx.sessions.flush(session)
    return { turn, seq: existing.seq }
  }

  const bracket = turnBracket(events, turn, target.seq)
  if (bracket === undefined) {
    throw new TurnDeleteError('TURN_NOT_CLOSED', `turn ${String(turn)} is not closed`)
  }

  const originSeqs = new Set<number>(events
    .filter(event => !isSystemPromptEvent(event)
      && isAppendSurfaceEvent(event)
      && originBelongsToTurn(event, turn, bracket))
    .map(event => event.seq))
  const currentNodes = session.surface.nodes
  if (!currentNodes.includes(target.seq)) {
    throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} is no longer independently deletable`)
  }

  const memo = new Map<number, ReadonlySet<number>>()
  const selected: SessionSeq[] = []
  const covered = new Set<number>()
  for (const seq of currentNodes) {
    const origins = surfaceOrigins(seq, events, memo)
    const targetOrigins = [...origins].filter(origin => originSeqs.has(origin))
    if (targetOrigins.length === 0) continue
    if ([...origins].some(origin => !originSeqs.has(origin))) {
      throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} shares a compacted surface node`)
    }
    const current = events[seq]
    if (current !== undefined && !originSeqs.has(seq)
      && !(current.type === 'tool/result' && current.data.turn === turn)
      && !isPromptEditEvent(current, events)) {
      throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} contains a non-local replacement`)
    }
    selected.push(seq)
    for (const origin of targetOrigins) covered.add(origin)
  }
  if ([...originSeqs].some(origin => !covered.has(origin)) || selected.length === 0) {
    throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} is partially compacted`)
  }
  const positions = selected.map(seq => currentNodes.indexOf(seq))
  const first = positions[0]
  if (first === undefined || positions.some((position, index) => position !== first + index)) {
    throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} is not a contiguous surface span`)
  }
  const firstSeq = selected[0]
  const lastSeq = selected.at(-1)
  if (firstSeq === undefined || lastSeq === undefined) {
    throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} has no deletable surface span`)
  }

  signal.throwIfAborted()
  const tombstone = appendDeletionMarker(
    agent, turn, target.data.step, createTombstoneMessage(session), selected,
  )
  await ctx.sessions.flush(session)
  return { turn, seq: tombstone.seq }
}

const BUSY_PHASE_RE = /already has active work/i

/**
 * Run one maintenance job, tolerating a status that has not returned to idle yet.
 *
 * `agent.runMaintenance` rejects synchronously while the agent phase is anything
 * but `idle` (`agent "<id>" already has active work`), which can outlive the turn
 * the UI already shows as finished. Wait briefly for idle and retry once; a
 * phase that remains busy is reported to the caller without bypassing the lease.
 *
 * Failures raised *inside* the job are never retried: only the maintenance claim
 * itself can report a busy phase.
 */
async function runMaintenanceIdleAware<T>(
  agent: Agent,
  job: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let insideJob = false
  const wrapped = (signal: AbortSignal): Promise<T> => {
    insideJob = true
    return job(signal)
  }
  try {
    return await agent.runMaintenance(wrapped)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (insideJob || !BUSY_PHASE_RE.test(message)) throw error
    await Promise.race([
      Promise.resolve().then(() => agent.whenIdle()).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ])
    return await agent.runMaintenance(wrapped)
  }
}

export async function deleteTurn(
  ctx: Context,
  agent: Agent,
  assistantMessageId: MessageId,
): Promise<TurnDeleteReceipt> {
  try {
    try {
      return await runMaintenanceIdleAware(agent, signal =>
        deleteUnderMaintenance(ctx, agent, assistantMessageId, signal))
    } catch (error: unknown) {
      if (error instanceof TurnDeleteError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (!BUSY_PHASE_RE.test(message)) throw error
      // Another maintenance job also reports idle; never bypass its lease.
      throw new TurnDeleteError('AGENT_BUSY', message)
    }
  } catch (error: unknown) {
    if (error instanceof TurnDeleteError) throw error
    // Everything else is an internal failure (kernel/plugin incompatibility,
    // invalid stored metadata, …). It must never surface as "the task is
    // running": that wording sent every real failure to the wrong diagnosis.
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`turn-delete: deleting a turn from session "${agent.session.id}" failed: ${message}`)
    throw new TurnDeleteError('DELETE_FAILED', message)
  }
}
