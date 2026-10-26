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
\t\t\t\t}${RESULTS_BRANCH_ANCHOR}`;

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
