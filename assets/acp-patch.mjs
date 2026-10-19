// Applies (and re-applies) the ACP patch to the installed dsh.
//
// Three anchored insertions in @deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-acp/lib/index.js:
//   1. newSession(): advertise the harness's slash commands over ACP
//   2. AcpSession.prompt() head: run a bare command line instead of a model turn
//   3. module-scope helpers at end of file (function declarations hoist)
//
// The client (bb) prepends a system-instructions block to the first prompt, so
// the matcher looks for the last text block that is exactly one command line.
// The bridge injects neither `commands` nor an advertiser, so both helpers
// reach the service with ctx.get("commands").
//
// Idempotent: an already-patched file is reported and left alone. `npm i -g
// @deepseek-ai/dsh` replaces the package, so re-run this afterwards.
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

try {
  const source = fs.readFileSync(FILE, "utf8");
  if (source.includes("bbAcpRunCommand")) {
    console.log("already patched:", FILE);
    process.exit(0);
  }
  for (const [label, anchor] of [
    ["prompt()", PROMPT_ANCHOR],
    ["newSession()", SESSION_ANCHOR],
  ]) {
    if (!source.includes(anchor)) {
      console.error(`anchor not found in ${label} — dsh-acp changed shape; inspect before patching`);
      process.exit(1);
    }
  }
  fs.writeFileSync(`${FILE}.pre-bb`, source);
  const patched = source.replace(PROMPT_ANCHOR, PROMPT_INJECT).replace(SESSION_ANCHOR, SESSION_INJECT);
  fs.writeFileSync(FILE, patched + HELPERS);
  console.log("patched:", FILE);
  console.log("backup:", `${FILE}.pre-bb`);
} catch (err) {
  console.error("patch failed:", err.message);
  process.exit(1);
}
