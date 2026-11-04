import type { MessageId } from '@deepseek-ai/dsh-llm'
import { PROMPT_EDIT_PATH, TURN_DELETE_PATH } from '../shared.ts'
import type { ClientContext } from './context.ts'
import { DeletedTurnMarker } from './DeletedTurnMarker.tsx'
import { en, zh } from './locales.ts'
import type { PromptEditResponse } from './PromptEditAction.tsx'
import { REQUEST_RESULT_UNKNOWN, TurnDeleteAction, type DeleteTurnResponse } from './TurnDeleteAction.tsx'
import { selectDeletedTurn, turnDeletionDefinition } from './turn-deletion.ts'
import { installTurnNavigationFilter } from './turn-navigation.tsx'
import { installPromptEditPlacement, PROMPT_EDIT_FACTORY } from './prompt-edit-placement.tsx'
import { PromptResendAction, type PromptResendResponse } from './PromptResendAction.tsx'

const NS = 'turn-delete'

export const inject = ['slots', 'locale', 'uiConversation']

const REQUEST_TIMEOUT_MS = 10_000

async function postJson<T>(path: string, body: Record<string, unknown>, label: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const value = await response.json() as T & { ok?: unknown }
    if (typeof value !== 'object' || value === null || typeof value.ok !== 'boolean') {
      throw new Error(`${label} returned HTTP ${String(response.status)}`)
    }
    return value
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(REQUEST_RESULT_UNKNOWN)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function postDelete(sessionId: string, assistantMessageId: MessageId): Promise<DeleteTurnResponse> {
  return postJson<DeleteTurnResponse>(TURN_DELETE_PATH, { sessionId, assistantMessageId }, 'turn deletion')
}

async function postPrompt(body: Record<string, unknown>): Promise<PromptEditResponse> {
  return postJson<PromptEditResponse>(PROMPT_EDIT_PATH, body, 'prompt edit')
}

export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(turnDeletionDefinition)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turn-delete: dictionaries')
  if (ctx.slots.registerFactory !== undefined) {
    ctx.slots.registerFactory({
      name: PROMPT_EDIT_FACTORY,
      scope: 'session',
      locale: NS,
      inject: sessionId => ({
        loadPrompt: () => postPrompt({ sessionId, action: 'load' }),
        resendPrompt: (messageId: MessageId, expectedSeq: number, text: string) =>
          postJson<PromptResendResponse>(PROMPT_EDIT_PATH, { sessionId, action: 'resend', messageId, expectedSeq, text }, 'prompt resend'),
      }),
    }, PromptResendAction)

  }
  ctx.effect(() => {
    const restoreNavigation = installTurnNavigationFilter(ctx.slots)
    const restorePlacement = ctx.slots.registerFactory === undefined ? () => {} : installPromptEditPlacement(ctx.slots)
    return () => { restorePlacement(); restoreNavigation() }
  }, 'conversation-controls: chat adapters')
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'turn-delete',
      order: 90,
      locale: NS,
      inject: sessionId => ({
        deleteTurn: (assistantMessageId: MessageId) => postDelete(sessionId, assistantMessageId),
      }),
    }, TurnDeleteAction))
  ctx.slots.inject('conversation.chat.turnTail', () =>
    ctx.slots.register({
      name: 'conversation.chat.turnTail',
      // DSH 0.2.0-rc.1 made `id` mandatory for list slots: registering without
      // one throws `list slot "<name>" requires options.id`, which fails this
      // plugin's whole `apply` and silently removes the delete action above too.
      id: 'turn-delete',
      order: 50,
      select: selectDeletedTurn,
    }, DeletedTurnMarker))
}
