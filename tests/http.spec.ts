import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { handleTurnDelete, handlePromptEdit, requestJson } from '../src/http.ts'

function request(body: string, method = 'POST', contentType = 'application/json') {
  return { method, headers: { 'content-type': contentType }, readableEnded: false,
    async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(body); this.readableEnded = true },
  }
}
function response() {
  return { status: 0, body: '', writeHead(status: number) { this.status = status }, end(body = '') { this.body = body } }
}
const ctx = { agents: { get: () => undefined } } as unknown as Context

describe('conversation controls HTTP', () => {
  it.each([false, true])('routes resend and exposes accurate recovery on failure=%s', async fail => {
    const local = new Context()
    await local.plugin(SessionStore)
    const session = local.sessions.create(SessionId(`http-resend-${fail}`))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const prompt = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    let sent = 0
    const agent = { session, status: 'idle', options: {}, inbox: { nextTurn: [], nextStep: [] },
      runMaintenance: (job: (signal: AbortSignal) => Promise<unknown>) => job(new AbortController().signal),
      send: () => { sent += 1 },
    }
    local.provide('agents', { get: () => agent } as unknown as Context['agents'])
    if (fail) local.sessions.flush = async () => { throw new Error('disk full') }
    const res = response()
    await handlePromptEdit(local, request(JSON.stringify({ action: 'resend', sessionId: session.id, messageId: prompt.data.id, expectedSeq: Number(prompt.seq), text: 'new' })), res)
    const body = JSON.parse(res.body)
    if (fail) {
      expect(res.status).toBe(500)
      expect(sent).toBe(0)
      expect(body).toMatchObject({ ok: false, error: { code: 'RESEND_FAILED', recovery: { phase: 'save', submitted: false, retryable: true, prompt: { text: 'new' } } } })
    } else {
      expect(res.status).toBe(200)
      expect(sent).toBe(1)
      expect(body).toMatchObject({ ok: true, value: { text: 'new', submitted: true } })
    }
  })

  it('handles a request whose data/end were already consumed by the WSL router', async () => {
    const body = JSON.stringify({ sessionId: 'diagnostic', assistantMessageId: 'last' })
    const req = request(body)
    for await (const _chunk of req) { /* router inspects session ownership */ }
    expect(req.readableEnded).toBe(true)
    req[Symbol.asyncIterator] = async function* () { yield new TextEncoder().encode(body) }
    const res = response()
    await handleTurnDelete(ctx, req, res)
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body).error.code).toBe('TARGET_NOT_FOUND')
  })

  it('decodes UTF-8 split across chunks and rejects oversized input', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: '修改提问' }))
    const req = { async *[Symbol.asyncIterator]() { for (const byte of bytes) yield new Uint8Array([byte]) } }
    expect(await requestJson(req)).toEqual({ text: '修改提问' })
    await expect(requestJson(request('x'.repeat(1024 * 1024 + 1)))).rejects.toThrow('too large')
  })

  it('returns a visible error for malformed input, wrong method and media type', async () => {
    for (const [req, status] of [
      [request('{bad'), 400], [request('[]'), 400],
      [request('{}', 'GET'), 405], [request('{}', 'POST', 'text/plain'), 415],
    ] as const) {
      const res = response()
      await handleTurnDelete(ctx, req, res)
      expect(res.status).toBe(status)
    }
  })

  it('returns a normal prompt response when the target session is absent', async () => {
    const res = response()
    await handlePromptEdit(ctx, request(JSON.stringify({ action: 'load', sessionId: 'missing' })), res)
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body).error.code).toBe('TARGET_NOT_FOUND')
  })
})
