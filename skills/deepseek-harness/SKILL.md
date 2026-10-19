---
name: deepseek-harness
description: "Run DeepSeek Harness (dsh) threads in bb, switch its modes, and repair the provisioning."
---

# DeepSeek Harness in bb

This plugin brings [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) into bb as
the `acp-deepseek` provider, using dsh's ACP stdio app (`dsh --profile acp`).

## Operating it

```sh
bb deepseek-harness status            # what is installed, which mode, which profiles
bb deepseek-harness install           # (re)provision after a dsh upgrade
bb deepseek-harness mode              # mode new threads will use
bb deepseek-harness mode creator      # standard | creator | minimal
```

`install` is idempotent. Run it after every `npm i -g @deepseek-ai/dsh`, because dsh
upgrades replace the patched `dsh-acp` bridge and the injected `run_command` plugin.

## Modes

| mode | dsh profile | tool surface |
|---|---|---|
| Standard | `acp` | full roster |
| Creator | `acp-creator` | standard + `cordis_inspect_*`, `present`, plugin manager |
| Minimal | `acp-minimal` | files, shell, compaction only |

The mode applies when a thread's dsh process starts; dsh itself locks its preset at
the session's first turn, so changing it later does not switch a running thread.

## Commands

The `run_command` tool (installed by `install`) exposes dsh's slash-command registry
to the agent, so `/compact`, `/goal`, and `/feedback` are reachable from bb. A bare
command line typed into the composer is run by the patched ACP bridge directly,
without a model turn — except `/compact` mid-thread, which dsh refuses while the
agent is busy; compaction therefore stays automatic (`compaction-basic.auto: true`).

## Requirements

- `dsh` installed globally (`npm i -g @deepseek-ai/dsh`)
- credentials for a model route: `~/.dsh/.env` or `$DSH_HOME/.credentials.yaml`
- workspaces must be writable directories, not drive roots — dsh's filesystem layer
  `mkdir`s the workspace root on every write
