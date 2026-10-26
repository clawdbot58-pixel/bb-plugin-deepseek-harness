// Applies (and re-applies) the ACP patch to the installed dsh.
//
// Anchored insertions in @deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-acp/lib/index.js:
//   1. newSession(): advertise the harness's slash commands over ACP
//   2. AcpSession.prompt() head: run a bare command line instead of a model turn
//   3. module-scope helpers at end of file (function declarations hoist)
//   4. initialize()/routing: advertise `loadSession` and answer `session/load`
//      with dsh's persisted-session resume path.
//   5. fidelity projection: rotate session/event marshalling so ACP clients
//      receive what dsh keeps for its own UI —
//        * tool_call updates with a real kind (execute/read/edit/search/fetch),
//          a useful title, and file locations; bash streams its output as a
//          command row, filesystem tools become edit/reading rows, searches
//          show the pattern or query
//        * `todo/write` events become ACP `plan` updates (live task list)
//        * compaction/start + compaction/end become a visible lifecycle row
//   6. live stream: forward `agent/assistant-stream` reasoning/text deltas as
//      they arrive (deduplicated against the committed message) and show
//      LLM retries as a row, so a long or interrupted step is never blank.
//   7. row polish: closer tool kinds for run_code/run_command/job_*/skill and
//      no tool row for todo_write (it renders as the plan task list).
//   8. row style: remaining kind-"other" rows (unknown tools, compaction,
//      retries) become named switch_mode rows instead of bb's toolbox glyph.
//
// (4) matters for bb: its stable ACP adapter only restores a thread when the
// agent advertises the older `loadSession` capability, and it calls
// `session/load` for that. dsh only advertised the newer
// `sessionCapabilities.resume`, so bb always gave up and the thread continued
// in a brand-new dsh session without the earlier context. bb already keeps the
// transcript on its side and ignores replayed updates while loading, so routing
// `session/load` to the resume path restores the agent context without
// duplicating history.
//
// The client (bb) prepends a system-instructions block to the first prompt, so
// the command matcher looks for the last text block that is exactly one command
// line. The bridge injects neither `commands` nor an advertiser, so both helpers
// reach the service with ctx.get("commands").
//
// Idempotent: each insertion is checked and applied on its own. `npm i -g
// @deepseek-ai/dsh` replaces the package, so re-run this afterwards (the
// deepseek-harness plugin does that on install).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh-acp",
  "lib",
  "index.js",
);

const PROMPT_ANCHOR = `\tasync prompt(params, imageEnabled, requestSignal) {\n\t\tthis.assertActive();\n`;
const PROMPT_INJECT = `${PROMPT_ANCHOR}\t\tconst bbCommandLine = bbAcpCommandLine(params.prompt);\n\t\tif (bbCommandLine !== void 0) return bbAcpRunCommand(this, bbCommandLine, requestSignal);\n`;

const SESSION_ANCHOR = `\t\t\tsessions.set(sessionId, record);\n`;
const SESSION_INJECT = `${SESSION_ANCHOR}\t\t\tvoid bbAcpAdvertiseCommands(record);\n`;

const LOAD_CAP_ANCHOR = `\t\t\t\tagentCapabilities: {\n\t\t\t\t\tmcpCapabilities: { http: true },`;
const LOAD_CAP_INJECT = `\t\t\t\tagentCapabilities: {\n\t\t\t\t\t// bbAcpLoadSessionBridge: legacy ACP clients restore with session/load.\n\t\t\t\t\tloadSession: true,\n\t\t\t\t\tmcpCapabilities: { http: true },`;

const LOAD_ROUTE_ANCHOR = `.onRequest(methods.agent.session.close,`;
const LOAD_ROUTE_INJECT = `.onRequest(methods.agent.session.load, ({ params, signal }) => implementation.resumeSession(params, signal))${LOAD_ROUTE_ANCHOR}`;

