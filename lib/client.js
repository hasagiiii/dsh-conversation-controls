window.__ModuleLoader__.load({ id: "dsh-conversation-controls", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);
let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
__deepseek_ai_dsh_client_ui_primitives = __toESM(__deepseek_ai_dsh_client_ui_primitives);
let react_dom = require("react-dom");
react_dom = __toESM(react_dom);

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
* therefore carries no producer identity in its source. Its explicit deletion
* metadata or resend message ID identifies it, while v3 keeps `source.plugin`, because the
* 0.1.x seed validator demands it ("seed system/message … message must have
* plugin source").
*/
const SYSTEM_PROMPT_SOURCE_KIND = "system-prompt";
/** Legacy tombstone provider (`assistant/message` tombstones only). */
const TOMBSTONE_PROVIDER = TOMBSTONE_PLUGIN;
/** Legacy tombstone model (`assistant/message` tombstones only). */
const TOMBSTONE_MODEL = "tombstone";
/** Empty system-prompt replacements also occur during ordinary host cleanup. */
function isDeletionMarker(event) {
	if (event.type !== "system/message" && event.type !== "assistant/message") return false;
	if (typeof event.surfaceOp !== "object" || event.surfaceOp === null || !("op" in event.surfaceOp) || event.surfaceOp.op !== "replace") return false;
	const message = event.data?.message;
	if (!Array.isArray(message?.content) || message.content.length !== 0) return false;
	const source = message.source;
	if (source === void 0) return false;
	if (event.type === "assistant/message") return source.kind === "model" && source.provider === TOMBSTONE_PROVIDER && source.model === TOMBSTONE_MODEL;
	if (source.kind === "plugin") return source.plugin === TOMBSTONE_PLUGIN;
	if (source.kind !== SYSTEM_PROMPT_SOURCE_KIND) return false;
	const target = event.data?.deletedTurn;
	return typeof target === "number" && Number.isSafeInteger(target) && target >= 0 && typeof event.data?.maintenance === "boolean" || typeof message.id === "string" && /^conversation-controls:resend:\d+$/.test(message.id);
}

//#endregion
//#region src/client/DeletedTurnMarker.tsx
let ownerSequence = 0;
function turnRows(marker) {
	const tailRow = marker.closest("[data-turn-tail]")?.closest("[data-chat-flow-kind=\"turn-tail\"]");
	if (tailRow === void 0 || tailRow === null) return [];
	const rows = [tailRow];
	let cursor = tailRow.previousElementSibling;
	while (cursor instanceof HTMLElement) {
		if (cursor.querySelector("[data-turn-tail]") !== null) break;
		rows.push(cursor);
		cursor = cursor.previousElementSibling;
	}
	return rows;
}
function concealDeletedTurn(marker, turn) {
	const owner = `${String(turn)}-${String(++ownerSequence)}`;
	const changed = [];
	for (const element of turnRows(marker)) {
		changed.push({
			element,
			hidden: element.hidden
		});
		element.dataset.dshTurnDeleteOwner = owner;
		element.hidden = true;
	}
	return () => {
		for (const entry of changed) {
			if (entry.element.dataset.dshTurnDeleteOwner !== owner) continue;
			delete entry.element.dataset.dshTurnDeleteOwner;
			entry.element.hidden = entry.hidden;
		}
	};
}
/**
* Conceal the deletion target immediately, from the delete action itself.
*
* The durable tombstone reaches the Conversation engine and publishes its
* turn-delete Location data, but the chat's turn-tail row is memoized on its own
* view node: a live append that produces no new node never re-renders that row,
* so the chain slot rendering {@link DeletedTurnMarker} stays stale until the
* next full render (a Session switch performs one). The action button renders
* inside that very row, so the action can apply the same concealment at once;
* whenever the row is rendered again the durable marker re-applies it from the
* tombstone.
*
* @param anchor - the action's own element (any node inside the target turn).
*/
function concealTurnFromAction(anchor) {
	if (anchor === null) return;
	const marker = anchor.closest("[data-turn-tail]");
	if (marker === null) return;
	const turn = Number(marker.getAttribute("data-turn-tail"));
	concealDeletedTurn(marker, Number.isFinite(turn) ? turn : 0);
}
function DeletedTurnMarker({ matched }) {
	const markerRef = (0, react.useRef)(null);
	(0, react.useLayoutEffect)(() => {
		const marker = markerRef.current;
		if (marker === null) return;
		const list = marker.closest("[data-chat-flow-kind=\"turn-tail\"]")?.parentElement;
		if (list === void 0 || list === null) return;
		let restore = concealDeletedTurn(marker, matched.turn);
		const observer = new MutationObserver(() => {
			restore();
			restore = concealDeletedTurn(marker, matched.turn);
		});
		observer.observe(list, {
			childList: true,
			subtree: true
		});
		return () => {
			observer.disconnect();
			restore();
		};
	}, [matched.turn]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		ref: markerRef,
		"data-dsh-deleted-turn": matched.turn,
		hidden: true
	});
}

//#endregion
//#region src/client/locales.ts
const zh = {
	"action.delete": "删除这一轮对话",
	"action.busy": "任务运行时不能删除对话",
	"dialog.title": "删除这一轮对话？",
	"dialog.description": "这会从当前 Session 和后续模型上下文中移除本轮的提问、回答与工具记录，但不会删除整个 Session。",
	"dialog.cancel": "取消",
	"dialog.confirm": "删除这一轮",
	"dialog.deleting": "正在删除…",
	"error.busy": "任务正在运行，请结束后再删除。",
	"error.compacted": "这一轮已被压缩进上下文摘要：摘要是整体替换，无法单独摘除其中一轮。",
	"error.failed": "删除失败：插件内部出错或与当前内核不兼容。",
	"error.unavailable": "这一轮已变化或不存在，无法删除。",
	"error.generic": "删除失败，请重试。",
	"error.unknown": "请求超时，删除结果未知；请检查对话后再重试。",
	"edit.resend.action": "修改",
	"edit.resend.title": "修改并重发提问",
	"edit.resend.description": "替换这条提问并重新生成回答，原回答及其工具记录将移除。",
	"edit.resend.submit": "发送",
	"edit.resend.pending": "发送中…",
	"edit.resend.inlineNotice": "发送后将重新生成回答，原回答会被移除。",
	"edit.resend.retry": "尚未提交，修改已保留。请再次点击“发送”。",
	"edit.resend.uncertain": "提问可能已提交，请取消编辑并检查对话，避免重复发送。",
	"edit.attachments": "原有图片和文件附件将保留。",
	"edit.action": "修改上次提问",
	"edit.action.busy": "任务运行时不能修改提问",
	"edit.title": "修改上次提问",
	"edit.description": "修改用于后续对话的提问；原始记录保留。保存后不会自动继续运行。",
	"edit.field": "提问内容",
	"edit.cancel": "取消",
	"edit.save": "保存修改",
	"edit.saving": "正在保存…",
	"edit.notice": "修改用于后续对话的提问；原始记录保留。",
	"edit.saved": "提问已修改，继续时生效。",
	"edit.error.busy": "任务正在运行，请暂停后再修改。",
	"edit.error.changed": "提问已发生变化，请重新打开编辑器后再保存。",
	"edit.error.unavailable": "当前提问已变化或不支持修改。",
	"edit.error.load": "无法加载当前提问。",
	"edit.error.save": "保存提问修改失败，请重试。",
	"edit.error.unknown": "请求结果未知，请检查当前提问后再重试。"
};
const en = {
	"action.delete": "Delete this turn",
	"action.busy": "Turns cannot be deleted while the task is running",
	"dialog.title": "Delete this turn?",
	"dialog.description": "This removes the prompt, response, and tool records from this Session and future model context. It does not delete the Session.",
	"dialog.cancel": "Cancel",
	"dialog.confirm": "Delete turn",
	"dialog.deleting": "Deleting…",
	"error.busy": "Wait for the task to finish before deleting this turn.",
	"error.compacted": "This turn is already inside a context summary. The summary is replaced as a whole, so this turn cannot be removed on its own.",
	"error.failed": "Deletion failed: the plugin hit an internal error or is incompatible with this Harness build.",
	"error.unavailable": "This turn changed or no longer exists and cannot be deleted.",
	"error.generic": "Could not delete this turn. Try again.",
	"error.unknown": "The request timed out and the deletion result is unknown. Check the conversation before retrying.",
	"edit.resend.action": "Edit",
	"edit.resend.title": "Edit and resend prompt",
	"edit.resend.description": "Replace this prompt and generate a new response. The previous response and its tool records will be removed.",
	"edit.resend.submit": "Send",
	"edit.resend.pending": "Sending…",
	"edit.resend.inlineNotice": "Sending regenerates the response and removes the previous one.",
	"edit.resend.retry": "Not submitted. Your edit is preserved. Click Send to retry.",
	"edit.resend.uncertain": "The prompt may already have been submitted. Cancel the edit and check the conversation before sending again.",
	"edit.attachments": "Existing images and file attachments will be preserved.",
	"edit.action": "Edit last prompt",
	"edit.action.busy": "Prompts cannot be edited while the task is running",
	"edit.title": "Edit last prompt",
	"edit.description": "The edit is used for the next conversation; the original record is kept. Saving will not resume the session.",
	"edit.field": "Prompt text",
	"edit.cancel": "Cancel",
	"edit.save": "Save edit",
	"edit.saving": "Saving…",
	"edit.notice": "The edit is used for the next conversation; the original record is kept.",
	"edit.saved": "Prompt edited. The change takes effect when you continue.",
	"edit.error.busy": "The task is running. Pause it before editing the prompt.",
	"edit.error.changed": "The prompt changed. Reopen the editor and save again.",
	"edit.error.unavailable": "The current prompt changed or cannot be edited.",
	"edit.error.load": "Could not load the current prompt.",
	"edit.error.save": "Could not save the prompt edit. Try again.",
	"edit.error.unknown": "The request result is unknown. Check the current prompt before trying again."
};

//#endregion
//#region src/client/trash-icon.tsx
/**
* Names the trash glyph has carried across the kernel lines this plugin
* supports, newest first.
*
* DSH 0.2.0-rc.1 dropped the size suffix from every icon and split the set into
* stroke-weight variants: `IconTrashOutline16` (0.1.x) became
* `IconTrashOutlineRegular` (1px stroke) / `IconTrashOutlineMedium` (1.3px).
*
* The browser half resolves the name at runtime on purpose. Reading a renamed
* export yields `undefined`, and rendering `undefined` as a component throws
* inside the chat action row — which takes the delete button (and the row it
* lives in) down with it, with no host-side error to explain why.
*/
const TRASH_ICON_NAMES = [
	"IconTrashOutlineRegular",
	"IconTrashOutline",
	"IconTrashOutline16",
	"IconTrashOutlineMedium"
];
/** Pick the first trash icon a primitives module actually exports. */
function resolveTrashIcon(module$1) {
	if (module$1 === null || typeof module$1 !== "object") return null;
	const table = module$1;
	for (const name of TRASH_ICON_NAMES) {
		const candidate = table[name];
		if (typeof candidate === "function" || typeof candidate === "object" && candidate !== null) return candidate;
	}
	return null;
}
/** Trash glyph exported by the primitives module bundled with this build. */
const TrashIcon = resolveTrashIcon(__deepseek_ai_dsh_client_ui_primitives);
/**
* Inline stand-in used when no primitives icon answers to any known name, so a
* future rename degrades to a plain glyph instead of an empty button.
*/
function FallbackTrashIcon() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: 16,
		height: 16,
		viewBox: "0 0 16 16",
		fill: "none",
		"aria-hidden": "true",
		focusable: "false",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M2.75 4.25h10.5",
				stroke: "currentColor",
				strokeWidth: "1",
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M6.45 6.99v4.14M9.55 6.99v4.14",
				stroke: "currentColor",
				strokeWidth: "1",
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M4.15 4.25l.5 8.08a1.1 1.1 0 0 0 1.1 1.02h4.5a1.1 1.1 0 0 0 1.1-1.02l.5-8.08",
				stroke: "currentColor",
				strokeWidth: "1",
				strokeLinejoin: "round"
			})
		]
	});
}

