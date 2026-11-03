/**
 * Strict v4 artifact regression, using an extracted REAL DSH host.
 * Usage: DSH_V4_ROOT=/path/to/extracted/dsh node scripts/check-v4.mjs
 * Build lib first. Defaults to .scratch/v4-host/dsh. No network or model API.
 * Optional: DSH_V4_BASELINE_LIB=/path/to/old/index.js tests the actual old
 * bundle as an additional negative control (the old-shape control always runs).
 * All @deepseek-ai imports (including those in the built plugin) are resolved
 * against that host; silently testing the old devDependencies is forbidden.
 */
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const hostRoot = path.resolve(process.env.DSH_V4_ROOT ?? path.join(root, '.scratch/v4-host/dsh'))
const hostRequire = createRequire(path.join(hostRoot, 'package.json'))
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL(path.join(hostRoot, 'package.json')).href })
  }
  return nextResolve(specifier, context)
} })
const [kernel, llm, { sessionFormatCatalog: catalog }, plugin] = await Promise.all([
  import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-llm'),
  import('@deepseek-ai/dsh-session-format-catalog'), import('../lib/index.js'),
])
const { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } = kernel
const { createSystemMessage, createUserMessage, createAssistantMessage } = llm
assert.equal(SESSION_FORMAT_VERSION, 4, 'DSH_V4_ROOT must contain a v4 host')
for (const name of ['deleteTurn', 'saveLastPrompt', 'loadLastPrompt', 'resendLastPrompt']) {
  assert.equal(typeof plugin[name], 'function', `Rebuild lib with ${name} exported`)
}
let deletionProjection
plugin.apply({
  inject(_dependencies, callback) {
    callback({ sessionProjections: { register(definition) { deletionProjection = definition; return () => {} } } })
  },
  effect() {},
})
assert.equal(deletionProjection?.key, 'conversationControlsDeletedTurns')
function hiddenTurns(session) {
  return events(session).reduce((state, event) => deletionProjection.apply(state, event), deletionProjection.init())
}
const scratch = path.join(root, '.scratch')
await mkdir(scratch, { recursive: true })
const output = await mkdtemp(path.join(scratch, 'check-v4-'))
// The host does not export its concrete driver. Evaluate its verbatim class
// body, without editing host files; the network/system-prompt collaborators
// below are stubbed, but maintenance, wakeDriver, kick, turn and whenIdle are
// the actual installed implementation. Constructor-only collaborators are not
// needed because this focused fixture attaches to an already-populated log.
const loopPath = hostRequire.resolve('@deepseek-ai/dsh-agent-loop')
const loopSource = await readFile(loopPath, 'utf8')
const classStart = loopSource.indexOf('var ReactLoopAgent = class {')
const classEnd = loopSource.indexOf('\n//#endregion', classStart)
assert(classStart >= 0 && classEnd > classStart, 'Host Agent implementation changed; update driver extraction explicitly')
const HostAgent = new Function('abortedCancelCause', 'LlmError', 'errorChain', 'ToolCallRecovery',
  `${loopSource.slice(classStart, classEnd)}; return ReactLoopAgent`)(
    signal => signal.aborted ? signal.reason : undefined, llm.LlmError, llm.errorChain, kernel.ToolCallRecovery)
