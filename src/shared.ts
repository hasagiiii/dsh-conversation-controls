export const TURN_DELETE_PATH = '/dsh-conversation-controls/delete'
export const PROMPT_EDIT_PATH = '/dsh-conversation-controls/prompt'
/**
 * Identity stamped on every deletion tombstone.
 *
 * Session format v3 wrote the bare `source.plugin` of a `system/message`; the
 * legacy `assistant/message` tombstones (DSH <= 0.1.2 era) used it as the
 * provider instead, so one constant covers every generation.
 */
export const TOMBSTONE_PLUGIN = 'dsh-turn-delete'
/**
 * Source kind session format v4 (DSH 0.2.x) forces on every `system/message`.
 *
 * v4 validates message sources by *role*, not by producer: a system message must
 * be `system-prompt`, an assistant message must be `model` plus provider/model
 * ("seed system/message … message must have system-prompt source"). The v3→v4
 * migration additionally rejects the legacy bare `plugin` kind outright ("format
 * v4 message requires a producer-owned source kind"). A v4 deletion tombstone
 * therefore carries no producer identity in its source. Its explicit deletion
 * metadata or resend message ID identifies it, while v3 keeps `source.plugin`, because the
 * 0.1.x seed validator demands it ("seed system/message … message must have
 * plugin source").
 */
export const SYSTEM_PROMPT_SOURCE_KIND = 'system-prompt'
/** Legacy tombstone provider (`assistant/message` tombstones only). */
export const TOMBSTONE_PROVIDER = TOMBSTONE_PLUGIN
/** Legacy tombstone model (`assistant/message` tombstones only). */
export const TOMBSTONE_MODEL = 'tombstone'

/** Structural event shape shared by the projection and paginated client replay. */
export interface DeletionMarkerEvent {
  readonly type: string
  readonly surfaceOp?: unknown
  readonly data?: {
    readonly turn?: number
    readonly deletedTurn?: number
    readonly maintenance?: boolean
    readonly message?: {
      readonly id?: string
      readonly content?: readonly unknown[]
      readonly source?: {
        readonly kind?: string
        readonly plugin?: string
        readonly provider?: string
        readonly model?: string
      }
    }
  }
}

/** Empty system-prompt replacements also occur during ordinary host cleanup. */
export function isDeletionMarker(event: DeletionMarkerEvent): boolean {
  if (event.type !== 'system/message' && event.type !== 'assistant/message') return false
  if (typeof event.surfaceOp !== 'object' || event.surfaceOp === null
    || !('op' in event.surfaceOp) || event.surfaceOp.op !== 'replace') return false
  const message = event.data?.message
  if (!Array.isArray(message?.content) || message.content.length !== 0) return false
  const source = message.source
  if (source === undefined) return false
  if (event.type === 'assistant/message') {
    return source.kind === 'model' && source.provider === TOMBSTONE_PROVIDER && source.model === TOMBSTONE_MODEL
  }
  if (source.kind === 'plugin') return source.plugin === TOMBSTONE_PLUGIN
  if (source.kind !== SYSTEM_PROMPT_SOURCE_KIND) return false
  const target = event.data?.deletedTurn
  const explicitTarget = typeof target === 'number' && Number.isSafeInteger(target) && target >= 0
    && typeof event.data?.maintenance === 'boolean'
  return explicitTarget || (typeof message.id === 'string' && /^conversation-controls:resend:\d+$/.test(message.id))
}