//#endregion
//#region src/client/TurnDeleteAction.tsx
const REQUEST_RESULT_UNKNOWN = "REQUEST_RESULT_UNKNOWN";
const actionStyle = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 28,
	height: 28,
	padding: 6,
	border: "none",
	borderRadius: 28,
	background: "transparent",
	color: "var(--dsw-alias-label-tertiary)",
	cursor: "pointer"
};
const confirmStyle = { color: "var(--dsw-alias-state-error-primary)" };
const errorStyle$1 = {
	color: "var(--dsw-alias-state-error-primary)",
	fontSize: 13,
	lineHeight: 1.5
};
/** Keep one raw failure detail line readable without dumping a whole stack. */
function withDetail(message, detail) {
	const trimmed = detail.trim();
	return trimmed.length === 0 ? message : `${message} — ${trimmed.slice(0, 200)}`;
}
function TurnDeleteAction({ messageId, deleteTurn, useSession, t }) {
	const running = useSession((snapshot) => snapshot.running);
	const subagent = useSession((snapshot) => snapshot.subagent);
	const [open, setOpen] = (0, react.useState)(false);
	const [pending, setPending] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	const alive = (0, react.useRef)(true);
	const buttonRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	if (subagent !== null) return null;
	const unavailable = running || pending;
	const close = () => {
		if (pending) return;
		setOpen(false);
		setError(null);
	};
	const confirm = () => {
		if (unavailable) return;
		setPending(true);
		setError(null);
		deleteTurn(messageId).then((result) => {
			if (!alive.current) return;
			setPending(false);
			if (result.ok) {
				setOpen(false);
				concealTurnFromAction(buttonRef.current);
				return;
			}
			if (result.error.code === "AGENT_BUSY") setError(t("error.busy"));
			else if (result.error.code === "TURN_COMPACTED") setError(t("error.compacted"));
			else if (result.error.code === "DELETE_FAILED") setError(withDetail(t("error.failed"), result.error.message));
			else if (result.error.code === "TARGET_NOT_FOUND" || result.error.code === "TURN_NOT_CLOSED") setError(t("error.unavailable"));
			else setError(t("error.generic"));
		}).catch((reason) => {
			if (!alive.current) return;
			setPending(false);
			setError(reason instanceof Error && reason.message === REQUEST_RESULT_UNKNOWN ? t("error.unknown") : t("error.generic"));
		});
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tooltip, {
		label: running ? t("action.busy") : t("action.delete"),
		side: "bottom",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			ref: buttonRef,
			type: "button",
			style: {
				...actionStyle,
				opacity: running ? .4 : 1,
				cursor: running ? "default" : "pointer"
			},
			"aria-label": t("action.delete"),
			"aria-disabled": running || void 0,
			onClick: running ? void 0 : () => {
				setOpen(true);
				setError(null);
			},
			children: TrashIcon === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FallbackTrashIcon, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrashIcon, { size: 16 })
		})
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Modal, {
		open,
		onClose: close,
		closeLabel: t("dialog.cancel"),
		title: t("dialog.title"),
		description: t("dialog.description"),
		footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "outline",
			disabled: pending,
			onClick: close,
			children: t("dialog.cancel")
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "outline",
			style: confirmStyle,
			disabled: pending || running,
			onClick: confirm,
			children: pending ? t("dialog.deleting") : t("dialog.confirm")
		})] }),
		children: error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: errorStyle$1,
			role: "alert",
			children: error
		})
	})] });
}

