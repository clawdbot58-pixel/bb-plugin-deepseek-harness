// Mode launcher for bb's acp-deepseek provider.
//
// bb runs this file as the provider command (node launcher.mjs). It reads the
// mode the dsh-modes plugin recorded, maps it to a dsh profile, and execs dsh
// over inherited stdio so bb sees ordinary ACP traffic.
//
// It also self-heals the two things a `npm i -g @deepseek-ai/dsh` upgrade
// removes from the installed package: the dsh-acp patch (command + session
// restore bridge) and the copied run_command plugin. Copies of both live in
// ~/.bb-dsh-modes, so a new dsh process repairs them before it boots instead of
// silently losing session continuity until someone re-runs install.
//
// R1: real binary (process.execPath) + argument array, shell disabled.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".bb-dsh-modes");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOG_FILE = path.join(STATE_DIR, "launcher.log");
const ACP_PATCH = path.join(STATE_DIR, "acp-patch.mjs");
const TOOL_ASSET = path.join(STATE_DIR, "dsh-command-tool");
const LOCK_DIR = path.join(STATE_DIR, "provision.lock");
const DSH_ROOT = path.join(
  process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@deepseek-ai",
  "dsh",
);
const DSH_BIN = path.join(DSH_ROOT, "lib", "bin.js");
const DSH_SCOPE = path.join(DSH_ROOT, "node_modules", "@deepseek-ai");
const ACP_FILE = path.join(DSH_SCOPE, "dsh-acp", "lib", "index.js");
const TOOL_DIR = path.join(DSH_SCOPE, "dsh-command-tool");
const TOOLS_DIR = path.join(DSH_SCOPE, "dsh-tools");

const MODE_PROFILE = {
  standard: "acp",
  creator: "acp-creator",
  minimal: "acp-minimal",
};

// Both bridges must be present; an upgrade wipes the whole file.
const PATCH_MARKERS = ["bbAcpRunCommand", "bbAcpLoadSessionBridge", "bbAcpProjectToolCall", "bbAcpLiveStream"];

function log(line) {
  try {
    const entry = `${new Date().toISOString()} ${line}\n`;
    const prev = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
    fs.writeFileSync(LOG_FILE, (prev.length > 20000 ? prev.slice(-12000) : prev) + entry, { flag: "w" });
  } catch {
    // logging is best-effort; never block the agent
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Serialize repairs across launchers; a stale lock is dropped, never waited on forever. */
function withLock(fn) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        fs.mkdirSync(LOCK_DIR);
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        if (Date.now() > deadline) {
          try {
            fs.rmdirSync(LOCK_DIR);
          } catch {
            // another launcher released it first
          }
          log("provision lock stale; skipping self-repair for this launch");
          return;
        }
        sleepSync(100);
      }
    }
    try {
      fn();
    } finally {
      try {
        fs.rmdirSync(LOCK_DIR);
      } catch {
        // already released
      }
    }
  } catch (err) {
    log(`self-repair skipped: ${err.message}`);
  }
}

function acpNeedsPatch() {
  const source = readText(ACP_FILE);
  return source !== undefined && !PATCH_MARKERS.every((marker) => source.includes(marker));
}

function toolNeedsRestore() {
  return fs.existsSync(TOOL_ASSET) && !fs.existsSync(path.join(TOOL_DIR, "index.js"));
}

/** Re-copy the run_command files; the profile junctions still point at TOOL_DIR. */
function restoreTool() {
  fs.mkdirSync(TOOL_DIR, { recursive: true });
  for (const file of ["package.json", "index.js"]) {
    fs.copyFileSync(path.join(TOOL_ASSET, file), path.join(TOOL_DIR, file));
  }
  const linkParent = path.join(TOOL_DIR, "node_modules", "@deepseek-ai");
  fs.mkdirSync(linkParent, { recursive: true });
  const link = path.join(linkParent, "dsh-tools");
  if (!fs.existsSync(link)) fs.symlinkSync(TOOLS_DIR, link, process.platform === "win32" ? "junction" : "dir");
}

function repairProvisioning() {
  if (!fs.existsSync(DSH_ROOT)) return;
  if (!acpNeedsPatch() && !toolNeedsRestore()) return;
  log("dsh upgrade detected; repairing provisioning");
  withLock(() => {
    if (acpNeedsPatch() && fs.existsSync(ACP_PATCH)) {
      execFileSync(process.execPath, [ACP_PATCH], { stdio: "ignore", timeout: 30000 });
      log(`dsh-acp patch: ${acpNeedsPatch() ? "FAILED (inspect anchors)" : "re-applied"}`);
    }
    if (toolNeedsRestore()) {
      restoreTool();
      log("run_command plugin restored");
    }
    log("provisioning repaired");
  });
}

function resolveMode() {
  const threadId = process.env.BB_THREAD_ID;
  if (typeof threadId === "string" && /^[A-Za-z0-9_-]+$/u.test(threadId)) {
    const perThread = readJson(path.join(STATE_DIR, "threads", `${threadId}.json`));
    const mode = perThread?.mode;
    if (typeof mode === "string" && MODE_PROFILE[mode] !== undefined) return { mode, source: "thread" };
  }
  const state = readJson(STATE_FILE);
  const mode = state?.mode;
  if (typeof mode === "string" && MODE_PROFILE[mode] !== undefined) return { mode, source: "state" };
  return { mode: "standard", source: "default" };
}

const { mode, source } = resolveMode();
const profile = MODE_PROFILE[mode];
log(`launch thread=${process.env.BB_THREAD_ID ?? "-"} mode=${mode} (${source}) profile=${profile}`);

// Record what this thread actually booted with. The composer shows it read-only,
// because neither bb nor dsh can change the composition of a started session.
// bb passes BB_THREAD_ID to the provider process for thread launches (drafts and
// some restarts come through without it).
function recordThreadMode(threadId, bootedMode) {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(threadId)) return;
  try {
    const dir = path.join(STATE_DIR, "threads");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, `${threadId}.json`),
      `${JSON.stringify({ mode: bootedMode, profile: MODE_PROFILE[bootedMode], recordedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    log(`thread mode record failed: ${err.message}`);
  }
}

recordThreadMode(process.env.BB_THREAD_ID, mode);

if (!fs.existsSync(DSH_BIN)) {
  log(`fatal: dsh entry not found at ${DSH_BIN}`);
  process.exit(1);
}

// dsh upgrades replace the package tree; restore what install had put there.
repairProvisioning();

const child = spawn(process.execPath, [DSH_BIN, "--profile", profile], {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    // dsh's workspace-write sandbox calls SetNamedSecurityInfoW to grant itself
    // write on the workspace root. On a drive root that fails with Win32 5 and
    // every tool call errors out, so dsh runs unconfined: bb already enforces
    // permissions on its side. Override with DSH_PERMISSION_MODE=workspace-write.
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? "danger-full-access",
  },
});

child.on("exit", (code, signal) => {
  log(`exit thread=${process.env.BB_THREAD_ID ?? "-"} mode=${mode} code=${code ?? "null"} signal=${signal ?? "none"}`);
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  log(`child error: ${err.message}`);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