// --- fidelity projection ---------------------------------------------------
// bb classifies a tool row from the update's kind, title, locations, and
// rawInput: kind "execute" + rawInput.command streams a live command row, kind
// edit/read/search/fetch pick their own glyphs, and `plan` updates render a
// task list. dsh's bridge only ever sent kind "other" with the raw tool name
// for a title, so every row collapsed to "bash", "read", "grep" with nothing
// in it, and todo/compactivity facts never left dsh at all.
const TOOLCALL_ANCHOR = `update: toolCallUpdate(event)`;
const TOOLCALL_INJECT = `update: bbAcpProjectToolCall(event)`;

const RESULTS_BRANCH_ANCHOR = `\t\t\t} else if (event.type === "tool/result") {`;
const RESULTS_BRANCH_INJECT = `\t\t\t} else if (event.type === "todo/write" || event.type === "compaction/start" || event.type === "compaction/end") {
\t\t\t\tconst projection = event.type === "todo/write"
\t\t\t\t\t? bbAcpTodoPlanUpdate(event)
\t\t\t\t\t: bbAcpCompactionUpdate(event, event.type === "compaction/start" ? "start" : "end");
\t\t\t\tif (projection !== void 0) {
\t\t\t\t\tconst previous = this.outputTail;
\t\t\t\t\tthis.outputTail = previous.then(() => this.notify({
\t\t\t\t\t\tsessionId: this.agent.session.id,
\t\t\t\t\t\tupdate: projection
\t\t\t\t\t})).catch((error) => {
\t\t\t\t\t\tthis.ctx.logger.warn(\`acp: session projection delivery failed: \${errorChain(error)}\`);
\t\t\t\t\t});
\t\t\t\t}
${RESULTS_BRANCH_ANCHOR}`;

// --- live stream -----------------------------------------------------------
// The bridge marshals only committed session events. A model step that thinks
// for minutes, retries a failing backend, or is cut short by a crash therefore
// showed in bb as a bare "running" turn with nothing in it, and an interrupted
// step's output never arrived at all. dsh already publishes the live stream as
// `agent/assistant-stream` frames (its headless runner and web UI use them).
const STREAM_SUB_ANCHOR = `\tctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {\n`;
const STREAM_SUB_INJECT = `\t// bbAcpLiveStream: forward the top-level agent's assistant stream as it arrives.\n\tctx.on("agent/assistant-stream", ({ agent, frame }) => {\n\t\tconst record = ownedRecord(agent);\n\t\tif (record !== void 0) bbAcpOnAssistantStream(record, frame);\n\t});\n${STREAM_SUB_ANCHOR}`;

const ASSISTANT_ANCHOR = `for (const update of await assistantUpdates(this.ctx, session, event)) await this.notify({`;
const ASSISTANT_INJECT = `for (const update of bbAcpDedupAssistant(this, event, await assistantUpdates(this.ctx, session, event))) await this.notify({`;

const RETRY_BRANCH_INJECT = `\t\t\t} else if (event.type === "llm/retry" || event.type === "turn/end") {
\t\t\t\tconst completed = event.type === "turn/end" && event.data?.reason?.kind === "completed";
\t\t\t\tbbAcpEnqueue(this, event.type === "llm/retry" ? bbAcpRetryUpdates(this, event) : bbAcpCloseRetries(this, completed ? "completed" : "failed"), "retry projection");
${RESULTS_BRANCH_ANCHOR}`;

// --- row polish -------------------------------------------------------------
// Kind "other" renders with bb's generic toolbox glyph. Re-route the dsh tools
// that have a closer kind, and hide todo_write's row (its plan update is the
// task list). Layered on the fidelity section so already-patched installs pick
// it up without a reinstall of dsh.
const POLISH_CALL_ANCHOR = `update: bbAcpProjectToolCall(event)`;
const POLISH_CALL_INJECT = `update: bbAcpPolishToolCall(event)`;
const TOOL_CALL_BRANCH_ANCHOR = `\t\t\t} else if (event.type === "tool/call") {`;
const TOOL_CALL_BRANCH_INJECT = `\t\t\t} else if ((event.type === "tool/call" || event.type === "tool/result") && bbAcpHiddenTool(this, event)) {\n\t\t\t\t// bbAcpRowPolish: todo_write already renders as the plan; skip its tool row.\n${TOOL_CALL_BRANCH_ANCHOR}`;

