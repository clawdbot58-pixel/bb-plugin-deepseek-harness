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

export const rpcContract = defineRpcContract({
  mode_get: {
    input: z.object({ threadId: threadIdSchema.optional() }),
    output: z.object({ mode: modeSchema, threadMode: modeSchema.nullable() }),
  },
  mode_set: {
    input: z.object({ mode: modeSchema, threadId: threadIdSchema.optional() }),
    output: z.object({ mode: modeSchema }),
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
        supportedLevels: ["none", "low", "high", "max"],
        levelValues: { none: "off", low: "low", high: "high", max: "max" },
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
  const selfRepair = fs.existsSync(ACP_PATCH) && fs.existsSync(path.join(TOOL_ASSETS, "index.js"));
  rows.push(`upgrade self-repair: ${selfRepair ? "armed" : "missing (re-run install)"}`);
  return rows;
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
  });

  bb.cli.register({
    name: "deepseek-harness",
    summary: "Provision and inspect the DeepSeek Harness integration (dsh profiles, run_command plugin, ACP patch)",
    commands: [
      { name: "install", summary: "Provision everything and register the acp-deepseek provider", usage: "bb deepseek-harness install" },
      { name: "status", summary: "Report what is installed", usage: "bb deepseek-harness status [--json]" },
      { name: "mode", summary: "Show or set the mode new threads use", usage: "bb deepseek-harness mode [standard|creator|minimal] [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, value] = argv.filter((arg) => arg !== "--json");
      const reply = (payload: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(payload) : text });

      if (command === "install") {
        const lines = await provision();
        return reply({ lines }, lines.join("\n"));
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
