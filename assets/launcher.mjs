// Mode launcher for bb's acp-deepseek provider.
//
// bb runs this file as the provider command (node launcher.mjs). It reads the
// mode the dsh-modes plugin recorded, maps it to a dsh profile, and execs dsh
// over inherited stdio so bb sees ordinary ACP traffic.
//
// R1: real binary (process.execPath) + argument array, shell disabled.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".bb-dsh-modes");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOG_FILE = path.join(STATE_DIR, "launcher.log");
const DSH_BIN = path.join(
  process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);

const MODE_PROFILE = {
  standard: "acp",
  creator: "acp-creator",
  minimal: "acp-minimal",
};

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

if (!fs.existsSync(DSH_BIN)) {
  log(`fatal: dsh entry not found at ${DSH_BIN}`);
  process.exit(1);
}

const child = spawn(process.execPath, [DSH_BIN, "--profile", profile], {
  stdio: "inherit",
  shell: false,
  env: process.env,
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