let checks = 0
function pass(label) { checks++; console.log(`PASS ${label}`) }
function events(session) { return session.snapshotEvents() }
function lastTurn(session) { return events(session).findLast(e => e.type === 'turn/start')?.data.turn ?? 0 }
function newSession(name) {
  const id = SessionId(`check-v4-${name}`)
  return Session.create(id, [], { version: 4, id, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 })
}
function appendTurn(session, question, answer, { continuation = false } = {}) {
  const turn = lastTurn(session) + 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  if (session.surface.nodes.length === 0) session.append('system/message', {
    turn, step: 1, message: createSystemMessage('Regression system prompt'),
  }, { surfaceOp: 'append' })
  if (!continuation) session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: question }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', {
    turn, step: 1, message: createAssistantMessage({
      content: [{ type: 'text', text: answer }], source: { provider: 'regression', model: 'offline' },
    }), stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return assistant
}
function encode(session) {
  return [catalog.encodeCurrentHeader(session.header, session.inheritedEventCount),
    ...events(session).map(e => catalog.encodeCurrentEvent(e))]
    .map(row => JSON.stringify(row)).join('\n') + '\n'
}
function restore(text) {
  const [header, ...rows] = text.trimEnd().split('\n').map(line => JSON.parse(line))
  const reader = catalog.createRestore(header, { validation: 'current', recovery: 'strict' })
  for (const row of rows) reader.decodeRow(row)
  const artifact = reader.finish() // invokes official restoreCurrent/lifecycle validation
  return Session.fromRestore(SessionId(artifact.header.id), artifact.events, artifact.header,
    SessionLogOffset(artifact.inheritedEventCount), 'detached')
}
let serial = 0
async function roundTrip(session, label) {
  const file = path.join(output, `${String(++serial).padStart(3, '0')}-${label}.jsonl`)
  await writeFile(file, encode(session), 'utf8')
  const restored = restore(await readFile(file, 'utf8'))
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages(), `${label}: messages changed after strict restore`)
  assert.deepEqual([...restored.surface.nodes], [...session.surface.nodes], `${label}: surface changed after strict restore`)
  assert.deepEqual(hiddenTurns(restored), hiddenTurns(session), `${label}: hidden turns changed after strict restore`)
  return restored
}
function fixture(session) {
  let failFlush = false
  const ctx = { sessions: { get: id => id === session.id ? session : undefined,
    async flush(current) {
      assert.equal(current, session)
      await roundTrip(session, 'flush')
      if (failFlush) { failFlush = false; throw new Error('injected persistence failure') }
    },
  } }
  const sent = []
  const agent = Object.create(HostAgent.prototype)
  Object.assign(agent, { session, id: session.id, options: {},
    phase: { kind: 'idle', lastTurn: lastTurn(session) }, activityDone: Promise.resolve(),
    inbox: { nextTurn: [], nextStep: [] }, dispatch: { emit() {} },
    loopCtx: { agents: { withInitiator: (_agent, callback) => callback() } },
    // Other cases assert the enqueued message; the dedicated driver case below
    // restores actual send() and performs the actual next wake.
    send(message) { sent.push(message); this.inbox.nextTurn.push(message) },
  })
  return { ctx, agent, sent, failNextFlush() { failFlush = true } }
}
function maintenanceMarkers(session) {
  return events(session).filter(e => e.type === 'system/message' && e.data.maintenance === true)
}
function assertBoundaries(session, targetTurns) {
  const log = events(session)
  const markers = maintenanceMarkers(session)
  assert.deepEqual(markers.map(e => e.data.deletedTurn), targetTurns)
  assert.deepEqual(hiddenTurns(session), [...new Set([...targetTurns, ...markers.map(e => e.data.turn)])].sort((a, b) => a - b),
    'built plugin projection must hide original and maintenance turns')
  for (const marker of markers) {
    const window = log.slice(marker.seq - 2, marker.seq + 3)
    assert.deepEqual(window.map(e => e.type), ['turn/start', 'step/start', 'system/message', 'step/end', 'turn/end'])
    assert.equal(marker.data.step, 1)
    assert.deepEqual(marker.data.message.content, [])
    assert.equal(marker.data.message.source.kind, 'system-prompt')
    assert(window.every(e => e.data.turn === marker.data.turn))
    const previous = log.slice(0, marker.seq - 2).findLast(e => e.type === 'turn/start')
    assert.equal(marker.data.turn, previous.data.turn + 1)
  }
}