// --- row style ---------------------------------------------------------------
// Rows still on kind "other" (unknown tools, subagents, goals, compaction,
// retries) get bb's toolbox glyph. Restyle them as named switch_mode rows.
const STYLE_CALL_ANCHOR = `update: bbAcpPolishToolCall(event)`;
const STYLE_CALL_INJECT = `update: bbAcpStyleRow(bbAcpPolishToolCall(event), event) /* bbAcpRowStyle */`;
const STYLE_COMPACTION_ANCHOR = `: bbAcpCompactionUpdate(event, event.type === "compaction/start" ? "start" : "end");`;
const STYLE_COMPACTION_INJECT = `: bbAcpStyleRow(bbAcpCompactionUpdate(event, event.type === "compaction/start" ? "start" : "end"));`;
const STYLE_RETRY_ANCHOR = `event.type === "llm/retry" ? bbAcpRetryUpdates(this, event) :`;
const STYLE_RETRY_INJECT = `event.type === "llm/retry" ? bbAcpRetryUpdates(this, event).map((update) => bbAcpStyleRow(update)) :`;

const HELPERS = `
// bb patch (reapply with E:/dsh-plugins/dsh-acp-command-patch.mjs):
// 1) advertise the harness command registry so ACP clients can list it,
// 2) run a prompt whose last text block is exactly one harness command,
//    instead of opening a model turn.
function bbAcpCommandList(record) {
\tconst commands = record.ctx.get?.("commands");
\tif (commands === void 0) return [];
\ttry {
\t\treturn commands.list(record.agent) ?? [];
\t} catch {
\t\treturn [];
\t}
}
async function bbAcpAdvertiseCommands(record) {
\tconst availableCommands = bbAcpCommandList(record).map((entry) => ({
\t\tname: entry.name,
\t\tdescription: entry.description ?? "",
\t\t...(entry.input?.hint ? { input: { hint: entry.input.hint } } : {})
\t}));
\tif (availableCommands.length === 0) return;
\ttry {
\t\tawait record.notify({
\t\t\tsessionId: record.agent.session.id,
\t\t\tupdate: { sessionUpdate: "available_commands_update", availableCommands }
\t\t});
\t} catch {
\t\t// advertising is best-effort; never block session creation
\t}
}
function bbAcpCommandLine(prompt) {
\tif (!Array.isArray(prompt)) return void 0;
\tlet candidate;
\tfor (const block of prompt) {
\t\tif (block === null || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") continue;
\t\tconst text = block.text.trim();
\t\tif (/^\\/[a-z0-9][a-z0-9_-]*$/u.test(text)) candidate = text;
\t}
\treturn candidate;
}
async function bbAcpRunCommand(record, line, signal) {
\tconst commands = record.ctx.get?.("commands");
\tif (commands === void 0) throw new Error("the ACP bridge cannot reach the commands service");
\tconst execution = await commands.execute(record.agent, line, [], signal);
\tconst text = execution === void 0
\t\t? \`Unknown command: \${line}\`
\t\t: execution.result.kind === "error"
\t\t\t? execution.result.text
\t\t\t: execution.result.text ?? \`\${line} completed\`;
\tawait record.notify({
\t\tsessionId: record.agent.session.id,
\t\tupdate: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
\t});
\treturn { stopReason: "end_turn" };
}
`;

