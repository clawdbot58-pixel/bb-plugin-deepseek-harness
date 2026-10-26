// bb-plugin-deepseek-harness — DeepSeek Harness (dsh) as a first-class bb agent.
//
// The plugin owns four moving parts, all provisioned by `bb deepseek-harness install`:
//   1. a launcher that boots dsh with the mode selected in the composer banner
//   2. three dsh profiles: acp (standard), acp-creator, acp-minimal
//   3. a dsh plugin (`run_command`) that exposes harness slash commands to ACP
//   4. a small patch to dsh-acp so a bare command line runs the command layer
//
// It registers the provider by updating the ACP providers plugin's customAgents
// setting, so no manual JSON editing is required.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const exec = promisify(execFile);

const MODES = ["standard", "creator", "minimal"] as const;
type DshMode = (typeof MODES)[number];

const modeSchema = z.enum(MODES);
const threadIdSchema = z.string().min(3).max(80).regex(/^[A-Za-z0-9_-]+$/u);

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".bb-dsh-modes");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const THREAD_DIR = path.join(STATE_DIR, "threads");
const LAUNCHER = path.join(STATE_DIR, "launcher.mjs");
const ACP_PATCH = path.join(STATE_DIR, "acp-patch.mjs");
const TOOL_ASSETS = path.join(STATE_DIR, "dsh-command-tool");
const PROFILES = ["acp", "acp-creator", "acp-minimal"] as const;
const PROFILE_MODE: Record<(typeof PROFILES)[number], string> = {
  acp: "standard",
  "acp-creator": "creator",
  "acp-minimal": "minimal",
};

