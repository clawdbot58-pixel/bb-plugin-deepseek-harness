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
bb deepseek-harness install           # full (re)provision on a new or broken install
bb deepseek-harness mode              # mode new threads will use
bb deepseek-harness mode creator      # standard | creator | minimal
```

`install` is idempotent. A `npm i -g @deepseek-ai/dsh` upgrade replaces the patched
`dsh-acp` bridge and the injected `run_command` plugin, but the launcher keeps copies in
`~/.bb-dsh-modes` and re-applies both on the first dsh launch after the upgrade. Run
`install` when the launcher logs `FAILED (inspect anchors)` (upstream code moved), after
moving to a new machine, or to re-register the provider.

## Timeline integration (fidelity projection)

The `dsh-acp` patch also projects dsh's UI-only facts onto standard ACP updates, so a
thread shows the same richness other providers get:

- `tool_call` updates carry a real `kind` and a useful title: `bash` → `execute` (streamed
  command row), `read`/`read_image`/`str_replace_editor view` → `read`, `edit`/`write`/
  `str_replace_editor` → `edit` with file locations, `glob`/`grep`/`web_search` → `search`,
  `web_fetch` → `fetch`. `run_code`, `subagent`, `ask_user_question`, goals, `run_command`,
  and `skill` surface their description/objective/question as the row title. Unknown tools
  fall back to the generic row — a dsh upgrade that renames tools only degrades titles.
- `todo/write` events become ACP `plan` updates, rendered as a live task list.
- `compaction/start` / `compaction/end` become a "Compacting conversation history" row
  that closes on completion (or fails visibly).
- Live stream: `agent/assistant-stream` reasoning/text deltas are forwarded as they arrive
  (the committed message's duplicate text is dropped), so long or interrupted steps are
  visible and survive a crash in bb's history. `llm/retry` events show as a
  "Model request failed, retry n/m" row that closes when the model answers or the turn ends.

```sh
bb deepseek-harness status            # patch lines report what is applied
bb deepseek-harness install           # re-apply all patch sections
```

## Subagents

dsh subagents run in-process inside the thread's dsh session; ACP carries nothing about
them, so a thread shows one `subagent` tool row per child and no transcript. The plugin
fills that gap from the state dsh persists for its own UI:

```sh
bb deepseek-harness subagents            # this thread (BB_THREAD_ID)
bb deepseek-harness subagents <thread>   # any thread
```

The composer chip appears only when a thread has deployed at least one child. It sits in
the composer's action row beside the model picker, shows `running/total` while any child
is live, and opens a panel above the composer where each child expands to its prompt, the
last 20 tool calls, and its final message. The panel is a composer banner mounted only
while open — host popups and floating overlays are not reliable across bb's thread views.

Where the data comes from, and what it cannot do:

- roster: the parent session's `subagentCatalog` projection in
  `~/.dsh/storages/session_projcache/sessions/<session>.json`
- status, elapsed, tokens: each child's `turnBoundary` / `subagentTiming` /
  `tokenUsage` projections
- current activity: the newest zstd frame of the child's
  `~/.dsh/sessions/<cwd>/<child>/session.v4.jsonl.zstd`
- these are dsh implementation details, not a public API. A dsh upgrade that renames
  them degrades the row to a count, never breaks the thread. Children stay invisible to
  bb's thread list, cancel, and resume; only the root session is resumable.

## Modes

| mode | dsh profile | tool surface |
|---|---|---|
| Standard | `acp` | full roster |
| Creator | `acp-creator` | standard + `cordis_inspect_*`, `present`, plugin manager |
| Minimal | `acp-minimal` | files, shell, compaction only |

The mode applies when a thread's dsh process starts; dsh itself locks its preset at
the session's first turn, so changing it later does not switch a running thread. The
picker therefore renders only in the New thread composer. A thread shows a read-only
badge with the composition it booted with, resolved from
`~/.bb-dsh-modes/threads/<thread>.json` (written by the launcher on every launch) and
falling back to the launcher log for threads started before that record existed.

## Session continuity

Reopening a thread after bb restarts continues the same dsh session with its earlier
context. bb's stable ACP adapter restores through `session/load`, which dsh does not
implement natively, so the patch advertises `loadSession` and routes it to dsh's
persisted-session resume path. Without the patch, bb silently falls back to a fresh
session ("could not restore the previous session").

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