//#endregion
//#region src/client/turn-deletion.ts
/** Read only explicitly identified deletion markers, including legacy formats. */
function deletedTurn(event) {
	if (!isDeletionMarker(event)) return void 0;
	const turn = event.data?.deletedTurn ?? event.data?.turn;
	return typeof turn === "number" && Number.isSafeInteger(turn) && turn >= 0 ? turn : void 0;
}
const turnDeletionDefinition = {
	kind: "turn-delete",
	match: (event) => {
		const turn = deletedTurn(event);
		return turn === void 0 ? null : {
			id: String(turn),
			role: "start"
		};
	},
	start: (_context, match) => {
		const turn = deletedTurn(match.event);
		if (turn === void 0) throw new Error("turn-delete start requires a deletion tombstone");
		return { turn };
	},
	update: (context) => context.state,
	publication: () => "immediate",
	buildLocationData: (context, scope) => {
		if (scope !== "turn" || context.state === void 0) return null;
		return {
			kind: "turn",
			turn: context.state.turn,
			key: "turn-delete",
			value: {
				hidden: true,
				turn: context.state.turn
			}
		};
	}
};
function selectDeletedTurn(owner) {
	const data = owner.turn.data.get("turn-delete");
	return data?.hidden === true ? data : null;
}

//#endregion
//#region src/client/turn-navigation.tsx
const DELETED_TURNS_PROJECTION = "conversationControlsDeletedTurns";
const VIEW_SLOT = "conversation.view";
/** Preserve reference identity for selector subscriptions and the rail's memo. */
function navigationFilter(deleted) {
	const arrays = /* @__PURE__ */ new WeakMap();
	const snapshots = /* @__PURE__ */ new WeakMap();
	function items(source) {
		const cached = arrays.get(source);
		if (cached !== void 0) return cached;
		const filtered = source.filter((item) => !deleted.has(item.turn));
		const result = filtered.length === source.length ? source : filtered;
		arrays.set(source, result);
		return result;
	}
	return {
		deletedTurns: [...deleted],
		items,
		snapshot(source) {
			if (source.navigation === void 0 || deleted.size === 0) return source;
			let result = snapshots.get(source);
			if (result === void 0) {
				result = {
					...source,
					navigation: { items: () => items(source.navigation.items()) }
				};
				snapshots.set(source, result);
			}
			return result;
		}
	};
}
function loadedDeletions(snapshot) {
	const turns = [];
	for (const [turn, entry] of snapshot.timeline?.turns ?? []) if (entry.data.get("turn-delete")?.hidden === true) turns.push(turn);
	return turns.join(",");
}
function withDeletedTurnNavigation(Component) {
	function FilteredNavigation(props) {
		const scope = encodeURIComponent((0, react.useId)());
		const useChat = props.useChat;
		const useProjection = props.useProjection;
		const projected = useProjection(DELETED_TURNS_PROJECTION);
		const loaded = useChat(loadedDeletions);
		const filter = (0, react.useMemo)(() => {
			const deleted = new Set(loaded === "" ? [] : loaded.split(",").map(Number));
			if (Array.isArray(projected)) {
				for (const turn of projected) if (Number.isSafeInteger(turn) && turn >= 0) deleted.add(turn);
			}
			return navigationFilter(deleted);
		}, [projected, loaded]);
		const adapted = (0, react.useMemo)(() => ({
			useChat: (selector) => useChat((snapshot) => selector(filter.snapshot(snapshot))),
			useProjection: (key) => {
				const value = useProjection(key);
				return key === "turnOutline" && Array.isArray(value) ? filter.items(value) : value;
			}
		}), [
			useChat,
			useProjection,
			filter
		]);
		const hiddenRows = filter.deletedTurns.map((turn) => `[data-dsh-conversation-controls="${scope}"] [data-chat-turn="${turn}"]`).join(",");
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			"data-dsh-conversation-controls": scope,
			style: { display: "contents" },
			children: [hiddenRows !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: `${hiddenRows}{display:none!important}` }), (0, react.createElement)(Component, {
				...props,
				...adapted
			})]
		});
	}
	return function NavigationCompatibility(props) {
		return typeof props.useChat === "function" && typeof props.useProjection === "function" ? (0, react.createElement)(FilteredNavigation, props) : (0, react.createElement)(Component, props);
	};
}
/**
* DSH 0.2.x renders entry.component directly but exposes no navigation filter.
* Adapt the existing chat seat, preserving its child slots, injectors, store and
* tab identity. A second registration would create duplicate Chat tabs. This
* narrow compatibility adapter must be revisited if the renderer contract changes.
*/
function installTurnNavigationFilter(slots) {
	if (slots.entries === void 0) return () => {};
	const patched = /* @__PURE__ */ new Map();
	const install = () => {
		for (const entry of slots.entries(VIEW_SLOT)) {
			if (entry.options.id !== "chat" || patched.has(entry)) continue;
			if (Object.getOwnPropertyDescriptor(entry, "component")?.writable !== true) continue;
			const original = entry.component;
			const wrapped = withDeletedTurnNavigation(original);
			entry.component = wrapped;
			patched.set(entry, {
				original,
				wrapped
			});
		}
	};
	const unsubscribe = slots.subscribe?.(VIEW_SLOT, install);
	install();
	return () => {
		unsubscribe?.();
		for (const [entry, { original, wrapped }] of patched) if (entry.component === wrapped) entry.component = original;
		patched.clear();
	};
}