const FIDELITY_HELPERS = `
// bb patch (fidelity projection): reflect dsh's UI-only facts over standard ACP
// updates so clients like bb render them natively: real tool kinds, useful
// titles, file locations, todo lists as plan updates, and a compaction row.
function bbAcpIsObject(value) {
\treturn value !== null && typeof value === "object" && !Array.isArray(value);
}
function bbAcpParseArgs(raw) {
\tif (typeof raw !== "string" || raw.trim().length === 0) return void 0;
\ttry {
\t\tconst parsed = JSON.parse(raw);
\t\treturn Array.isArray(parsed) ? void 0 : parsed;
\t} catch {
\t\treturn void 0;
\t}
}
function bbAcpPick(args, key) {
\tif (!bbAcpIsObject(args)) return void 0;
\tconst value = args[key];
\treturn typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function bbAcpTitle(value, limit = 160) {
\tif (typeof value !== "string") return void 0;
\tconst text = value.replace(/\\s+/gu, " ").trim();
\tif (text.length === 0) return void 0;
\treturn text.length > limit ? \`\${text.slice(0, limit - 1)}\\u2026\` : text;
}
function bbAcpLocation(args, keys) {
\tif (!bbAcpIsObject(args)) return void 0;
\tfor (const key of keys) {
\t\tconst location = bbAcpPick(args, key);
\t\tif (location !== void 0) return [{ path: location }];
\t}
\treturn void 0;
}
function bbAcpToolUpdate(event, kind, title, locations) {
\treturn {
\t\tsessionUpdate: "tool_call",
\t\ttoolCallId: event.data.callId,
\t\ttitle: title ?? event.data.name,
\t\tkind,
\t\tstatus: "in_progress",
\t\trawInput: parseToolArguments(event.data.arguments),
\t\t...locations === void 0 ? {} : { locations }
\t};
}
function bbAcpProjectToolCall(event) {
\ttry {
\t\tconst data = event?.data;
\t\tif (!bbAcpIsObject(data) || typeof data.callId !== "string" || typeof data.name !== "string") return toolCallUpdate(event);
\t\tconst args = bbAcpParseArgs(data.arguments);
\t\tswitch (data.name) {
\t\t\tcase "bash":
\t\t\t\treturn bbAcpToolUpdate(event, "execute", bbAcpTitle(bbAcpPick(args, "command")));
\t\t\tcase "run_code":
\t\t\t\treturn bbAcpToolUpdate(event, "other", bbAcpTitle(bbAcpPick(args, "description") ?? bbAcpPick(args, "code")));
\t\t\tcase "read":
\t\t\tcase "read_image":
\t\t\t\treturn bbAcpToolUpdate(event, "read", bbAcpTitle(bbAcpPick(args, "file_path")), bbAcpLocation(args, ["file_path"]));
\t\t\tcase "write":
\t\t\tcase "edit":
\t\t\t\treturn bbAcpToolUpdate(event, "edit", bbAcpTitle(bbAcpPick(args, "file_path")), bbAcpLocation(args, ["file_path"]));
\t\t\tcase "str_replace_editor": {
\t\t\t\tconst kind = bbAcpPick(args, "command") === "view" ? "read" : "edit";
\t\t\t\treturn bbAcpToolUpdate(event, kind, bbAcpTitle(bbAcpPick(args, "path") ?? bbAcpPick(args, "file_path")), bbAcpLocation(args, ["path", "file_path"]));
\t\t\t}
\t\t\tcase "glob":
\t\t\tcase "grep":
\t\t\t\treturn bbAcpToolUpdate(event, "search", bbAcpTitle(bbAcpPick(args, "pattern")), bbAcpLocation(args, ["path"]));
\t\t\tcase "web_search": {
\t\t\t\tconst queries = Array.isArray(args?.queries) ? args.queries.filter((entry) => typeof entry === "string").join(" | ") : bbAcpPick(args, "query");
\t\t\t\treturn bbAcpToolUpdate(event, "search", bbAcpTitle(queries));
\t\t\t}
\t\t\tcase "web_fetch":
\t\t\t\treturn bbAcpToolUpdate(event, "fetch", bbAcpTitle(bbAcpPick(args, "url")));
\t\t\tcase "ask_user_question": {
\t\t\t\tconst first = Array.isArray(args?.questions) ? args.questions[0] : void 0;
\t\t\t\tconst text = typeof first?.header === "string" ? first.header : typeof first?.question === "string" ? first.question : void 0;
\t\t\t\treturn bbAcpToolUpdate(event, "other", bbAcpTitle(text));
\t\t\t}
\t\t\tcase "subagent":
\t\t\t\treturn bbAcpToolUpdate(event, "other", bbAcpTitle(bbAcpPick(args, "description") ?? bbAcpPick(args, "prompt")));
\t\t\tcase "run_command":
\t\t\t\treturn bbAcpToolUpdate(event, "other", bbAcpTitle(bbAcpPick(args, "command")));
\t\t\tcase "create_goal":
\t\t\tcase "update_goal":
\t\t\t\treturn bbAcpToolUpdate(event, "other", bbAcpTitle(bbAcpPick(args, "objective")));
\t\t\tcase "skill":
\t\t\t\treturn bbAcpToolUpdate(event, "other", bbAcpTitle(bbAcpPick(args, "name") ?? bbAcpPick(args, "skill")));
\t\t\tdefault:
\t\t\t\treturn toolCallUpdate(event);
\t\t}
\t} catch {
\t\treturn toolCallUpdate(event);
\t}
}
function bbAcpTodoPlanUpdate(event) {
\ttry {
\t\tconst todos = event?.data?.todos;
\t\tif (!Array.isArray(todos) || todos.length === 0) return void 0;
\t\tconst entries = [];
\t\tfor (const todo of todos) {
\t\t\tif (!bbAcpIsObject(todo) || typeof todo.content !== "string" || todo.content.trim().length === 0) return void 0;
\t\t\tentries.push({
\t\t\t\tcontent: todo.content,
\t\t\t\tstatus: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending"
\t\t\t});
\t\t}
\t\treturn { sessionUpdate: "plan", entries };
\t} catch {
\t\treturn void 0;
\t}
}
function bbAcpCompactionUpdate(event, stage) {
\ttry {
\t\tconst data = event?.data;
\t\tconst compactionId = bbAcpIsObject(data) && typeof data.compactionId === "string" && data.compactionId.length > 0 ? data.compactionId : "current";
\t\tconst toolCallId = \`bbAcpCompaction:\${compactionId}\`;
\t\tif (stage === "end") {
\t\t\tconst failure = bbAcpTitle(data?.error, 400);
\t\t\tconst content = failure === void 0 ? [] : [{ type: "content", content: { type: "text", text: \`Compaction failed: \${failure}\` } }];
\t\t\treturn { sessionUpdate: "tool_call_update", toolCallId, status: failure === void 0 ? "completed" : "failed", content };
\t\t}
\t\treturn {
\t\t\tsessionUpdate: "tool_call",
\t\t\ttoolCallId,
\t\t\ttitle: "Compacting conversation history",
\t\t\tkind: "other",
\t\t\tstatus: "in_progress"
\t\t};
\t} catch {
\t\treturn void 0;
\t}
}
`;

