import { MessageId, createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import { z } from "zod";

//#region src/prompt-edit.ts
const MAX_TEXT_BYTES = 256 * 1024;
var PromptEditError = class extends Error {
	name = "PromptEditError";
	constructor(code, message, options, recovery) {
		super(message, options);
		this.code = code;
		this.recovery = recovery;
	}
};
const RESEND_MARKER = "conversation-controls:resend:";
/** A durable prepared resend keeps its edited input in the cited revision. */
function preparedResend(agent) {
	const events = sessionEvents$1(agent.session);
	const tail = agent.session.surface.nodes.at(-1);
	const marker = events.find((event) => event.seq === tail);
	if (marker?.type !== "system/message" || !String(marker.data.message.id).startsWith(RESEND_MARKER) || marker.data.message.content.length !== 0) return void 0;
	const sourceSeq = Number(String(marker.data.message.id).slice(29));
	const bySeq = new Map(events.map((event) => [Number(event.seq), event]));
	let current = marker;
	while (current !== void 0 && Number(current.seq) !== sourceSeq) {
		if (current.type !== "system/message" || current.data.message.id !== marker.data.message.id) return void 0;
		const operation = current.surfaceOp;
		if (typeof operation !== "object" || operation.op !== "replace" || Number(operation.startSeq) >= Number(current.seq) || current.sourceEventSeqs?.[0] !== operation.startSeq) return void 0;
		current = bySeq.get(Number(operation.startSeq));
	}
	const origin = latestOriginalPrompt(events);
	return current !== void 0 && isHumanPrompt(current) && isPromptEditEvent(current, events) && origin !== void 0 && replacementChainReaches(origin, current, events) ? current : void 0;
}
function sessionEvents$1(session) {
	if (typeof session.snapshotEvents === "function") return session.snapshotEvents();
	return session.events ?? [];
}
function isHumanPrompt(event) {
	if (event.type !== "user/message") return false;
	const source = event.data.source;
	return typeof source === "object" && source !== null && source.kind === "user";
}
function currentSurfaceUserPrompt(agent, events) {
	const bySeq = new Map(events.map((event) => [Number(event.seq), event]));
	for (let index = agent.session.surface.nodes.length - 1; index >= 0; index -= 1) {
		const seq = agent.session.surface.nodes[index];
		if (seq === void 0) continue;
		const event = bySeq.get(Number(seq));
		if (event !== void 0 && isHumanPrompt(event)) return event;
	}
}
function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}
/**
* Identify the single-node, same-message replacement emitted by this editor.
* Supplying the event log additionally verifies that the cited source is the
* same user message and source object; without it the marker shape is checked.
*/
function isPromptEditEvent(event, events) {
	if (!isHumanPrompt(event)) return false;
	const candidate = event;
	const operation = candidate.surfaceOp;
	if (typeof operation !== "object" || operation === null) return false;
	const replacement = operation;
	if (replacement.op !== "replace" || replacement.startSeq !== replacement.endSeq) return false;
	const sources = candidate.sourceEventSeqs;
	if (sources === void 0 || sources.length !== 1 || sources[0] !== replacement.startSeq) return false;
	if (events === void 0) return true;
	const source = events.find((item) => item.seq === sources[0]);
	return source !== void 0 && isHumanPrompt(source) && String(source.data.id) === String(event.data.id) && sameJson(source.data.source, event.data.source);
}
function latestOriginalPrompt(events) {
	return events.findLast((event) => isHumanPrompt(event) && isAppendSurfaceEvent(event));
}
function replacementChainReaches(origin, target, events) {
	if (origin.seq === target.seq) return true;
	const bySeq = new Map(events.map((event) => [Number(event.seq), event]));
	let current = target;
	const seen = /* @__PURE__ */ new Set();
	while (current.seq !== origin.seq) {
		const currentNumber = Number(current.seq);
		if (seen.has(currentNumber) || !isPromptEditEvent(current, events)) return false;
		seen.add(currentNumber);
		const sourceSeq = current.sourceEventSeqs[0];
		const previous = bySeq.get(Number(sourceSeq));
		if (previous === void 0) return false;
		current = previous;
	}
	return current === origin;
}
function textOf(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function attachmentCount(message) {
	return message.content.filter((block) => block.type === "image" || block.type === "file").length;
}
function snapshot(event) {
	return {
		messageId: String(event.data.id),
		seq: Number(event.seq),
		text: textOf(event.data),
		attachmentCount: attachmentCount(event.data)
	};
}
function assertText(text) {
	if (text.length === 0) throw new PromptEditError("PROMPT_UNSUPPORTED", "prompt text must not be empty");
	if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new PromptEditError("PROMPT_UNSUPPORTED", "prompt text exceeds 256 KiB");
}
function replaceText(content, text) {
	let replaced = false;
	const next = [];
	for (const block of content) {
		if (block.type !== "text") {
			next.push(block);
			continue;
		}
		if (!replaced) {
			next.push({
				type: "text",
				text
			});
			replaced = true;
		}
	}
	if (!replaced) next.unshift({
		type: "text",
		text
	});
	return next;
}
function ensureSessionAttached(ctx, agent) {
	const sessions = ctx.sessions;
	if (sessions === void 0 || typeof sessions.get !== "function" || sessions.get(agent.session.id) !== agent.session) throw new PromptEditError("TARGET_NOT_FOUND", "the agent session is no longer attached");
}
function rejectSubagent(agent) {
	if (agent.options?.subagent) throw new PromptEditError("PROMPT_UNSUPPORTED", "subagent sessions cannot edit prompts");
}
function findPrompt(agent) {
	const events = sessionEvents$1(agent.session);
	const origin = latestOriginalPrompt(events);
	const target = currentSurfaceUserPrompt(agent, events);
	if (origin === void 0 || target === void 0) throw new PromptEditError("TARGET_NOT_FOUND", "no editable human prompt was found");
	if (String(origin.data.id) !== String(target.data.id) || !sameJson(origin.data.source, target.data.source) || !replacementChainReaches(origin, target, events)) throw new PromptEditError("TARGET_NOT_FOUND", "the latest human prompt is no longer editable");
	if (target.data.content.some((block) => block.type === "tool-result" || block.type === "tool-call")) throw new PromptEditError("PROMPT_UNSUPPORTED", "the last human prompt contains tool content");
	return target;
}
function busyError(error) {
	return new PromptEditError("AGENT_BUSY", (error instanceof Error ? error.message : String(error)) || "agent is busy");
}
function runWhenIdle(agent, task) {
	if (agent.status !== "idle") return Promise.reject(new PromptEditError("AGENT_BUSY", "agent is busy"));
	let started = false;
	const guardedTask = async (signal) => {
		started = true;
		return task(signal);
	};
	let result;
	try {
		result = agent.runMaintenance(guardedTask);
	} catch (error) {
		return Promise.reject(busyError(error));
	}
	return result.catch((error) => {
		if (!started) throw busyError(error);
		throw error;
	});
}
function loadLastPrompt(ctx, agent) {
	return runWhenIdle(agent, async (signal) => {
		signal.throwIfAborted();
		const typedAgent = agent;
		ensureSessionAttached(ctx, typedAgent);
		rejectSubagent(typedAgent);
		return snapshot(preparedResend(typedAgent) ?? findPrompt(typedAgent));
	});
}
/**
* Save a durable revision, shadow the old response, then wake a fresh turn.
* Both supported loops latch send(..., true) behind the maintenance lease.
* Keeping the revision as the marker's cited source makes preparation failures
* recoverable after a process restart without resubmitting accepted work.
*/
async function resendLastPrompt(ctx, agent, input) {
	assertText(input.text);
	if (!Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0) throw new PromptEditError("PROMPT_UNSUPPORTED", "expectedSeq must be a non-negative integer");
	return runWhenIdle(agent, async (signal) => {
		const typedAgent = agent;
		signal.throwIfAborted();
		ensureSessionAttached(ctx, typedAgent);
		rejectSubagent(typedAgent);
		if (typeof agent.send !== "function") throw new PromptEditError("PROMPT_UNSUPPORTED", "agent does not support resend");
		if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length !== 0) throw new PromptEditError("AGENT_BUSY", "agent has queued messages");
		const prepared = preparedResend(typedAgent);
		let revision = prepared ?? findPrompt(typedAgent);
		if (String(revision.data.id) !== input.messageId || Number(revision.seq) !== input.expectedSeq) throw new PromptEditError("PROMPT_CHANGED", "the prompt changed while it was being edited");
		if (prepared !== void 0 && textOf(prepared.data) !== input.text) throw new PromptEditError("PROMPT_CHANGED", "retry the prepared prompt before making another edit");
		let phase = "save";
		let submitted = false;
		try {
			if (prepared === void 0) revision = typedAgent.session.append("user/message", {
				...revision.data,
				content: replaceText(revision.data.content, input.text)
			}, {
				surfaceOp: {
					op: "replace",
					startSeq: revision.seq,
					endSeq: revision.seq
				},
				sourceEventSeqs: [revision.seq]
			});
			await ctx.sessions.flush(agent.session);
			signal.throwIfAborted();
			ensureSessionAttached(ctx, typedAgent);
			if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length !== 0) throw new Error("agent received queued messages during preparation");
			phase = "prepare";
			const events = sessionEvents$1(typedAgent.session);
			const origin = latestOriginalPrompt(events);
			if (origin === void 0 || !replacementChainReaches(origin, revision, events)) throw new Error("latest prompt changed during preparation");
			const markerId = MessageId(`${RESEND_MARKER}${Number(revision.seq)}`);
			const turns = /* @__PURE__ */ new Set();
			const hiddenTurns = /* @__PURE__ */ new Set();
			let currentTurn = 0;
			for (const event of events) {
				if (event.type === "turn/start") currentTurn = event.data.turn;
				if (Number(event.seq) >= Number(origin.seq)) turns.add(currentTurn);
				if (event.type === "system/message" && event.data.message.id === markerId) hiddenTurns.add(event.data.turn);
			}
			let anchor = prepared === void 0 ? revision.seq : agent.session.surface.nodes.at(-1);
			for (const turn of turns) {
				if (hiddenTurns.has(turn)) continue;
				const nodes = [...agent.session.surface.nodes];
				const start = nodes.indexOf(anchor);
				if (start < 0) throw new Error("prompt surface changed during preparation");
				const selected = nodes.slice(start);
				const formatVersion = agent.session.header?.version;
				anchor = agent.session.append("system/message", {
					turn,
					step: 0,
					message: {
						id: markerId,
						role: "system",
						content: [],
						source: tombstoneSource(formatVersion)
					}
				}, {
					surfaceOp: {
						op: "replace",
						startSeq: anchor,
						endSeq: selected.at(-1)
					},
					sourceEventSeqs: selected
				}).seq;
			}
			await ctx.sessions.flush(agent.session);
			signal.throwIfAborted();
			ensureSessionAttached(ctx, typedAgent);
			if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length !== 0) throw new Error("agent received queued messages during preparation");
			if (preparedResend(typedAgent)?.seq !== revision.seq) throw new Error("prompt surface changed before submission");
			phase = "submit";
			const queued = createUserMessage({
				content: revision.data.content,
				source: revision.data.source
			});
			submitted = "unknown";
			agent.send(queued, "next-turn", true);
			submitted = true;
			phase = "persist";
			await ctx.sessions.flush(agent.session);
			return {
				...snapshot(revision),
				submitted: true
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			let retryable = false;
			if (submitted === false) try {
				ensureSessionAttached(ctx, typedAgent);
				retryable = (preparedResend(typedAgent) ?? findPrompt(typedAgent)).seq === revision.seq;
			} catch {}
			throw new PromptEditError("RESEND_FAILED", message || "failed to resend prompt", { cause: error }, {
				prompt: snapshot(revision),
				phase,
				submitted,
				retryable
			});
		}
	});
}
function saveLastPrompt(ctx, agent, input) {
	try {
		assertText(input.text);
		if (!Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0) throw new PromptEditError("PROMPT_UNSUPPORTED", "expectedSeq must be a non-negative integer");
	} catch (error) {
		return Promise.reject(error);
	}
	return runWhenIdle(agent, async (signal) => {
		signal.throwIfAborted();
		const typedAgent = agent;
		ensureSessionAttached(ctx, typedAgent);
		rejectSubagent(typedAgent);
		const target = findPrompt(typedAgent);
		if (String(target.data.id) !== input.messageId || Number(target.seq) !== input.expectedSeq) throw new PromptEditError("PROMPT_CHANGED", "the prompt changed while it was being edited");
		const replacement = {
			...target.data,
			content: replaceText(target.data.content, input.text)
		};
		try {
			signal.throwIfAborted();
			const event = typedAgent.session.append("user/message", replacement, {
				surfaceOp: {
					op: "replace",
					startSeq: target.seq,
					endSeq: target.seq
				},
				sourceEventSeqs: [target.seq]
			});
			await ctx.sessions.flush(typedAgent.session);
			return snapshot(event);
		} catch (error) {
			if (error instanceof PromptEditError) throw error;
			throw new PromptEditError("EDIT_FAILED", (error instanceof Error ? error.message : String(error)) || "failed to save prompt", { cause: error });
		}
	});
}