// A physically valid old marker must fail strict lifecycle restoration. This
// negative control keeps the test honest if the restore path is weakened.
{
  const session = newSession('old-marker')
  appendTurn(session, 'old question', 'old response')
  const selected = [...session.surface.nodes].slice(1)
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, {
    surfaceOp: { op: 'replace', startSeq: selected[0], endSeq: selected.at(-1) }, sourceEventSeqs: selected,
  })
  assert.throws(() => restore(encode(session)), /turn|step|closed|active/i)
  pass('old closed-turn marker is rejected by official strict restore')
}
if (process.env.DSH_V4_BASELINE_LIB) {
  const baselinePath = path.resolve(process.env.DSH_V4_BASELINE_LIB)
  assert.notEqual(baselinePath, path.join(root, 'lib/index.js'), 'baseline must be a separately saved old build')
  const baseline = await import(pathToFileURL(baselinePath).href)
  assert.equal(typeof baseline.deleteTurn, 'function')
  const session = newSession('old-built-plugin')
  const target = appendTurn(session, 'old plugin question', 'old plugin response')
  const { ctx, agent } = fixture(session)
  ctx.sessions.flush = async () => {} // mirror old persistence, which accepted invalid relationships
  await baseline.deleteTurn(ctx, agent, target.data.message.id)
  assert.throws(() => restore(encode(session)), /turn|step|closed|active/i)
  pass('actual old built plugin deletion is rejected by official strict restore')
}
{
  const session = newSession('delete')
  const first = appendTurn(session, 'delete first', 'first response')
  const second = appendTurn(session, 'keep second', 'second response')
  const third = appendTurn(session, 'delete third', 'third response')
  const f = fixture(session)
  const receipt = await plugin.deleteTurn(f.ctx, f.agent, first.data.message.id)
  assert.equal(receipt.turn, 1)
  assert.equal(lastTurn(session), 4)
  const count = events(session).length
  assert.deepEqual(await plugin.deleteTurn(f.ctx, f.agent, first.data.message.id), receipt)
  assert.equal(events(session).length, count, 'delete retry must be idempotent')
  await plugin.deleteTurn(f.ctx, f.agent, third.data.message.id)
  assertBoundaries(session, [1, 3])
  assert.deepEqual(session.deriveMessages().filter(m => m.role === 'assistant').map(m => m.id), [second.data.message.id])
  await roundTrip(session, 'delete-final')
  pass('multiple deletes allocate latest turn + 1 and retry without appending')
}
{
  const session = newSession('delete-retry')
  const assistant = appendTurn(session, 'retry delete', 'response')
  const f = fixture(session)
  f.failNextFlush()
  await assert.rejects(plugin.deleteTurn(f.ctx, f.agent, assistant.data.message.id), /injected persistence failure/)
  const count = events(session).length
  await plugin.deleteTurn(f.ctx, f.agent, assistant.data.message.id)
  assert.equal(events(session).length, count)
  assertBoundaries(session, [1])
  pass('delete persistence failure retries the same durable marker')
}
{
  const session = newSession('save-resend')
  appendTurn(session, 'old prompt', 'old response')
  appendTurn(session, '', 'continued response', { continuation: true })
  const f = fixture(session)
  const prompt = await plugin.loadLastPrompt(f.ctx, f.agent)
  const saved = await plugin.saveLastPrompt(f.ctx, f.agent, { messageId: prompt.messageId, expectedSeq: prompt.seq, text: 'saved prompt' })
  await roundTrip(session, 'save-final')
  const result = await plugin.resendLastPrompt(f.ctx, f.agent, { messageId: saved.messageId, expectedSeq: saved.seq, text: 'resend prompt' })
  assert.equal(result.submitted, true)
  assert.equal(f.sent.length, 1)
  assertBoundaries(session, [1, 2])
  assert.equal(lastTurn(session), 4)
  assert.equal(session.deriveMessages().filter(m => m.role !== 'system').length, 0)
  await roundTrip(session, 'resend-prepared')
  pass('save and resend hide original and continuation turns with strict round trips')
}
{
  const session = newSession('resend-retry')
  appendTurn(session, 'retry prompt', 'old response')
  appendTurn(session, '', 'continued response', { continuation: true })
  const f = fixture(session)
  const prompt = await plugin.loadLastPrompt(f.ctx, f.agent)
  const originalFlush = f.ctx.sessions.flush
  let flushes = 0
  f.ctx.sessions.flush = async current => {
    await originalFlush(current)
    if (++flushes === 2) throw new Error('injected preparation flush failure')
  }
  let recovery
  await assert.rejects(plugin.resendLastPrompt(f.ctx, f.agent, {
    messageId: prompt.messageId, expectedSeq: prompt.seq, text: 'retry edited prompt',
  }), error => {
    recovery = error.recovery
    return recovery?.phase === 'prepare' && recovery.retryable && recovery.submitted === false
  })
  assert.equal(f.sent.length, 0)
  const reopened = await roundTrip(session, 'resend-restart')
  const resumed = fixture(reopened)
  const count = events(reopened).length
  const result = await plugin.resendLastPrompt(resumed.ctx, resumed.agent, {
    messageId: recovery.prompt.messageId, expectedSeq: recovery.prompt.seq, text: recovery.prompt.text,
  })
  assert.equal(result.submitted, true)
  assert.equal(resumed.sent.length, 1)
  assert.equal(events(reopened).length, count, 'prepared resend must not duplicate markers on retry')
  assertBoundaries(reopened, [1, 2])
  await roundTrip(reopened, 'resend-retry-final')
  pass('prepared resend retries after strict restore without duplicate maintenance turns')
}
{
  for (const [label, phase] of [
    ['missing', undefined],
    ['stale', { kind: 'maintenance', lastTurn: 0 }],
    ['readonly', Object.freeze({ kind: 'maintenance', lastTurn: 1 })],
  ]) {
    const session = newSession(`unsupported-counter-${label}`)
    const target = appendTurn(session, 'preserve unsupported host', 'response')
    const { ctx, agent } = fixture(session)
    agent.runMaintenance = async callback => {
      const previous = agent.phase
      agent.phase = phase
      try { return await callback(new AbortController().signal) }
      finally { agent.phase = previous }
    }
    const before = encode(session)
    await assert.rejects(plugin.deleteTurn(ctx, agent, target.data.message.id))
    assert.equal(encode(session), before, `${label}: delete must fail before any append`)
    const prompt = await plugin.loadLastPrompt(ctx, agent)
    await assert.rejects(plugin.resendLastPrompt(ctx, agent, {
      messageId: prompt.messageId, expectedSeq: prompt.seq, text: 'must not save',
    }))
    assert.equal(encode(session), before, `${label}: resend must fail before saving a revision`)
  }
  pass('unknown, stale and read-only maintenance counters fail before writing')
}
function enableRealWake(agent, { completeStep = false } = {}) {
  const pending = []
  agent.inbox = {
    nextTurn: pending, nextStep: [],
    get hasPending() { return pending.length > 0 },
    splice(target, index, removed, added) {
      assert.equal(target, 'next-turn')
      pending.splice(index, removed, ...added)
    },
  }
  delete agent.send // exercise the installed send/wakeDriver implementations
  // Reject at the real pre-step boundary: no credentials/network are needed,
  // and the actual turn method still writes a complete, strictly checked turn.
  agent.preStep = async () => { pending.length = 0; return { kind: 'reject' } }
  if (completeStep) {
    agent.ctx = { on: () => () => {} }
    agent.dispatch.serial = async () => {}
    agent.preStep = async () => ({ kind: 'enter', messages: pending.splice(0) })
    // Offline model seam: real turn() still owns step/start, step/end,
    // turn/end and its live counter. Only the provider/tool execution is fake.
    agent.step = async decision => {
      const { turn, step } = agent.phase
      for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
      agent.session.append('assistant/message', { turn, step,
        message: createAssistantMessage({ content: [{ type: 'text', text: `offline answer ${turn}` }],
          source: { provider: 'regression', model: 'offline' } }), stream: [],
      }, { surfaceOp: 'append' })
      return { kind: 'completed' }
    }
  }
}
{
  const session = newSession('counter-negative')
  appendTurn(session, 'counter control', 'response')
  const { agent } = fixture(session)
  enableRealWake(agent)
  await agent.runMaintenance(async () => appendTurn(session, '', 'untracked maintenance', { continuation: true }))
  assert.equal(agent.phase.lastTurn, 1, 'negative control requires the known host counter behavior')
  assert.equal(lastTurn(session), 2)
  agent.send(createUserMessage({ content: [{ type: 'text', text: 'next turn' }], source: { kind: 'user' } }), 'next-turn', true)
  await agent.whenIdle()
  assert.deepEqual(events(session).filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2, 2])
  assert.throws(() => restore(encode(session)), /turn|consecutive|increas/i)
  pass('real host maintenance without counter synchronization duplicates a turn and fails strict restore')
}
{
  const session = newSession('real-driver-delete')
  const target = appendTurn(session, 'real maintenance', 'response')
  const { ctx, agent } = fixture(session)
  enableRealWake(agent)
  await plugin.deleteTurn(ctx, agent, target.data.message.id)
  assert.equal(agent.phase.lastTurn, 2, 'plugin must synchronize the installed maintenance counter')
  await roundTrip(session, 'real-delete-before-wake')
  agent.send(createUserMessage({ content: [{ type: 'text', text: 'next real turn' }], source: { kind: 'user' } }), 'next-turn', true)
  await agent.whenIdle()
  assert.equal(agent.phase.lastTurn, 3)
  assert.deepEqual(events(session).filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2, 3])
  await roundTrip(session, 'real-delete-after-wake')
  pass('actual runMaintenance and actual next driver run keep strictly increasing turns')
}
{
  const session = newSession('real-driver-resend')
  appendTurn(session, 'real resend', 'response')
  appendTurn(session, '', 'continuation', { continuation: true })
  const { ctx, agent } = fixture(session)
  enableRealWake(agent)
  const prompt = await plugin.loadLastPrompt(ctx, agent)
  await plugin.resendLastPrompt(ctx, agent, {
    messageId: prompt.messageId, expectedSeq: prompt.seq, text: 'resend and wake',
  })
  await agent.whenIdle()
  assert.equal(agent.phase.lastTurn, 5)
  assert.deepEqual(events(session).filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2, 3, 4, 5])
  await roundTrip(session, 'real-resend-after-wake')
  pass('actual resend wakes after the maintenance lease with the next durable turn number')
}
{
  const session = newSession('reopen-and-continue')
  appendTurn(session, 'initial prompt', 'initial response')
  const f = fixture(session)
  enableRealWake(f.agent, { completeStep: true })
  const prompt = await plugin.loadLastPrompt(f.ctx, f.agent)
  await plugin.resendLastPrompt(f.ctx, f.agent, {
    messageId: prompt.messageId, expectedSeq: prompt.seq, text: 'first real resend',
  })
  await f.agent.whenIdle()
  assert.equal(f.agent.phase.lastTurn, 3)
  const reopened = await roundTrip(session, 'reopen-after-real-resend')
  const resumed = fixture(reopened)
  enableRealWake(resumed.agent, { completeStep: true })
  const current = await plugin.loadLastPrompt(resumed.ctx, resumed.agent)
  const saved = await plugin.saveLastPrompt(resumed.ctx, resumed.agent, {
    messageId: current.messageId, expectedSeq: current.seq, text: 'save after restart',
  })
  await plugin.resendLastPrompt(resumed.ctx, resumed.agent, {
    messageId: saved.messageId, expectedSeq: saved.seq, text: 'second real resend',
  })
  await resumed.agent.whenIdle()
  assert.equal(resumed.agent.phase.lastTurn, 5)
  const latestAnswer = reopened.deriveMessages().findLast(message => message.role === 'assistant')
  await plugin.deleteTurn(resumed.ctx, resumed.agent, latestAnswer.id)
  assert.equal(resumed.agent.phase.lastTurn, 6)
  resumed.agent.send(createUserMessage({ content: [{ type: 'text', text: 'fresh after delete' }],
    source: { kind: 'user' } }), 'next-turn', true)
  await resumed.agent.whenIdle()
  assert.equal(resumed.agent.phase.lastTurn, 7)
  assert.deepEqual(events(reopened).filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2, 3, 4, 5, 6, 7])
  assertBoundaries(reopened, [1, 3, 5])
  const visible = reopened.deriveMessages().filter(message => message.role !== 'system')
  assert.deepEqual(visible.map(message => message.role), ['user', 'assistant'])
  assert.equal(visible[0].content[0].text, 'fresh after delete')
  await roundTrip(reopened, 'repeated-real-wakes-after-restart')
  pass('resend, strict reopen, save, resend, delete and completed real driver turns remain restartable')
}
console.log(`Completed ${checks} strict v4 checks; artifacts: ${output}`)