//#endregion
//#region src/client/prompt-edit-placement.tsx
const PROMPT_EDIT_FACTORY = "conversation-controls.prompt-edit";
const LatestPrompt = (0, react.createContext)(null);
/** Read inside the selector: the host's node store is mutable. */
function latestPromptId(snapshot) {
	for (let index = snapshot.order.length - 1; index >= 0; index--) {
		const node = snapshot.nodes.get(snapshot.order[index]);
		if (node?.kind !== "user" || node.visibility === "hidden") continue;
		const turn = node.location?.turn?.turn;
		if (!(turn === void 0 ? void 0 : snapshot.timeline?.turns.get(turn)?.data.get("turn-delete"))?.hidden) return node.id;
	}
	return null;
}
function withLatestPrompt(Component) {
	function Provider(props) {
		const useChat = props.useChat;
		const latest = useChat(latestPromptId);
		const [target, setTarget] = (0, react.useState)(null);
		const [editing, setEditing] = (0, react.useState)(null);
		const value = (0, react.useMemo)(() => ({
			latest,
			editing,
			setTarget
		}), [latest, editing]);
		const renderFactory = props.renderFactorySlot;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(LatestPrompt.Provider, {
			value,
			children: [(0, react.createElement)(Component, props), renderFactory?.(PROMPT_EDIT_FACTORY, {
				messageId: latest,
				buttonTarget: target,
				onEditingChange: setEditing
			})]
		});
	}
	return function PromptView(props) {
		return props.useChat === void 0 ? (0, react.createElement)(Component, props) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Provider, { ...props });
	};
}
function withPromptEditButton(Component) {
	return function PromptRow(props) {
		const context = (0, react.useContext)(LatestPrompt);
		const node = props.node;
		const t = props.t;
		const copyLabel = t?.("copy");
		const copiedLabel = t?.("copied");
		const root = (0, react.useRef)(null);
		const editor = (0, react.useRef)(null);
		const setTarget = context?.setTarget;
		const active = context !== null && node?.id === context.latest && context.latest !== null;
		const editing = active && context.editing === node?.id;
		(0, react.useLayoutEffect)(() => {
			if (!active || root.current === null || editor.current === null || copyLabel === void 0 || copiedLabel === void 0) return;
			const actions = root.current.querySelector("[class$=\"_userRow\"] > [class*=\"_actions\"]");
			const copy = actions === null ? void 0 : [...actions.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === copyLabel || button.getAttribute("aria-label") === copiedLabel);
			if (copy?.parentElement === null || copy === void 0) return;
			const element = document.createElement("span");
			element.dataset.promptEditMount = "";
			element.style.display = "inline-flex";
			copy.parentElement.insertBefore(element, copy);
			setTarget?.({
				element,
				editorElement: editor.current,
				buttonClass: copy.className,
				messageId: node.id
			});
			return () => {
				element.remove();
				setTarget?.((current) => current?.element === element ? null : current);
			};
		}, [
			active,
			node?.id,
			copyLabel,
			copiedLabel,
			setTarget
		]);
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			ref: root,
			style: editing ? hiddenStyle : contentsStyle,
			children: (0, react.createElement)(Component, props)
		}), active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			ref: editor,
			"data-prompt-editor-mount": "",
			style: editing ? editorMountStyle : hiddenStyle
		})] });
	};
}
const contentsStyle = { display: "contents" };
const hiddenStyle = { display: "none" };
const editorMountStyle = {
	display: "block",
	width: "100%",
	minWidth: 0
};
/** Reversible adapter for DSH 0.2.x, which has no user-message actions slot. */
function installPromptEditPlacement(slots) {
	if (slots.entries === void 0) return () => {};
	const patched = /* @__PURE__ */ new Map();
	const install = () => {
		for (const name of ["conversation.view", "conversation.chat.node"]) for (const entry of slots.entries(name)) {
			const options = entry.options;
			if ((name === "conversation.view" ? options.id !== "chat" : options.key !== "user") || patched.has(entry)) continue;
			if (Object.getOwnPropertyDescriptor(entry, "component")?.writable !== true) continue;
			const original = entry.component;
			const wrapped = name === "conversation.view" ? withLatestPrompt(original) : withPromptEditButton(original);
			entry.component = wrapped;
			patched.set(entry, {
				original,
				wrapped
			});
		}
	};
	const subscriptions = ["conversation.view", "conversation.chat.node"].map((name) => slots.subscribe?.(name, install));
	install();
	return () => {
		subscriptions.forEach((dispose) => dispose?.());
		for (const [entry, { original, wrapped }] of patched) if (entry.component === wrapped) entry.component = original;
		patched.clear();
	};
}