//#endregion
//#region src/shared.ts
const TURN_DELETE_PATH = "/dsh-conversation-controls/delete";
const PROMPT_EDIT_PATH = "/dsh-conversation-controls/prompt";
/**
* Identity stamped on every deletion tombstone.
*
* Session format v3 wrote the bare `source.plugin` of a `system/message`; the
* legacy `assistant/message` tombstones (DSH <= 0.1.2 era) used it as the
* provider instead, so one constant covers every generation.
*/
const TOMBSTONE_PLUGIN = "dsh-turn-delete";
/**
* Source kind session format v4 (DSH 0.2.x) forces on every `system/message`.
*
* v4 validates message sources by *role*, not by producer: a system message must
* be `system-prompt`, an assistant message must be `model` plus provider/model
* ("seed system/message … message must have system-prompt source"). The v3→v4
* migration additionally rejects the legacy bare `plugin` kind outright ("format
* v4 message requires a producer-owned source kind"). A v4 deletion tombstone
* therefore carries no producer identity in its source — an empty system
* replacement *is* the tombstone — while v3 keeps `source.plugin`, because the
* 0.1.x seed validator demands it ("seed system/message … message must have
* plugin source").
*/
const SYSTEM_PROMPT_SOURCE_KIND = "system-prompt";
/** Legacy tombstone provider (`assistant/message` tombstones only). */
const TOMBSTONE_PROVIDER = TOMBSTONE_PLUGIN;
/** Legacy tombstone model (`assistant/message` tombstones only). */
const TOMBSTONE_MODEL = "tombstone";