const LIVE_HELPERS = `
// bb patch (live stream): dsh's bridge only marshals committed events, so a
// long model step (minutes of thinking, retries, compaction) reached ACP as
// nothing at all and an interrupted step never reached it. Forward the
// agent's live assistant stream as it arrives, drop the text the committed
// message would repeat, and surface LLM retries as a lifecycle row.
function bbAcpLiveState(record) {
\trecord.bbAcpLive ??= { attempts: new Map(), streamed: new Set(), retries: new Set() };
\treturn record.bbAcpLive;
}
function bbAcpEnqueue(record, updates, label) {
\tfor (const update of updates) {
\t\tconst previous = record.outputTail;
\t\trecord.outputTail = previous.then(() => record.notify({
\t\t\tsessionId: record.agent.session.id,
\t\t\tupdate
\t\t})).catch((error) => {
\t\t\trecord.ctx.logger.warn(\`acp: \${label} delivery failed: \${errorChain(error)}\`);
\t\t});
\t}
}
function bbAcpCloseRetries(record, status) {
\tconst live = record.bbAcpLive;
\tif (live === void 0 || live.retries.size === 0) return [];
\tconst updates = [...live.retries].map((toolCallId) => ({ sessionUpdate: "tool_call_update", toolCallId, status }));
\tlive.retries.clear();
\treturn updates;
}
function bbAcpOnAssistantStream(record, frame) {
\ttry {
\t\tif (record.closing !== void 0 || !bbAcpIsObject(frame)) return;
\t\tconst live = bbAcpLiveState(record);
\t\tif (frame.type === "start") {
\t\t\tlive.attempts.set(frame.attemptId, \`\${frame.turn}:\${frame.step}\`);
\t\t\treturn;
\t\t}
\t\tif (frame.type === "end") {
\t\t\tlive.attempts.delete(frame.attemptId);
\t\t\treturn;
\t\t}
\t\tconst chunk = frame.chunk;
\t\tif (frame.type !== "chunk" || !bbAcpIsObject(chunk) || typeof chunk.text !== "string" || chunk.text.length === 0) return;
\t\tlet sessionUpdate;
\t\tif (chunk.type === "reasoning-delta") sessionUpdate = "agent_thought_chunk";
\t\telse if (chunk.type === "text-delta") sessionUpdate = "agent_message_chunk";
\t\telse return;
\t\tconst key = live.attempts.get(frame.attemptId);
\t\tif (key !== void 0) live.streamed.add(key);
\t\tbbAcpEnqueue(record, [...bbAcpCloseRetries(record, "completed"), { sessionUpdate, content: { type: "text", text: chunk.text } }], "live stream");
\t} catch {
\t\t// live output is best-effort; the committed message still arrives
\t}
}
function bbAcpDedupAssistant(record, event, updates) {
\tconst live = record.bbAcpLive;
\tconst key = \`\${event?.data?.turn}:\${event?.data?.step}\`;
\tconst closing = bbAcpCloseRetries(record, "completed");
\tif (live === void 0 || !live.streamed.has(key)) return [...closing, ...updates];
\tlive.streamed.delete(key);
\treturn [...closing, ...updates.filter((update) => update.sessionUpdate !== "agent_thought_chunk" && !(update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text"))];
}
function bbAcpRetryUpdates(record, event) {
\ttry {
\t\tconst data = event?.data;
\t\tif (!bbAcpIsObject(data)) return [];
\t\tconst live = bbAcpLiveState(record);
\t\tconst toolCallId = \`bbAcpRetry:\${typeof data.retryId === "string" ? data.retryId : "current"}\`;
\t\tconst attempt = typeof data.retry === "number" ? \`\${data.retry}\${typeof data.maxRetries === "number" ? \`/\${data.maxRetries}\` : ""}\` : "";
\t\tconst delay = typeof data.delayMs === "number" ? \` in \${Math.max(1, Math.round(data.delayMs / 1e3))}s\` : "";
\t\tconst title = \`Model request failed, retry \${attempt}\${delay}\`.replace(/\\s+/gu, " ").trim();
\t\tconst failure = bbAcpTitle(data.failure?.message, 400);
\t\tconst content = failure === void 0 ? [] : [{ type: "content", content: { type: "text", text: failure } }];
\t\tif (live.retries.has(toolCallId)) return [{ sessionUpdate: "tool_call_update", toolCallId, title, status: "in_progress", content }];
\t\tlive.retries.add(toolCallId);
\t\treturn [{ sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "in_progress", content }];
\t} catch {
\t\treturn [];
\t}
}
`;

