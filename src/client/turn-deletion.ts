import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isDeletionMarker, type DeletionMarkerEvent } from '../shared.ts'

export interface DeletedTurnData {
  readonly hidden: true
  readonly turn: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    'turn-delete': DeletedTurnData
  }
}

/** Read only explicitly identified deletion markers, including legacy formats. */
function deletedTurn(event: DeletionMarkerEvent): number | undefined {
  if (!isDeletionMarker(event)) return undefined
  const turn = event.data?.deletedTurn ?? event.data?.turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined
}

interface DeletedTurnState {
  readonly turn: number
}

export const turnDeletionDefinition: ConversationNodeDefinition<DeletedTurnState> = {
  kind: 'turn-delete',
  match: (event) => {
    const turn = deletedTurn(event as unknown as DeletionMarkerEvent)
    return turn === undefined ? null : { id: String(turn), role: 'start' }
  },
  start: (_context, match) => {
    const turn = deletedTurn(match.event as unknown as DeletionMarkerEvent)
    if (turn === undefined) throw new Error('turn-delete start requires a deletion tombstone')
    return { turn }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildLocationData: (context, scope) => {
    if (scope !== 'turn' || context.state === undefined) return null
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'turn-delete',
      value: { hidden: true, turn: context.state.turn },
    }
  },
}

/** Structural owner face of the turn-tail chain slot (the plugin only reads the turn). */
export interface TurnTailOwner {
  readonly turn: {
    readonly data: {
      get(key: 'turn-delete'): DeletedTurnData | undefined
    }
  }
}

export function selectDeletedTurn(owner: TurnTailOwner): DeletedTurnData | null {
  const data = owner.turn.data.get('turn-delete')
  return data?.hidden === true ? data : null
}
