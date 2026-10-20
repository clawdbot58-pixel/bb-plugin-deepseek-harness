# bb-plugin-deepseek-harness

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) in
[bb](https://getbb.app) as a first-class agent, the way pi and Cursor are.

dsh ships an ACP stdio app (`dsh --profile acp`). This plugin registers it as the
`acp-deepseek` provider, adds a mode picker above the composer, and installs the
small pieces dsh needs to behave like a normal bb agent.

## What you get

- **`acp-deepseek` provider** — dsh threads with models, reasoning effort, streaming,
  tool calls, context usage, and cancel, driven over ACP.
- **Standard / Creator / Minimal** — a row above the composer that selects which dsh
  composition boots (`acp`, `acp-creator`, `acp-minimal`). Creator adds
  `cordis_inspect_*`, `present`, and plugin-manager tools; Minimal keeps only files,
  shell, and compaction.
- **Harness slash commands** — a bundled dsh plugin (`run_command`) exposes dsh's own
  command registry (`/compact`, `/goal`, `/feedback`) to the agent, and a small patch to
  `dsh-acp` runs a bare command line typed into the composer without a model turn.
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

Re-run `bb deepseek-harness install` after every dsh upgrade: `npm i -g` replaces the
install tree, which takes the `run_command` plugin and the `dsh-acp` patch with it. The
plugin is idempotent and refuses to patch if dsh-acp's code shape has moved.

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
| `assets/launcher.mjs` | reads `~/.bb-dsh-modes/state.json` and execs `dsh --profile <mode>` |
| `assets/dsh-command-tool/` | dsh plugin: `run_command` over dsh's command registry |
| `assets/acp-patch.mjs` | patches `dsh-acp`: advertise commands, intercept bare command lines |

State lives in `~/.bb-dsh-modes/` (`state.json`, `threads/`, `launcher.log`).

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
- **The ACP patch is a vendor patch**, not a plugin: it edits the installed dsh package
  and must be re-applied after upgrades.

## License

MIT