/** Bundlers rewrite import.meta.url to the source file, so walk up to the assets folder. */
function findAssets(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = path.join(dir, "assets");
    if (fs.existsSync(path.join(candidate, "launcher.mjs"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("assets folder not found next to the plugin bundle");
}
const asset = (relative: string): string => path.join(findAssets(), relative);

const DSH_ROOT = path.join(process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"), "npm", "node_modules", "@deepseek-ai", "dsh");
const DSH_BIN = path.join(DSH_ROOT, "lib", "bin.js");
const DSH_ACP_FILE = path.join(DSH_ROOT, "node_modules", "@deepseek-ai", "dsh-acp", "lib", "index.js");
const DSH_TOOLS = path.join(DSH_ROOT, "node_modules", "@deepseek-ai", "dsh-tools");

const stateSchema = z.object({ mode: modeSchema.optional(), updatedAt: z.string().optional() });

const childSchema = z.object({
  id: z.string(),
  label: z.string(),
  mode: z.string(),
  status: z.enum(["running", "settled", "idle", "unknown"]),
  createdAt: z.number(),
  elapsedMs: z.number().nullable(),
  turns: z.number().nullable(),
  tokens: z.number().nullable(),
  activity: z.string().nullable(),
  activityAgeMs: z.number().nullable(),
});

export const rpcContract = defineRpcContract({
  mode_get: {
    input: z.object({ threadId: threadIdSchema.optional() }),
    output: z.object({ mode: modeSchema, threadMode: modeSchema.nullable() }),
  },
  mode_set: {
    input: z.object({ mode: modeSchema, threadId: threadIdSchema.optional() }),
    output: z.object({ mode: modeSchema }),
  },
  // Deployed dsh subagents for one bb thread. The roster comes from dsh's own
  // subagentCatalog projection; the activity line comes from the newest zstd
  // frame of that child's session log.
  subagents_get: {
    input: z.object({ threadId: threadIdSchema }),
    output: z.object({
      sessionId: z.string().nullable(),
      children: z.array(childSchema),
    }),
  },
  subagent_detail: {
    input: z.object({ threadId: threadIdSchema, childId: z.string().min(8).max(80) }),
    output: z.object({
      prompt: z.string().nullable(),
      result: z.string().nullable(),
      steps: z.array(z.string()),
      toolCount: z.number(),
    }),
  },
  // The composition this thread booted with. dsh cannot change it afterwards, so
  // the thread composer shows it read-only; the picker lives in New thread only.
  thread_mode: {
    input: z.object({ threadId: threadIdSchema }),
    output: z.object({
      mode: modeSchema.nullable(),
      source: z.enum(["recorded", "log", "none"]),
    }),
  },
});

function readFileJson<T>(file: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function readState(): DshMode {
  return readFileJson(STATE_FILE, stateSchema)?.mode ?? "standard";
}

function writeState(mode: DshMode): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

function writeThreadMode(threadId: string, mode: DshMode): void {
  fs.mkdirSync(THREAD_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(THREAD_DIR, `${threadId}.json`), `${JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

function readThreadMode(threadId: string): DshMode | null {
  return readFileJson(path.join(THREAD_DIR, `${threadId}.json`), stateSchema)?.mode ?? null;
}

const LAUNCHER_LOG = path.join(STATE_DIR, "launcher.log");

/**
 * The composition a thread booted with. The launcher records it on every launch;
 * the launcher log covers threads started before that record existed.
 */
function threadMode(threadId: string): { mode: DshMode | null; source: "recorded" | "log" | "none" } {
  const recorded = readThreadMode(threadId);
  if (recorded !== null) return { mode: recorded, source: "recorded" };
  try {
    const escaped = threadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`launch thread=${escaped} mode=(standard|creator|minimal)\\b`, "gu");
    const text = fs.readFileSync(LAUNCHER_LOG, "utf8");
    let last: DshMode | null = null;
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (value === "standard" || value === "creator" || value === "minimal") last = value;
    }
    if (last !== null) return { mode: last, source: "log" };
  } catch {
    // no log yet
  }
  return { mode: null, source: "none" };
}

async function run(command: string, args: readonly string[], timeout = 180_000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(command, [...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, out: detail };
  }
}

function ensureLink(target: string, at: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    if (path.resolve(fs.realpathSync(at)) === path.resolve(target)) return;
    // Unlink a Windows junction instead of removing recursively: rmSync follows
    // the link and deletes the contents of the directory it points at.
    if (fs.lstatSync(at).isSymbolicLink()) fs.unlinkSync(at);
    else fs.rmSync(at, { recursive: true, force: true });
  } catch {
    // missing: create below
  }
  fs.symlinkSync(target, at, "junction");
}

/** Appended to every profile patch: run_command row + stable compaction policy. */
const PROFILE_BLOCK = `# Managed by bb plugin deepseek-harness.
# run_command exposes harness slash commands (e.g. /compact) to ACP clients.
- insert:
    - id: command-tool
      name: '@deepseek-ai/dsh-command-tool'
# Keep automatic condensation on: /compact over ACP is refused mid-thread.
- id: compaction-basic
  config:
    auto: true
`;

function provisionProfile(profile: string): string {
  const dir = path.join(HOME, ".dsh", "profiles", profile);
  const file = path.join(dir, "cordis.patch.yml");
  if (!fs.existsSync(file)) return `${profile}: missing (create it with: dsh ${profile} --from-default-profile acp --dump-config)`;
  const body = fs.readFileSync(file, "utf8");
  if (body.includes("command-tool")) return `${profile}: already patched`;
  fs.writeFileSync(file, `${body.replace(/\s*$/u, "")}\n${PROFILE_BLOCK}`);
  return `${profile}: patched`;
}

async function provision(): Promise<string[]> {
  const log: string[] = [];
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.copyFileSync(asset("launcher.mjs"), LAUNCHER);
  log.push(`launcher: ${LAUNCHER}`);

  // The launcher re-applies these after a dsh upgrade, so keep copies outside the
  // package tree that `npm i -g @deepseek-ai/dsh` replaces.
  fs.copyFileSync(asset("acp-patch.mjs"), ACP_PATCH);
  fs.mkdirSync(TOOL_ASSETS, { recursive: true });
  for (const file of ["package.json", "index.js"]) fs.copyFileSync(asset(`dsh-command-tool/${file}`), path.join(TOOL_ASSETS, file));
  log.push("self-repair assets: acp patch, run_command");

  for (const profile of PROFILES) log.push(provisionProfile(profile));

  const toolDir = path.join(DSH_ROOT, "node_modules", "@deepseek-ai", "dsh-command-tool");
  if (fs.existsSync(DSH_ROOT)) {
    fs.mkdirSync(toolDir, { recursive: true });
    for (const file of ["package.json", "index.js"]) fs.copyFileSync(asset(`dsh-command-tool/${file}`), path.join(toolDir, file));
    ensureLink(DSH_TOOLS, path.join(toolDir, "node_modules", "@deepseek-ai", "dsh-tools"));
    for (const profile of PROFILES) {
      ensureLink(toolDir, path.join(HOME, ".dsh", "profiles", profile, "node_modules", "@deepseek-ai", "dsh-command-tool"));
    }
    log.push("dsh plugin: run_command installed");
  } else {
    log.push("dsh plugin: skipped (dsh not found)");
  }

  if (fs.existsSync(DSH_ACP_FILE)) {
    const patch = await run(process.execPath, [asset("acp-patch.mjs")]);
    log.push(`acp patch: ${patch.out.split("\n").slice(-1)[0] ?? "done"}`);
  } else {
    log.push("acp patch: skipped (dsh-acp not found)");
  }

  const agents = [
    {
      id: "deepseek",
      displayName: "DeepSeek Harness",
      command: "node",
      args: [LAUNCHER],
      env: { DSH_HOME: path.join(HOME, ".dsh") },
      nativeReasoning: {
        configId: "reasoning_effort",
        supportedLevels: ["none", "low", "medium", "high", "max"],
        levelValues: { none: "off", low: "low", medium: "medium", high: "high", max: "max" },
        defaultLevel: "high",
      },
    },
  ];
  // BB_CLI is a Node script without an extension on Windows, so run it through
  // this process's node; a bare "bb" from PATH is the fallback.
  const attempts: { cmd: string; prefix: string[] }[] = [];
  const cli = process.env.BB_CLI;
  if (cli !== undefined) {
    const asScript = cli.endsWith(".cmd") ? cli.slice(0, -4) : cli;
    if (fs.existsSync(asScript)) attempts.push({ cmd: process.execPath, prefix: [asScript] });
  }
  attempts.push({ cmd: "bb", prefix: [] });
  let registered = false;
  let lastError = "no bb binary found";
  for (const attempt of attempts) {
    const result = await run(attempt.cmd, [
      ...attempt.prefix,
      "plugin",
      "config",
      "provider-acp",
      "set",
      "customAgents",
      JSON.stringify(agents),
    ]);
    if (result.ok) {
      registered = true;
      break;
    }
    lastError = result.out.split("\n")[0] ?? result.out;
  }
  log.push(`provider: ${registered ? "registered as acp-deepseek" : `failed (${lastError})`}`);

  if (readFileJson(STATE_FILE, stateSchema) === null) writeState("standard");
  return log;
}

function status(): string[] {
  const rows: string[] = [];
  rows.push(`dsh: ${fs.existsSync(DSH_BIN) ? "found" : "MISSING"}`);
  rows.push(`launcher: ${fs.existsSync(LAUNCHER) ? "installed" : "missing"}`);
  rows.push(`mode: ${readState()}`);
  for (const profile of PROFILES) {
    const file = path.join(HOME, ".dsh", "profiles", profile, "cordis.patch.yml");
    const patched = fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("command-tool");
    rows.push(`${profile}: ${patched ? "configured" : "not configured"} (${PROFILE_MODE[profile]})`);
  }
  rows.push(`run_command: ${fs.existsSync(path.join(DSH_ROOT, "node_modules", "@deepseek-ai", "dsh-command-tool", "index.js")) ? "installed" : "missing"}`);
  let acp = "";
  try {
    acp = fs.readFileSync(DSH_ACP_FILE, "utf8");
  } catch {
    acp = "";
  }
  rows.push(`dsh-acp command patch: ${acp.includes("bbAcpRunCommand") ? "applied" : "not applied"}`);
  rows.push(`dsh-acp session/load bridge: ${acp.includes("bbAcpLoadSessionBridge") ? "applied" : "not applied"}`);
  rows.push(`dsh-acp fidelity projection: ${acp.includes("bbAcpProjectToolCall") ? "applied" : "not applied"}`);
  rows.push(`dsh-acp live stream: ${acp.includes("bbAcpLiveStream") ? "applied" : "not applied"}`);
  rows.push(`dsh-acp row polish: ${acp.includes("bbAcpRowPolish") ? "applied" : "not applied"}`);
  const selfRepair = fs.existsSync(ACP_PATCH) && fs.existsSync(path.join(TOOL_ASSETS, "index.js"));
  rows.push(`upgrade self-repair: ${selfRepair ? "armed" : "missing (re-run install)"}`);
  return rows;
}

// ---------------------------------------------------------------------------
// Subagent visibility
//
// dsh exposes nothing about its children over ACP, so this reads what dsh
// already persists for its own UI:
//   storages/session_projcache/sessions/<id>.json  projection cache
//   sessions/<cwd>/<id>/session.v4.jsonl.zstd      append-only log, one frame per flush
// The parent's subagentCatalog gives the roster; each child's cache gives status
// and cost; the child's newest log frame gives the "what is it doing" line.
// ---------------------------------------------------------------------------

const DSH_SESSIONS = path.join(HOME, ".dsh", "sessions");
const DSH_PROJCACHE = path.join(HOME, ".dsh", "storages", "session_projcache", "sessions");
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

interface ChildEntry {
  id: string;
  label: string;
  mode: string;
  createdAt: number;
}

interface ChildState extends ChildEntry {
  status: "running" | "settled" | "idle" | "unknown";
  elapsedMs: number | null;
  turns: number | null;
  tokens: number | null;
  activity: string | null;
  activityAgeMs: number | null;
}

/** Read one JSON file, tolerating absence and partial writes. */
function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** First providerThreadId among a bb thread's events. */
function identityOf(events: unknown[]): string | null {
  for (const event of events) {
    const record = event as { data?: { providerThreadId?: unknown } };
    const id = record?.data?.providerThreadId;
    if (typeof id === "string" && id.length > 8) return id;
  }
  return null;
}

const sessionCache = new Map<string, { id: string | null; at: number }>();

/** Resolve a bb thread's dsh session id; the identity event carries it. */
async function resolveSessionId(bb: BbPluginApi, threadId: string): Promise<string | null> {
  const hit = sessionCache.get(threadId);
  // A thread keeps one dsh session for its life; re-resolving costs a CLI spawn.
  if (hit !== undefined && Date.now() - hit.at < 600_000) return hit.id;

  // Preferred: ask bb for the thread's events through the SDK.
  try {
    const events = await (bb.sdk as unknown as {
      threads: { events: { list: (input: unknown) => Promise<unknown[]> } };
    }).threads.events.list({ threadId, limit: 100 });
    if (Array.isArray(events)) {
      const id = identityOf(events);
      if (id !== null) {
        sessionCache.set(threadId, { id, at: Date.now() });
        return id;
      }
    }
  } catch {
    // fall through to the CLI
  }

  const attempts: { cmd: string; prefix: string[] }[] = [];
  const cli = process.env.BB_CLI;
  if (cli !== undefined) {
    const asScript = cli.endsWith(".cmd") ? cli.slice(0, -4) : cli;
    if (fs.existsSync(asScript)) attempts.push({ cmd: "node", prefix: [asScript] });
  }
  attempts.push({ cmd: "bb", prefix: [] });

  for (const attempt of attempts) {
    const result = await run(attempt.cmd, [...attempt.prefix, "thread", "log", threadId, "--json", "--limit", "100"]);
    if (!result.ok) continue;
    const start = result.out.indexOf("[");
    if (start < 0) continue;
    let events: unknown;
    try {
      events = JSON.parse(result.out.slice(start));
    } catch {
      continue;
    }
    if (!Array.isArray(events)) continue;
    const id = identityOf(events);
    if (id !== null) {
      sessionCache.set(threadId, { id, at: Date.now() });
      return id;
    }
  }
  sessionCache.set(threadId, { id: null, at: Date.now() });
  return null;
}

/** Projection rows of one dsh session, keyed by projection name. */
function projections(sessionId: string): Record<string, any> | null {
  const doc = readJson(path.join(DSH_PROJCACHE, `${sessionId}.json`));
  const rows = doc?.record?.rows;
  return typeof rows === "object" && rows !== null ? rows : null;
}

/** Children this session deployed, in deployment order. */
function catalogOf(sessionId: string): ChildEntry[] {
  const values = projections(sessionId)?.subagentCatalog?.val?.head?.values;
  if (!Array.isArray(values)) return [];
  return values
    .filter((value: any) => typeof value?.childId === "string")
    .map((value: any) => ({
      id: value.childId,
      label: typeof value.label === "string" && value.label.length > 0 ? value.label : String(value.childId).slice(0, 8),
      mode: typeof value.mode === "string" ? value.mode : "spawn",
      createdAt: typeof value.childCreatedAt === "number" ? value.childCreatedAt : Date.now(),
    }));
}

const logPathCache = new Map<string, string | null>();

/** Locate a session's log across the per-cwd session directories. */
function logPath(sessionId: string): string | null {
  const hit = logPathCache.get(sessionId);
  if (hit !== undefined) return hit;
  let found: string | null = null;
  try {
    for (const dir of fs.readdirSync(DSH_SESSIONS)) {
      const candidate = path.join(DSH_SESSIONS, dir, sessionId, "session.v4.jsonl.zstd");
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  } catch {
    found = null;
  }
  logPathCache.set(sessionId, found);
  return found;
}

/** Decode one zstd frame; older runtimes degrade to no activity line. */
async function inflate(frame: Buffer): Promise<string | null> {
  try {
    const zlib = await import("node:zlib");
    const zstd = (zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync;
    if (typeof zstd !== "function") return null;
    return zstd(frame).toString("utf8");
  } catch {
    return null;
  }
}

function frameStarts(buf: Buffer): number[] {
  const starts: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i);
    }
  }
  return starts;
}

/** Decode the newest log frame: the cheapest "what is it doing right now". */
async function lastEvent(file: string): Promise<any | null> {
  let handle: number | undefined;
  try {
    const stat = fs.statSync(file);
    const window = Math.min(stat.size, 192 * 1024);
    handle = fs.openSync(file, "r");
    const buf = Buffer.alloc(window);
    fs.readSync(handle, buf, 0, window, stat.size - window);
    const starts = frameStarts(buf);
    for (let k = starts.length - 1; k >= 0 && k >= starts.length - 6; k -= 1) {
      const text = await inflate(buf.subarray(starts[k]));
      if (text === null) return null;
      const lines = text.split("\n").filter((line) => line.trim().startsWith("{"));
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        try {
          return JSON.parse(lines[j]);
        } catch {
          // keep walking older lines in the same frame
        }
      }
    }
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // already closed
      }
    }
  }
  return null;
}

function argumentHint(args: any): string {
  const hint =
    (typeof args?.description === "string" && args.description) ||
    (typeof args?.command === "string" && args.command) ||
    (typeof args?.file_path === "string" && args.file_path) ||
    (typeof args?.path === "string" && args.path) ||
    (typeof args?.pattern === "string" && args.pattern) ||
    (typeof args?.query === "string" && args.query) ||
    (typeof args?.prompt === "string" && args.prompt) ||
    "";
  return String(hint).trim().replace(/\s+/gu, " ");
}

function parseArguments(raw: unknown): any {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** One line describing the newest event, plus how stale it is. */
function describeEvent(event: any | null): { activity: string | null; ageMs: number | null } {
  if (event === null) return { activity: null, ageMs: null };
  const at = typeof event.createdAt === "number" ? event.createdAt : null;
  const ageMs = at === null ? null : Date.now() - at;
  const type = typeof event.type === "string" ? event.type : "";
  const data = event.data ?? {};

  if (type === "tool/call") {
    const name = typeof data.name === "string" ? data.name : "tool";
    const hint = argumentHint(parseArguments(data.arguments));
    return { activity: hint.length > 0 ? `${name} - ${hint.slice(0, 86)}` : name, ageMs };
  }
  if (type === "tool/result") return { activity: "tool finished", ageMs };
  if (type === "assistant/message") return { activity: "writing result", ageMs };
  if (type === "step/start") return { activity: "thinking", ageMs };
  if (type === "turn/end") return { activity: "turn ended", ageMs };
  if (type === "turn/start") return { activity: "thinking", ageMs };
  return { activity: null, ageMs };
}

async function childState(entry: ChildEntry): Promise<ChildState> {
  const rows = projections(entry.id);
  const boundary = rows?.turnBoundary?.val;
  const timing = rows?.subagentTiming?.val;
  const totals = rows?.tokenUsage?.val?.totals;

  const openTurn = typeof boundary?.openTurnStartSeq === "number";
  const settled = timing?.lastTurnCompleted === true;
  const status: ChildState["status"] = openTurn ? "running" : settled ? "settled" : timing === undefined ? "unknown" : "idle";

  const file = logPath(entry.id);
  const { activity, ageMs } = describeEvent(file === null ? null : await lastEvent(file));
  // A live child whose newest event carries no label still needs a line.
  const line = activity ?? (status === "running" ? "working" : null);

  const settledMs = typeof timing?.settledMs === "number" && timing.settledMs > 0 ? timing.settledMs : null;
  const tokens =
    typeof totals === "object" && totals !== null
      ? (totals.uncachedInputTokens ?? 0) + (totals.outputTokens ?? 0) + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0)
      : null;

  return {
    ...entry,
    status,
    elapsedMs: settled ? settledMs : Date.now() - entry.createdAt,
    turns: typeof boundary?.lastTurn === "number" ? boundary.lastTurn : null,
    tokens,
    activity: line,
    activityAgeMs: status === "running" ? ageMs : null,
  };
}

function blockText(message: any): string | null {
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const joined = content
    .map((block: any) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter((text: string) => text.length > 0)
    .join("\n")
    .trim();
  return joined.length > 0 ? joined : null;
}

/** Decode a whole child log for the expanded row. */
async function childDetail(childId: string): Promise<{
  prompt: string | null;
  result: string | null;
  steps: string[];
  toolCount: number;
}> {
  const file = logPath(childId);
  if (file === null) return { prompt: null, result: null, steps: [], toolCount: 0 };

  let text = "";
  try {
    const buf = fs.readFileSync(file);
    const starts = frameStarts(buf);
    const parts: string[] = [];
    const zlib = await import("node:zlib");
    const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
    if (typeof zstd !== "function") return { prompt: null, result: null, steps: [], toolCount: 0 };
    for (let k = 0; k < starts.length; k += 1) {
      try {
        parts.push(zstd(buf.subarray(starts[k], starts[k + 1] ?? buf.length)).toString("utf8"));
      } catch {
        // skip a damaged frame
      }
    }
    text = parts.join("\n");
  } catch {
    return { prompt: null, result: null, steps: [], toolCount: 0 };
  }

  let prompt: string | null = null;
  let result: string | null = null;
  const steps: string[] = [];
  let toolCount = 0;

  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "user/message" && prompt === null) {
      prompt = blockText(record.data?.message) ?? blockText(record.data);
    }
    if (record.type === "assistant/message") {
      const body = blockText(record.data?.message) ?? blockText(record.data);
      if (body !== null) result = body;
    }
    if (record.type === "tool/call") {
      toolCount += 1;
      const name = typeof record.data?.name === "string" ? record.data.name : "tool";
      const hint = argumentHint(parseArguments(record.data?.arguments));
      steps.push(hint.length > 0 ? `${name} - ${hint.slice(0, 100)}` : name);
    }
  }

  const trim = (value: string | null, limit: number): string | null =>
    value === null ? null : value.length > limit ? `${value.slice(0, limit)}...` : value;

  // The delegating harness appends its own send_message instructions to the
  // prompt; the panel shows the orchestrator's words, not the boilerplate.
  if (prompt !== null) {
    const cut = prompt.indexOf("Your parent agent id is");
    if (cut > 40) prompt = prompt.slice(0, cut).trim();
  }

  return { prompt: trim(prompt, 1200), result: trim(result, 2200), steps: steps.slice(-20), toolCount };
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.rpc.register(rpcContract, {
    mode_get: ({ threadId }) => ({ mode: readState(), threadMode: threadId === undefined ? null : readThreadMode(threadId) }),
    mode_set: ({ mode, threadId }) => {
      writeState(mode);
      if (threadId !== undefined) writeThreadMode(threadId, mode);
      bb.log.info(`dsh mode -> ${mode}${threadId === undefined ? "" : ` for ${threadId}`}`);
      return { mode };
    },
    subagents_get: async ({ threadId }) => {
      const sessionId = await resolveSessionId(bb, threadId);
      if (sessionId === null) return { sessionId: null, children: [] };
      const children = await Promise.all(catalogOf(sessionId).map((entry) => childState(entry)));
      return { sessionId, children };
    },
    subagent_detail: async ({ threadId, childId }) => {
      const sessionId = await resolveSessionId(bb, threadId);
      // Only children this thread actually deployed are addressable.
      if (sessionId === null || !catalogOf(sessionId).some((entry) => entry.id === childId)) {
        return { prompt: null, result: null, steps: [], toolCount: 0 };
      }
      return childDetail(childId);
    },
    thread_mode: ({ threadId }) => threadMode(threadId),
  });

  bb.cli.register({
    name: "deepseek-harness",
    summary: "Provision and inspect the DeepSeek Harness integration (dsh profiles, run_command plugin, ACP patch)",
    commands: [
      { name: "install", summary: "Provision everything and register the acp-deepseek provider", usage: "bb deepseek-harness install" },
      { name: "status", summary: "Report what is installed", usage: "bb deepseek-harness status [--json]" },
      { name: "mode", summary: "Show or set the mode new threads use", usage: "bb deepseek-harness mode [standard|creator|minimal] [--json]" },
      { name: "subagents", summary: "List the dsh subagents a thread deployed, with live status", usage: "bb deepseek-harness subagents [thread-id] [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, value] = argv.filter((arg) => arg !== "--json");
      const reply = (payload: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(payload) : text });

      if (command === "install") {
        const lines = await provision();
        return reply({ lines }, lines.join("\n"));
      }
      if (command === "subagents") {
        const threadId = value ?? process.env.BB_THREAD_ID;
        if (threadId === undefined) {
          return { exitCode: 1, stderr: "usage: bb deepseek-harness subagents [thread-id]" };
        }
        const sessionId = await resolveSessionId(bb, threadId);
        const children = sessionId === null ? [] : await Promise.all(catalogOf(sessionId).map((entry) => childState(entry)));
        const rows = children.map((child) => {
          const age = child.elapsedMs === null ? "-" : `${(child.elapsedMs / 1000).toFixed(1)}s`;
          const activity = child.activity === null ? "" : `  ${child.activity}`;
          return `${child.status.padEnd(7)} ${age.padStart(8)}  ${child.label}${activity}`;
        });
        return reply({ threadId, sessionId, children }, rows.length > 0 ? rows.join("\n") : "no subagents");
      }
      if (command === "mode") {
        if (value === undefined) return reply({ mode: readState() }, `mode: ${readState()}`);
        if (!(MODES as readonly string[]).includes(value)) {
          return { exitCode: 1, stderr: `usage: bb deepseek-harness mode <${MODES.join("|")}>` };
        }
        writeState(value as DshMode);
        return reply({ mode: value }, `mode: ${value}`);
      }
      if (command === "status" || command === undefined) {
        const lines = status();
        return reply({ lines }, lines.join("\n"));
      }
      return { exitCode: 1, stderr: "usage: bb deepseek-harness <install|status|mode>" };
    },
  });
}