const POLISH_HELPERS = `
// bb patch (row polish): bb draws kind "other" with a generic toolbox glyph.
// Give the remaining dsh tools the nearest real kind, and drop todo_write's
// row since the same call already renders as the plan task list.
function bbAcpHiddenTool(record, event) {
\ttry {
\t\trecord.bbAcpHidden ??= new Set();
\t\tif (event.type === "tool/call") {
\t\t\tif (event.data?.name !== "todo_write" || typeof event.data.callId !== "string") return false;
\t\t\trecord.bbAcpHidden.add(event.data.callId);
\t\t\treturn true;
\t\t}
\t\tconst callId = event.data?.message?.toolCallId;
\t\treturn record.bbAcpHidden.delete(callId);
\t} catch {
\t\treturn false;
\t}
}
function bbAcpPolishToolCall(event) {
\ttry {
\t\tconst data = event?.data;
\t\tif (bbAcpIsObject(data) && typeof data.callId === "string" && typeof data.name === "string") {
\t\t\tconst args = bbAcpParseArgs(data.arguments);
\t\t\tswitch (data.name) {
\t\t\t\tcase "run_code":
\t\t\t\t\treturn bbAcpToolUpdate(event, "execute", bbAcpTitle(bbAcpPick(args, "description") ?? bbAcpPick(args, "code")));
\t\t\t\tcase "run_command":
\t\t\t\t\treturn bbAcpToolUpdate(event, "execute", bbAcpTitle(bbAcpPick(args, "command")));
\t\t\t\tcase "job_output":
\t\t\t\tcase "job_kill":
\t\t\t\tcase "job_list":
\t\t\t\t\treturn bbAcpToolUpdate(event, "execute", bbAcpTitle(\`\${data.name.replace("_", " ")} \${bbAcpPick(args, "job_id") ?? ""}\`));
\t\t\t\tcase "skill":
\t\t\t\t\treturn bbAcpToolUpdate(event, "read", bbAcpTitle(bbAcpPick(args, "name") ?? bbAcpPick(args, "skill")));
\t\t\t}
\t\t}
\t} catch {
\t\t// fall through to the fidelity projection
\t}
\treturn bbAcpProjectToolCall(event);
}
`;