//#endregion
//#region src/turn-delete.ts
var TurnDeleteError = class extends Error {
	name = "TurnDeleteError";
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
/**
* Whether one event is a turn-deletion tombstone written by this plugin.
*
* Current kernels write a `system/message` replacement: it is the only surface
* event type that both cites `sourceEventSeqs` (required to shadow a range) and
* projects to no wire message (empty system content is dormant). Session format
* v4 (DSH 0.2.x) forces `source.kind === "system-prompt"` on every system message
* (measured against the real 0.2.0-rc.1 kernel), so on v4 an empty system
* replacement is the tombstone by construction; v3 and pre-0.2 tombstones also
* carry our identity, which those formats do allow. DSH 0.1.5 forbids
* `sourceEventSeqs` on `assistant/message`, so the older tombstone shape is
* read-only replay compatibility: recognizing it keeps old deletions idempotent
* and keeps them hidden in the browser.
*/
function isTurnDeleteEvent(event) {
	if (event.type !== "system/message" && event.type !== "assistant/message") return false;
	if (!isReplacementSurfaceEvent(event)) return false;
	const message = event.data.message;
	if (message.content.length !== 0) return false;
	const source = message.source;
	if (event.type === "system/message") {
		const stamped = source;
		return stamped.kind === SYSTEM_PROMPT_SOURCE_KIND || stamped.kind === "plugin" && stamped.plugin === TOMBSTONE_PLUGIN;
	}
	return source.kind === "model" && source.provider === TOMBSTONE_PROVIDER && source.model === TOMBSTONE_MODEL;
}
/**
* Session format that validates message sources by role instead of by producer.
*
* Format 4 (DSH 0.2.x) requires `system-prompt` on every `system/message` and
* rejects the legacy bare `plugin` kind at admission, while the 0.1.x seed
* validator requires exactly the opposite ("seed system/message … message must
* have plugin source"). The tombstone therefore has to match the log it lands in.
*/
const ROLE_SOURCE_FORMAT = 4;
/**
* Source stamped on a deletion tombstone for one session format version.
*
* Format 4+ carries no producer identity: an empty system replacement is the
* tombstone by construction. Older logs keep our identity in `source.plugin`,
* which their validators demand. Exported for tests and hosts; see
* {@link ROLE_SOURCE_FORMAT}.
*/
function tombstoneSource(formatVersion) {
	return formatVersion !== void 0 && formatVersion >= ROLE_SOURCE_FORMAT ? { kind: SYSTEM_PROMPT_SOURCE_KIND } : {
		kind: "plugin",
		plugin: TOMBSTONE_PLUGIN
	};
}
function sessionFormatVersion(session) {
	const version = (session?.header)?.version;
	return typeof version === "number" && Number.isFinite(version) ? version : void 0;
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
const createSystemMessageCompat = createSystemMessage;
function createTombstoneMessage(session) {
	return {
		...createSystemMessageCompat("", TOMBSTONE_PLUGIN),
		source: tombstoneSource(sessionFormatVersion(session))
	};
}
function eventTurn(event) {
	if (event.type === "assistant/message" || event.type === "tool/result") return event.data.turn;
}
/**
* Read a Session's event array.
*
* DSH 0.1.2-alpha.1 removed the `Session.events` property; the public API is
* `snapshotEvents()` (plus `ownEvents()` / `eventAt(seq)`). Reading through
* this helper keeps one build readable on both kernels.
*/
function sessionEvents(session) {
	if (typeof session.snapshotEvents === "function") return session.snapshotEvents();
	return session.events ?? [];
}
function turnBracket(events, turn, targetSeq) {
	const start = events.findLast((event) => event.seq <= targetSeq && event.type === "turn/start" && event.data.turn === turn);
	const end = events.find((event) => event.seq >= targetSeq && event.type === "turn/end" && event.data.turn === turn);
	return start === void 0 || end === void 0 ? void 0 : {
		start: start.seq,
		end: end.seq
	};
}
function originBelongsToTurn(event, turn, bracket) {
	return event.seq > bracket.start && event.seq < bracket.end || eventTurn(event) === turn;
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
function isSystemPromptEvent(event) {
	return event.type === "system/message";
}
function surfaceOrigins(seq, events, memo, visiting = /* @__PURE__ */ new Set()) {
	const cached = memo.get(seq);
	if (cached !== void 0) return cached;
	if (visiting.has(seq)) return /* @__PURE__ */ new Set();
	visiting.add(seq);
	const event = events[seq];
	const origins = /* @__PURE__ */ new Set();
	if (event !== void 0) {
		if (isAppendSurfaceEvent(event)) origins.add(seq);
		const sources = event.sourceEventSeqs ?? [];
		for (const source of sources) for (const origin of surfaceOrigins(source, events, memo, visiting)) origins.add(origin);
	}
	visiting.delete(seq);
	memo.set(seq, origins);
	return origins;
}
async function deleteUnderMaintenance(ctx, agent, assistantMessageId, signal) {
	signal.throwIfAborted();
	const session = agent.session;
	if (ctx.sessions.get(session.id) !== session) throw new TurnDeleteError("TARGET_NOT_FOUND", `session "${session.id}" is no longer live`);
	const events = sessionEvents(session);
	const target = events.find((event) => event.type === "assistant/message" && isAppendSurfaceEvent(event) && event.data.message.id === assistantMessageId);
	if (target === void 0) throw new TurnDeleteError("TARGET_NOT_FOUND", `assistant message "${assistantMessageId}" was not found`);
	const turn = target.data.turn;
	const existing = events.find((event) => isTurnDeleteEvent(event) && event.data.turn === turn);
	if (existing !== void 0) {
		await ctx.sessions.flush(session);
		return {
			turn,
			seq: existing.seq
		};
	}
	const bracket = turnBracket(events, turn, target.seq);
	if (bracket === void 0) throw new TurnDeleteError("TURN_NOT_CLOSED", `turn ${String(turn)} is not closed`);
	const originSeqs = new Set(events.filter((event) => !isSystemPromptEvent(event) && isAppendSurfaceEvent(event) && originBelongsToTurn(event, turn, bracket)).map((event) => event.seq));
	const currentNodes = session.surface.nodes;
	if (!currentNodes.includes(target.seq)) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} is no longer independently deletable`);
	const memo = /* @__PURE__ */ new Map();
	const selected = [];
	const covered = /* @__PURE__ */ new Set();
	for (const seq of currentNodes) {
		const origins = surfaceOrigins(seq, events, memo);
		const targetOrigins = [...origins].filter((origin) => originSeqs.has(origin));
		if (targetOrigins.length === 0) continue;
		if ([...origins].some((origin) => !originSeqs.has(origin))) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} shares a compacted surface node`);
		const current = events[seq];
		if (current !== void 0 && !originSeqs.has(seq) && !(current.type === "tool/result" && current.data.turn === turn) && !isPromptEditEvent(current, events)) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} contains a non-local replacement`);
		selected.push(seq);
		for (const origin of targetOrigins) covered.add(origin);
	}
	if ([...originSeqs].some((origin) => !covered.has(origin)) || selected.length === 0) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} is partially compacted`);
	const positions = selected.map((seq) => currentNodes.indexOf(seq));
	const first = positions[0];
	if (first === void 0 || positions.some((position, index) => position !== first + index)) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} is not a contiguous surface span`);
	const firstSeq = selected[0];
	const lastSeq = selected.at(-1);
	if (firstSeq === void 0 || lastSeq === void 0) throw new TurnDeleteError("TURN_COMPACTED", `turn ${String(turn)} has no deletable surface span`);
	signal.throwIfAborted();
	const tombstone = session.append("system/message", {
		turn,
		step: target.data.step,
		message: createTombstoneMessage(session)
	}, {
		surfaceOp: {
			op: "replace",
			startSeq: firstSeq,
			endSeq: lastSeq
		},
		sourceEventSeqs: selected
	});
	await ctx.sessions.flush(session);
	return {
		turn,
		seq: tombstone.seq
	};
}
const BUSY_PHASE_RE = /already has active work/i;
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
async function runMaintenanceIdleAware(agent, job) {
	let insideJob = false;
	const wrapped = (signal) => {
		insideJob = true;
		return job(signal);
	};
	try {
		return await agent.runMaintenance(wrapped);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (insideJob || !BUSY_PHASE_RE.test(message)) throw error;
		await Promise.race([Promise.resolve().then(() => agent.whenIdle()).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4e3))]);
		return await agent.runMaintenance(wrapped);
	}
}
async function deleteTurn(ctx, agent, assistantMessageId) {
	try {
		try {
			return await runMaintenanceIdleAware(agent, (signal) => deleteUnderMaintenance(ctx, agent, assistantMessageId, signal));
		} catch (error) {
			if (error instanceof TurnDeleteError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (!BUSY_PHASE_RE.test(message)) throw error;
			throw new TurnDeleteError("AGENT_BUSY", message);
		}
	} catch (error) {
		if (error instanceof TurnDeleteError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		ctx.logger?.error?.(`turn-delete: deleting a turn from session "${agent.session.id}" failed: ${message}`);
		throw new TurnDeleteError("DELETE_FAILED", message);
	}
}

//#endregion
//#region src/http.ts
const MAX_BODY_BYTES = 1024 * 1024;
async function requestJson(request) {
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	for await (const chunk of request) {
		bytes += typeof chunk === "string" ? new TextEncoder().encode(chunk).length : chunk.byteLength;
		if (bytes > MAX_BODY_BYTES) throw new TypeError("request body is too large");
		text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
	}
	text += decoder.decode();
	const value = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("request body must be an object");
	return value;
}
function stringField(input, name$1) {
	const value = input[name$1];
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name$1} must be a non-empty string`);
	return value;
}
function respondJson(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(value));
}
async function handle(request, response, action) {
	if (request.method !== "POST") {
		response.writeHead(405, { allow: "POST" });
		response.end();
		return;
	}
	const contentType = request.headers?.["content-type"];
	if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
		respondJson(response, 415, {
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: "application/json required"
			}
		});
		return;
	}
	try {
		respondJson(response, 200, {
			ok: true,
			value: await action(await requestJson(request))
		});
	} catch (error) {
		if (error instanceof TurnDeleteError || error instanceof PromptEditError) respondJson(response, error.code === "AGENT_BUSY" ? 423 : error.code === "DELETE_FAILED" || error.code === "EDIT_FAILED" || error.code === "RESEND_FAILED" ? 500 : 409, {
			ok: false,
			error: {
				code: error.code,
				message: error.message,
				...error instanceof PromptEditError && error.recovery !== void 0 ? { recovery: error.recovery } : {}
			}
		});
		else respondJson(response, 400, {
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: error instanceof Error ? error.message : String(error)
			}
		});
	}
}
async function handleTurnDelete(ctx, request, response) {
	return handle(request, response, async (input) => {
		const agent = ctx.agents.get(SessionId(stringField(input, "sessionId")));
		if (agent === void 0) throw new TurnDeleteError("TARGET_NOT_FOUND", "Session is not active");
		return deleteTurn(ctx, agent, MessageId(stringField(input, "assistantMessageId")));
	});
}
async function handlePromptEdit(ctx, request, response) {
	return handle(request, response, async (input) => {
		const agent = ctx.agents.get(SessionId(stringField(input, "sessionId")));
		if (agent === void 0) throw new PromptEditError("TARGET_NOT_FOUND", "Session is not active");
		if (input.action === "load") return loadLastPrompt(ctx, agent);
		if (input.action !== "save" && input.action !== "resend") throw new TypeError("action must be load, save or resend");
		if (!Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0) throw new TypeError("expectedSeq must be a non-negative integer");
		return (input.action === "resend" ? resendLastPrompt : saveLastPrompt)(ctx, agent, {
			messageId: stringField(input, "messageId"),
			expectedSeq: input.expectedSeq,
			text: stringField(input, "text")
		});
	});
}

