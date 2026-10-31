import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { isTurnDeleteEvent } from './turn-delete.ts'

/** Whole-log deletion state, independent of the browser's loaded event window. */
export const DELETED_TURNS_PROJECTION_KEY = 'conversationControlsDeletedTurns'

const deletedTurnsSchema = z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .refine(turns => turns.every((turn, index) => index === 0 || turn > turns[index - 1]!), {
    message: 'deleted turns must be strictly increasing',
  })

/**
 * The registry folds every committed event and persists this JSON-safe state.
 * Retain the same array for unrelated events and repeated tombstones: the
 * projection change feed uses reference identity to avoid redundant updates.
 */
export const deletedTurnsProjectionDefinition = {
  key: DELETED_TURNS_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: deletedTurnsSchema,
  init: (): readonly number[] => [],
  apply: (state: readonly number[], event: SessionEvent): readonly number[] => {
    if (!isTurnDeleteEvent(event)) return state
    const turn = event.data.turn
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0 || state.includes(turn)) {
      return state
    }
    return [...state, turn].sort((left, right) => left - right)
  },
  wire: {
    viewSchema: deletedTurnsSchema,
    view: (state: readonly number[]): readonly number[] => state,
  },
}

/** Structural service face keeps the plugin loadable on pre-projection hosts. */
export interface DeletedTurnsProjectionRegistry {
  register(definition: typeof deletedTurnsProjectionDefinition): () => void
}
