import type { Context } from '@deepseek-ai/cordis'
import { handleTurnDelete, handlePromptEdit, TURN_DELETE_PATH, PROMPT_EDIT_PATH } from './http.ts'
import { deletedTurnsProjectionDefinition, type DeletedTurnsProjectionRegistry } from './deleted-turns-projection.ts'
export { loadLastPrompt, saveLastPrompt, resendLastPrompt, PromptEditError } from './prompt-edit.ts'

export { TURN_DELETE_PATH, PROMPT_EDIT_PATH } from './http.ts'
export {
  deleteTurn,
  appendDeletionMarker,
  deletedTurnOf,
  isTurnDeleteEvent,
  tombstoneSource,
  TOMBSTONE_MODEL,
  TOMBSTONE_PROVIDER,
  TurnDeleteError,
  type TurnDeleteErrorCode,
  type TurnDeleteReceipt,
} from './turn-delete.ts'

export const name = 'conversation-controls'
export const inject = ['sessions', 'agents', 'webServer']

export function apply(ctx: Context): void {
  // Optional child dependency: old hosts still expose the deletion/edit routes.
  ctx.inject(['sessionProjections'] as never, scope => {
    const registry = (scope as unknown as { sessionProjections: DeletedTurnsProjectionRegistry }).sessionProjections
    registry.register(deletedTurnsProjectionDefinition)
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TURN_DELETE_PATH,
    handler: (request, response) => handleTurnDelete(ctx, request, response),
  }), 'conversation-controls: delete route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PROMPT_EDIT_PATH,
    handler: (request, response) => handlePromptEdit(ctx, request, response),
  }), 'conversation-controls: prompt route')
}
