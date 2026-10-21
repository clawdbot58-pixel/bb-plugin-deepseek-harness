// Applies (and re-applies) the ACP patch to the installed dsh.
//
// Anchored insertions in @deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-acp/lib/index.js:
//   1. newSession(): advertise the harness's slash commands over ACP
//   2. AcpSession.prompt() head: run a bare command line instead of a model turn
//   3. module-scope helpers at end of file (function declarations hoist)
//   4. initialize()/routing: advertise `loadSession` and answer `session/load`
//      with dsh's persisted-session resume path.
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