//#endregion
//#region src/deleted-turns-projection.ts
/** Whole-log deletion state, independent of the browser's loaded event window. */
const DELETED_TURNS_PROJECTION_KEY = "conversationControlsDeletedTurns";
const deletedTurnsSchema = z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).refine((turns) => turns.every((turn, index) => index === 0 || turn > turns[index - 1]), { message: "deleted turns must be strictly increasing" });
/**
* The registry folds every committed event and persists this JSON-safe state.
* Retain the same array for unrelated events and repeated tombstones: the
* projection change feed uses reference identity to avoid redundant updates.
*/
const deletedTurnsProjectionDefinition = {
	key: DELETED_TURNS_PROJECTION_KEY,
	stateVersion: 1,
	stateSchema: deletedTurnsSchema,
	init: () => [],
	apply: (state, event) => {
		if (!isTurnDeleteEvent(event)) return state;
		const turn = event.data.turn;
		if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0 || state.includes(turn)) return state;
		return [...state, turn].sort((left, right) => left - right);
	},
	wire: {
		viewSchema: deletedTurnsSchema,
		view: (state) => state
	}
};

//#endregion
//#region src/index.ts
const name = "conversation-controls";
const inject = [
	"sessions",
	"agents",
	"webServer"
];
function apply(ctx) {
	ctx.inject(["sessionProjections"], (scope) => {
		scope.sessionProjections.register(deletedTurnsProjectionDefinition);
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: TURN_DELETE_PATH,
		handler: (request, response) => handleTurnDelete(ctx, request, response)
	}), "conversation-controls: delete route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PROMPT_EDIT_PATH,
		handler: (request, response) => handlePromptEdit(ctx, request, response)
	}), "conversation-controls: prompt route");
}

//#endregion
export { PROMPT_EDIT_PATH, PromptEditError, TOMBSTONE_MODEL, TOMBSTONE_PROVIDER, TURN_DELETE_PATH, TurnDeleteError, apply, deleteTurn, inject, isTurnDeleteEvent, loadLastPrompt, name, saveLastPrompt, tombstoneSource };