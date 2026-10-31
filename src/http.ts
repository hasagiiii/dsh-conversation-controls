import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { deleteTurn, TurnDeleteError } from './turn-delete.ts'
import { loadLastPrompt, saveLastPrompt, resendLastPrompt, PromptEditError } from './prompt-edit.ts'

export { TURN_DELETE_PATH, PROMPT_EDIT_PATH } from './shared.ts'
const MAX_BODY_BYTES = 1024 * 1024

export interface HttpRequestLike extends AsyncIterable<Uint8Array | string> {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): void
}

export interface HttpServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: HttpRequestLike, response: HttpResponseLike) => void | Promise<void>
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context { webServer: HttpServerLike }
}

// The WSL router may already have consumed the IncomingMessage and replay its
// buffered body through Symbol.asyncIterator. Late data/end listeners never fire.
export async function requestJson(request: HttpRequestLike): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for await (const chunk of request) {
    bytes += typeof chunk === 'string' ? new TextEncoder().encode(chunk).length : chunk.byteLength
    if (bytes > MAX_BODY_BYTES) throw new TypeError('request body is too large')
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }
  text += decoder.decode()
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('request body must be an object')
  }
  return value as Record<string, unknown>
}

function stringField(input: Record<string, unknown>, name: string): string {
  const value = input[name]
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function respondJson(response: HttpResponseLike, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function handle(
  request: HttpRequestLike,
  response: HttpResponseLike,
  action: (input: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  const contentType = request.headers?.['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    respondJson(response, 415, { ok: false, error: { code: 'INVALID_REQUEST', message: 'application/json required' } })
    return
  }
  try {
    const value = await action(await requestJson(request))
    respondJson(response, 200, { ok: true, value })
  } catch (error: unknown) {
    if (error instanceof TurnDeleteError || error instanceof PromptEditError) {
      const status = error.code === 'AGENT_BUSY' ? 423
        : error.code === 'DELETE_FAILED' || error.code === 'EDIT_FAILED' || error.code === 'RESEND_FAILED' ? 500 : 409
      respondJson(response, status, { ok: false, error: {
        code: error.code, message: error.message,
        ...(error instanceof PromptEditError && error.recovery !== undefined ? { recovery: error.recovery } : {}),
      } })
    } else {
      respondJson(response, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

export async function handleTurnDelete(ctx: Context, request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
  return handle(request, response, async input => {
    const agent = ctx.agents.get(SessionId(stringField(input, 'sessionId')))
    if (agent === undefined) throw new TurnDeleteError('TARGET_NOT_FOUND', 'Session is not active')
    return deleteTurn(ctx, agent, MessageId(stringField(input, 'assistantMessageId')))
  })
}

export async function handlePromptEdit(ctx: Context, request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
  return handle(request, response, async input => {
    const agent = ctx.agents.get(SessionId(stringField(input, 'sessionId')))
    if (agent === undefined) throw new PromptEditError('TARGET_NOT_FOUND', 'Session is not active')
    if (input.action === 'load') return loadLastPrompt(ctx, agent)
    if (input.action !== 'save' && input.action !== 'resend') throw new TypeError('action must be load, save or resend')
    if (!Number.isSafeInteger(input.expectedSeq) || (input.expectedSeq as number) < 0) {
      throw new TypeError('expectedSeq must be a non-negative integer')
    }
    return (input.action === 'resend' ? resendLastPrompt : saveLastPrompt)(ctx, agent, {
      messageId: stringField(input, 'messageId'),
      expectedSeq: input.expectedSeq as number,
      text: stringField(input, 'text'),
    })
  })
}