const STYLE_HELPERS = `
// bb patch (row style): kind "other" is drawn with bb's toolbox glyph, which
// reads as a suitcase. Send the remaining generic rows as "switch_mode" (a
// sliders glyph) with an explicit tool name, so bb labels them "Ran <name>"
// instead of "Switched mode".
function bbAcpStyleRow(update, event) {
\ttry {
\t\tif (!bbAcpIsObject(update) || update.sessionUpdate !== "tool_call" || update.kind !== "other") return update;
\t\tconst id = typeof update.toolCallId === "string" ? update.toolCallId : "";
\t\tlet name;
\t\tlet title = update.title;
\t\tif (id.startsWith("bbAcpCompaction:")) {
\t\t\tname = "compaction";
\t\t\ttitle = "conversation history";
\t\t} else if (id.startsWith("bbAcpRetry:")) name = "model retry";
\t\telse name = typeof event?.data?.name === "string" ? event.data.name : void 0;
\t\tif (name === void 0) return update;
\t\tconst styled = { ...update, kind: "switch_mode", name };
\t\tif (title === void 0 || title === name) delete styled.title;
\t\telse styled.title = title;
\t\treturn styled;
\t} catch {
\t\treturn update;
\t}
}
`;

function fail(message) {
  console.error(`${message} — dsh-acp changed shape; inspect before patching`);
  process.exit(1);
}