//#endregion
//#region src/client/PromptResendAction.tsx
const editorStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	boxSizing: "border-box",
	width: "100%",
	padding: "10px 12px",
	borderRadius: "var(--dsw-radius-xl, 16px)",
	background: "var(--dsw-specific-bubble, var(--dsw-alias-surface-primary))",
	border: "1px solid var(--dsw-alias-border-primary, transparent)"
};
const fieldStyle = {
	display: "block",
	boxSizing: "border-box",
	width: "100%",
	minHeight: 44,
	maxHeight: "50vh",
	margin: 0,
	padding: 0,
	resize: "none",
	overflowY: "auto",
	border: "none",
	outline: "none",
	background: "transparent",
	color: "var(--dsw-alias-label-primary)",
	font: "inherit",
	fontSize: "var(--dsh-content-font-size, 14px)",
	lineHeight: "calc(22px + var(--dsh-content-font-delta, 0px))"
};
const footerStyle = {
	display: "flex",
	alignItems: "center",
	justifyContent: "flex-end",
	gap: 8
};
const noteStyle = {
	marginRight: "auto",
	color: "var(--dsw-alias-label-tertiary)",
	fontSize: 12,
	lineHeight: 1.5
};
const errorStyle = {
	margin: 0,
	color: "var(--dsw-alias-state-error-primary)",
	fontSize: 12,
	lineHeight: 1.5
};
const modalFieldStyle = {
	width: "100%",
	minHeight: 160,
	boxSizing: "border-box",
	resize: "vertical",
	padding: 8,
	borderRadius: 6,
	border: "1px solid var(--dsw-alias-border-primary)",
	background: "var(--dsw-alias-surface-primary)",
	color: "var(--dsw-alias-label-primary)",
	font: "inherit"
};
function PromptResendAction({ messageId, buttonTarget, onEditingChange, loadPrompt, resendPrompt, useSession, t }) {
	const running = useSession((s) => s.running);
	const subagent = useSession((s) => s.subagent);
	/** Row being edited; null while the editor is closed. */
	const [editing, setEditing] = (0, react.useState)(null);
	const [pending, setPending] = (0, react.useState)(false);
	const [prompt, setPrompt] = (0, react.useState)(null);
	const [text, setText] = (0, react.useState)("");
	const [error, setError] = (0, react.useState)(null);
	const [retryBlocked, setRetryBlocked] = (0, react.useState)(false);
	const [prepared, setPrepared] = (0, react.useState)(false);
	const alive = (0, react.useRef)(true);
	const request = (0, react.useRef)(false);
	const field = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const load = async () => {
		if (running || request.current || messageId === null) return;
		request.current = true;
		setPending(true);
		setError(null);
		setPrompt(null);
		setText("");
		setRetryBlocked(false);
		setPrepared(false);
		try {
			const result = await loadPrompt();
			if (!alive.current) return;
			if (!result.ok) {
				setRetryBlocked(true);
				setError(t(result.error.code === "AGENT_BUSY" ? "edit.error.busy" : "edit.error.load"));
			} else if (result.value.messageId !== messageId) {
				setRetryBlocked(true);
				setError(t("edit.error.changed"));
			} else {
				setPrompt(result.value);
				setText(result.value.text);
			}
		} catch {
			if (alive.current) {
				setRetryBlocked(true);
				setError(t("edit.error.unknown"));
			}
		} finally {
			request.current = false;
			if (alive.current) {
				setPending(false);
				setEditing(messageId);
			}
		}
	};
	const resend = async () => {
		if (running || request.current || prompt === null || retryBlocked || text.trim() === "") return;
		request.current = true;
		setPending(true);
		setError(null);
		try {
			const result = await resendPrompt(prompt.messageId, prompt.seq, text);
			if (!alive.current) return;
			if (result.ok) {
				setEditing(null);
				return;
			}
			const recovery = result.error.recovery;
			if (recovery !== void 0) {
				setPrompt(recovery.prompt);
				setPrepared(recovery.phase !== "save");
				setRetryBlocked(!recovery.retryable || recovery.submitted !== false);
				setError(t(recovery.submitted === false && recovery.retryable ? "edit.resend.retry" : "edit.resend.uncertain"));
			} else {
				const code = result.error.code;
				setRetryBlocked(code === "PROMPT_CHANGED" || code === "TARGET_NOT_FOUND" || code === "PROMPT_UNSUPPORTED");
				setError(t(code === "AGENT_BUSY" ? "edit.error.busy" : code === "PROMPT_CHANGED" ? "edit.error.changed" : code === "PROMPT_UNSUPPORTED" || code === "TARGET_NOT_FOUND" ? "edit.error.unavailable" : "edit.error.unknown"));
			}
		} catch {
			if (alive.current) {
				setRetryBlocked(true);
				setError(t("edit.resend.uncertain"));
			}
		} finally {
			request.current = false;
			if (alive.current) setPending(false);
		}
	};
	const cancel = () => {
		if (!request.current) {
			setEditing(null);
			setError(null);
		}
	};
	const inline = editing !== null && buttonTarget?.messageId === editing && buttonTarget.editorElement?.isConnected === true ? buttonTarget.editorElement : null;
	const inlineId = inline === null ? null : editing;
	(0, react.useEffect)(() => {
		onEditingChange?.(inlineId);
	}, [inlineId, onEditingChange]);
	(0, react.useEffect)(() => () => {
		onEditingChange?.(null);
	}, [onEditingChange]);
	(0, react.useLayoutEffect)(() => {
		const element = field.current;
		if (element === null || inline === null) return;
		element.style.height = "auto";
		element.style.height = `${String(element.scrollHeight)}px`;
	}, [text, inline]);
	(0, react.useEffect)(() => {
		const element = field.current;
		if (inline === null || element === null) return;
		element.focus();
		element.setSelectionRange(element.value.length, element.value.length);
	}, [inline]);
	if (subagent !== null) return null;
	const canSend = !running && !pending && prompt !== null && !retryBlocked && text.trim() !== "";
	const fieldDisabled = pending || prepared || retryBlocked || prompt === null;
	const onKeyDown = (event) => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			cancel();
		} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			resend();
		}
	};
	const sendLabel = pending ? t("edit.resend.pending") : t("edit.resend.submit");
	const notes = error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		role: "alert",
		style: {
			...errorStyle,
			marginRight: "auto"
		},
		children: error
	}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		style: noteStyle,
		children: [t("edit.resend.inlineNotice"), prompt !== null && prompt.attachmentCount > 0 ? ` ${t("edit.attachments")}` : ""]
	});
	const target = buttonTarget?.messageId === messageId && buttonTarget.element.isConnected ? buttonTarget : null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		target !== null && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tooltip, {
			label: running ? t("edit.action.busy") : t("edit.resend.action"),
			side: "bottom",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: target.buttonClass,
				"aria-label": t("edit.resend.action"),
				disabled: running || pending || editing !== null,
				onClick: () => {
					load();
				},
				style: { opacity: running || pending ? .45 : void 0 },
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: "16",
					height: "16",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.6",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-5-5L4 14z" })
				})
			})
		}), target.element),
		inline !== null && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			role: "group",
			"aria-label": t("edit.resend.title"),
			"data-prompt-editor": "",
			style: editorStyle,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				ref: field,
				"aria-label": t("edit.field"),
				value: text,
				rows: 1,
				disabled: fieldDisabled,
				onChange: (event) => setText(event.target.value),
				onKeyDown,
				style: fieldStyle
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: footerStyle,
				children: [
					notes,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						size: "sm",
						disabled: pending,
						onClick: cancel,
						children: t("edit.cancel")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						size: "sm",
						disabled: !canSend,
						onClick: () => {
							resend();
						},
						children: sendLabel
					})
				]
			})]
		}), inline),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(__deepseek_ai_dsh_client_ui_primitives.Modal, {
			open: editing !== null && inline === null && !pending,
			onClose: cancel,
			closeLabel: t("edit.cancel"),
			title: t("edit.resend.title"),
			description: t("edit.resend.description"),
			footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
				disabled: pending,
				onClick: cancel,
				children: t("edit.cancel")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
				disabled: !canSend,
				onClick: () => {
					resend();
				},
				children: sendLabel
			})] }),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
					"aria-label": t("edit.field"),
					value: text,
					onChange: (event) => setText(event.target.value),
					disabled: fieldDisabled,
					style: modalFieldStyle
				}),
				prompt !== null && prompt.attachmentCount > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("edit.attachments") }),
				error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					style: { color: "var(--dsw-alias-state-error-primary)" },
					children: error
				})
			]
		})
	] });
}

