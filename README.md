# bb-plugin-deepseek-harness

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) in
[bb](https://getbb.app) as a first-class agent, the way pi and Cursor are.

dsh ships an ACP stdio app (`dsh --profile acp`). This plugin registers it as the
`acp-deepseek` provider, adds a mode picker above the composer, and installs the
small pieces dsh needs to behave like a normal bb agent.

## What you get

- **`acp-deepseek` provider** — dsh threads with models, reasoning effort, streaming,
  tool calls, context usage, and cancel, driven over ACP.
- **Standard / Creator / Minimal** — a row in the New thread composer that selects which
  dsh composition boots (`acp`, `acp-creator`, `acp-minimal`). Creator adds
  `cordis_inspect_*`, `present`, and plugin-manager tools; Minimal keeps only files,
  shell, and compaction. dsh locks its preset at the session's first turn, so inside a
  thread the row is replaced by a read-only badge naming the composition it started in.
- **Harness slash commands** — a bundled dsh plugin (`run_command`) exposes dsh's own
  command registry (`/compact`, `/goal`, `/feedback`) to the agent, and a small patch to
  `dsh-acp` runs a bare command line typed into the composer without a model turn.
- **Session continuity** — closing bb and picking a thread back up continues the same
  dsh session, with its history. The patch bridges ACP `session/load` (what bb's stable
  adapter uses) onto dsh's persisted-session resume path.
- **Rich timeline rows** — a fidelity projection in the same `dsh-acp` patch translates what dsh
  keeps for its own UI into standard ACP facts, so bb renders dsh threads the way it renders
  Claude Code: `bash` streams as a live command row, `read`/`edit`/`write` show the target file,
  searches show the pattern or query, `run_code` and subagents carry their description,
  `todo_write` renders as a live task list, and automatic compaction gets a visible
  "Compacting conversation history" row that closes when it finishes (or reports the failure).
- **Live output** — dsh's bridge only sends committed events, so a long thinking step, a
  backend retry loop, or a crash mid-step used to leave the turn showing just "running".
  The patch forwards dsh's live assistant stream (reasoning and text deltas) as it arrives,
  drops the copy the committed message would repeat, and shows LLM retries as a
  "Model request failed, retry n/m" row. Whatever streamed before a crash stays in bb's history.
- **Subagent visibility** — dsh children never cross the ACP wire, so the plugin reads
  the state dsh persists for its own UI: a compact chip in the composer's action row
  (beside the model picker) shows how many subagents the thread deployed and how many
  are running, and opens a popup listing each child's label, status, elapsed time,
  tokens, current tool call, last steps, and result.
  `bb deepseek-harness subagents [thread-id]` prints the same roster.
- **One-command provisioning** — `bb deepseek-harness install` creates the dsh profiles,
  installs the dsh plugin, applies the ACP patch, and registers the provider.

## Requirements

```sh
npm i -g @deepseek-ai/dsh          # the harness itself
node --version                      # dsh needs ^22.19 || >=24
```

Model credentials come from dsh's own resolution order: `$DSH_HOME/.credentials.yaml`,
the launch environment, a project `.env`, then `$DSH_HOME/.env`.

Workspaces must be writable directories — **not a drive root**. dsh's filesystem layer
`mkdir`s the workspace root on every write, so `E:\` fails with `EPERM` even with full
access.

## Install

```sh
bb plugin install .        # from this directory
bb deepseek-harness install
bb deepseek-harness status
```

Then pick **DeepSeek Harness** in the model menu and choose a mode above the prompt box.

`npm i -g @deepseek-ai/dsh` replaces the install tree, which takes the
`run_command` plugin and the `dsh-acp` patch with it. The next dsh launch heals
that automatically: the launcher keeps copies in `~/.bb-dsh-modes` and re-applies
them before boot, so session continuity survives upgrades without a manual step.
Re-run `bb deepseek-harness install` if the patch anchors moved (the launcher logs
`FAILED (inspect anchors)`), to re-register the provider, or to restore a machine
after moving bb. The plugin is idempotent.

## CLI

```sh
bb deepseek-harness status              # what is installed, current mode
bb deepseek-harness install             # (re)provision everything
bb deepseek-harness mode                # mode new threads will use
bb deepseek-harness mode creator        # standard | creator | minimal
```

## How it works

| file | role |
|---|---|
| `server.ts` | RPC for the composer banner, the CLI, and provisioning |
| `app.tsx` | the mode row rendered above the composer (only for `acp-deepseek`) |
| `assets/launcher.mjs` | reads `~/.bb-dsh-modes/state.json`, self-heals upgrades, and execs `dsh --profile <mode>` |
| `assets/dsh-command-tool/` | dsh plugin: `run_command` over dsh's command registry |
| `assets/acp-patch.mjs` | patches `dsh-acp`: advertise commands, intercept bare command lines, bridge `session/load` to resume, and project UI facts (tool kinds/titles/locations, todo lists, compaction) onto the wire |

State lives in `~/.bb-dsh-modes/` (`state.json`, `threads/`, `launcher.log`, plus the
`acp-patch.mjs` and `dsh-command-tool/` copies the launcher uses for self-repair).

## Sandbox and the workspace root

dsh defaults to `workspace-write`, and on Windows that mode calls
`SetNamedSecurityInfoW` to grant itself write access on the workspace root. When the
workspace *is* a drive root (`E:\`) that call fails with Win32 5 and **every** tool call
errors before it runs. The launcher therefore starts dsh with
`DSH_PERMISSION_MODE=danger-full-access`; bb enforces permissions on its side. Override
it with `DSH_PERMISSION_MODE=workspace-write` in the provider env if you want dsh's own
sandbox.

Separately, writes inside a drive root still fail (`EPERM: mkdir 'E:\'`) because dsh's
filesystem layer creates the workspace root on every write and Windows denies that to a
non-elevated process. Use a normal project directory as the workspace.

## Known limitations

- **Commands are not listed in bb's `/` menu.** The patch advertises them over ACP, but
  bb's active ACP plugin (`provider-acp`) does not read `availableCommands`; only the
  newer `provider-acp-next` does. Typed commands still run through the interception path.
- **`/compact` mid-thread is refused by dsh** ("the agent is not idle"): the ACP bridge
  keeps the agent busy between turns. Compaction therefore stays automatic.
- **Approvals do not surface.** dsh's ACP bridge never sends `session/request_permission`,
  so bb's permission picker has nothing to answer for this provider.
- **The ACP patch is a vendor patch**, not a plugin: it edits the installed dsh package.
  The launcher re-applies it from `~/.bb-dsh-modes/acp-patch.mjs` on the first dsh launch
  after an upgrade, but an upstream code-shape change (moved anchors) still needs a
  plugin release.
- **`session/load` does not replay history.** The patch answers it with dsh's resume path,
  which restores the agent context but sends no `session/update` replay. bb keeps its own
  transcript and discards replay while loading, so this is what makes bb continuity work;
  a client that relies on replay to rebuild the conversation would see it empty.

## License

MIT