try {
  const original = fs.readFileSync(FILE, "utf8");
  let source = original;
  const applied = [];

  if (!source.includes("bbAcpRunCommand")) {
    for (const [label, anchor] of [
      ["prompt()", PROMPT_ANCHOR],
      ["newSession()", SESSION_ANCHOR],
    ]) {
      if (!source.includes(anchor)) fail(`anchor not found in ${label}`);
    }
    source = source.replace(PROMPT_ANCHOR, PROMPT_INJECT).replace(SESSION_ANCHOR, SESSION_INJECT) + HELPERS;
    applied.push("command bridge");
  }

  if (!source.includes("bbAcpLoadSessionBridge")) {
    for (const [label, anchor] of [
      ["initialize() capabilities", LOAD_CAP_ANCHOR],
      ["request routing", LOAD_ROUTE_ANCHOR],
    ]) {
      if (!source.includes(anchor)) fail(`anchor not found in ${label}`);
    }
    source = source.replace(LOAD_CAP_ANCHOR, LOAD_CAP_INJECT).replace(LOAD_ROUTE_ANCHOR, LOAD_ROUTE_INJECT);
    applied.push("session/load bridge");
  }

  if (!source.includes("bbAcpProjectToolCall")) {
    for (const [label, anchor] of [
      ["tool_call marshalling", TOOLCALL_ANCHOR],
      ["tool/result branch", RESULTS_BRANCH_ANCHOR],
    ]) {
      if (!source.includes(anchor)) fail(`anchor not found in ${label}`);
    }
    source = source.replace(TOOLCALL_ANCHOR, TOOLCALL_INJECT).replace(RESULTS_BRANCH_ANCHOR, RESULTS_BRANCH_INJECT) + FIDELITY_HELPERS;
    applied.push("fidelity projection");
  }

  if (!source.includes("bbAcpLiveStream")) {
    for (const [label, anchor] of [
      ["assistant-stream subscription", STREAM_SUB_ANCHOR],
      ["assistant/message marshalling", ASSISTANT_ANCHOR],
      ["tool/result branch", RESULTS_BRANCH_ANCHOR],
    ]) {
      if (!source.includes(anchor)) fail(`anchor not found in ${label}`);
    }
    source = source
      .replace(STREAM_SUB_ANCHOR, STREAM_SUB_INJECT)
      .replace(ASSISTANT_ANCHOR, ASSISTANT_INJECT)
      .replace(RESULTS_BRANCH_ANCHOR, RETRY_BRANCH_INJECT) + LIVE_HELPERS;
    applied.push("live stream");
  }

  if (!source.includes("bbAcpRowPolish")) {
    for (const [label, anchor] of [
      ["fidelity tool_call projection", POLISH_CALL_ANCHOR],
      ["tool/call branch", TOOL_CALL_BRANCH_ANCHOR],
    ]) {
      if (!source.includes(anchor)) fail(`anchor not found in ${label}`);
    }
    source = source
      .replace(POLISH_CALL_ANCHOR, POLISH_CALL_INJECT)
      .replace(TOOL_CALL_BRANCH_ANCHOR, TOOL_CALL_BRANCH_INJECT) + POLISH_HELPERS;
    applied.push("row polish");
  }

  if (!source.includes("bbAcpRowStyle")) {
    for (const [label, anchor] of [
      ["polished tool_call projection", STYLE_CALL_ANCHOR],
      ["compaction projection", STYLE_COMPACTION_ANCHOR],
      ["retry projection", STYLE_RETRY_ANCHOR],
    ]) {
      if (!source.includes(anchor)) fail(`anchor not found in ${label}`);
    }
    source = source
      .replace(STYLE_CALL_ANCHOR, STYLE_CALL_INJECT)
      .replace(STYLE_COMPACTION_ANCHOR, STYLE_COMPACTION_INJECT)
      .replace(STYLE_RETRY_ANCHOR, STYLE_RETRY_INJECT) + STYLE_HELPERS;
    applied.push("row style");
  }

  if (applied.length === 0) {
    console.log("already patched:", FILE);
    process.exit(0);
  }

  // Keep the pristine package copy for reference/repair, but never overwrite it
  // once it exists: it must stay the unpatched source.
  if (!fs.existsSync(`${FILE}.pre-bb`)) fs.writeFileSync(`${FILE}.pre-bb`, original);
  fs.writeFileSync(FILE, source);
  console.log("patched:", FILE, `(${applied.join(", ")})`);
  console.log("backup:", `${FILE}.pre-bb`);
} catch (err) {
  console.error("patch failed:", err.message);
  process.exit(1);
}