//#endregion
//#region src/client/index.tsx
const NS = "turn-delete";
const inject = [
	"slots",
	"locale",
	"uiConversation"
];
const REQUEST_TIMEOUT_MS = 1e4;
async function postJson(path, body, label) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal
		});
		const value = await response.json();
		if (typeof value !== "object" || value === null || typeof value.ok !== "boolean") throw new Error(`${label} returned HTTP ${String(response.status)}`);
		return value;
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw new Error(REQUEST_RESULT_UNKNOWN);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
async function postDelete(sessionId, assistantMessageId) {
	return postJson(TURN_DELETE_PATH, {
		sessionId,
		assistantMessageId
	}, "turn deletion");
}
async function postPrompt(body) {
	return postJson(PROMPT_EDIT_PATH, body, "prompt edit");
}
function apply(ctx) {
	ctx.uiConversation.events.register(turnDeletionDefinition);
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "turn-delete: dictionaries");
	if (ctx.slots.registerFactory !== void 0) ctx.slots.registerFactory({
		name: PROMPT_EDIT_FACTORY,
		scope: "session",
		locale: NS,
		inject: (sessionId) => ({
			loadPrompt: () => postPrompt({
				sessionId,
				action: "load"
			}),
			resendPrompt: (messageId, expectedSeq, text) => postJson(PROMPT_EDIT_PATH, {
				sessionId,
				action: "resend",
				messageId,
				expectedSeq,
				text
			}, "prompt resend")
		})
	}, PromptResendAction);
	ctx.effect(() => {
		const restoreNavigation = installTurnNavigationFilter(ctx.slots);
		const restorePlacement = ctx.slots.registerFactory === void 0 ? () => {} : installPromptEditPlacement(ctx.slots);
		return () => {
			restorePlacement();
			restoreNavigation();
		};
	}, "conversation-controls: chat adapters");
	ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
		name: "conversation.chat.assistant-actions",
		id: "turn-delete",
		order: 90,
		locale: NS,
		inject: (sessionId) => ({ deleteTurn: (assistantMessageId) => postDelete(sessionId, assistantMessageId) })
	}, TurnDeleteAction));
	ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
		name: "conversation.chat.turnTail",
		id: "turn-delete",
		order: 50,
		select: selectDeletedTurn
	}, DeletedTurnMarker));
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map