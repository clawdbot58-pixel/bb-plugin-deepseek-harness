// bb-plugin-deepseek-harness - composer surfaces for the acp-deepseek provider.
//
// Two surfaces:
//   * the mode picker (banner) - which dsh composition the next dsh process boots
//   * the subagent chip (composer action) - how many children this thread
//     deployed; clicking it opens the roster as a banner above the composer
//
// dsh children never cross the ACP wire, so the chip reads the state dsh persists
// for its own UI through the plugin's subagents_get / subagent_detail RPCs.
//
// Styling rule: every surface uses `currentColor` and rgba(127,127,127,...) so it
// inherits whatever theme bb is showing. Only the live/running accent is a literal
// color, because "active" has to read as green in both themes.
//
// Source is deliberately ASCII-only: this file has been corrupted twice by text
// tooling that round-tripped non-ASCII characters.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Mode = "standard" | "creator" | "minimal";

const MODES: readonly { id: Mode; label: string; hint: string }[] = [
  { id: "standard", label: "Standard", hint: "Full tool roster" },
  { id: "creator", label: "Creator", hint: "Adds Cordis inspection, present, and the plugin manager" },
  { id: "minimal", label: "Minimal", hint: "Files, shell, and compaction only" },
];

const GREEN = "#34d399";

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 10px",
  fontSize: 12,
  lineHeight: "18px",
};

const LABEL: React.CSSProperties = {
  opacity: 0.65,
  whiteSpace: "nowrap",
};

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: "1px 8px",
    borderRadius: 999,
    fontSize: 12,
    lineHeight: "18px",
    cursor: "pointer",
    border: `1px solid ${active ? "currentColor" : "rgba(127,127,127,0.35)"}`,
    background: active ? "rgba(127,127,127,0.18)" : "transparent",
    color: "inherit",
    opacity: active ? 1 : 0.75,
  };
}

function ModeBanner() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const providerId = composer.selection?.providerId ?? null;
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : undefined;

  const [mode, setMode] = useState<Mode | null>(null);
  const [pending, setPending] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const probeKey = useRef<string | null>(null);
  const isDsh = providerId === "acp-deepseek";

  // Every hook stays above the early returns: the composer's provider can
  // resolve after first paint, and a conditional hook would unmount the banner.
  useEffect(() => {
    if (!isDsh) return;
    let cancelled = false;
    // bb rejects `undefined` in an RPC payload: omit the key, never send null.
    rpc.call("mode_get", threadId === undefined ? {} : { threadId }).then(
      (result) => {
        if (cancelled) return;
        setMode(result.threadMode ?? result.mode);
        setError(null);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isDsh, threadId, rpc]);

  useEffect(() => {
    const key = `${providerId ?? "null"}|${scope.kind}`;
    if (probeKey.current === key) return;
    probeKey.current = key;
    rpc
      .call("mode_probe", {
        providerId,
        scopeKind: scope.kind,
        hasSelection: composer.selection !== null,
      })
      .catch(() => undefined);
  }, [providerId, scope.kind, composer.selection, rpc]);

  if (!isDsh) return null;

  const choose = (next: Mode) => {
    setPending(next);
    setError(null);
    rpc.call("mode_set", threadId === undefined ? { mode: next } : { mode: next, threadId }).then(
      (result) => {
        setMode(result.mode);
        setPending(null);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setPending(null);
      },
    );
  };

  if (mode === null) {
    return (
      <div style={ROW}>
        <span style={LABEL}>Mode: {error ?? "loading..."}</span>
      </div>
    );
  }

  const active = MODES.find((entry) => entry.id === mode);

  return (
    <div style={ROW}>
      <span style={LABEL}>Mode</span>
      {MODES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          title={entry.hint}
          aria-pressed={entry.id === mode}
          disabled={pending !== null}
          onClick={() => choose(entry.id)}
          style={pillStyle(entry.id === mode)}
        >
          {entry.label}
        </button>
      ))}
      <span style={{ ...LABEL, marginLeft: "auto" }}>
        {error ?? `dsh ${active?.id ?? "standard"} - used when this thread starts`}
      </span>
    </div>
  );
}

// --- subagent visibility -----------------------------------------------------

const POLL_MS = 1500;

type ChildView = {
  id: string;
  label: string;
  mode: string;
  status: "running" | "settled" | "idle" | "unknown";
  createdAt: number;
  elapsedMs: number | null;
  turns: number | null;
  tokens: number | null;
  activity: string | null;
  activityAgeMs: number | null;
};

type Detail = { prompt: string | null; result: string | null; steps: string[]; toolCount: number };

const DOT: Record<ChildView["status"], string> = {
  running: GREEN,
  settled: "rgba(127,127,127,0.45)",
  idle: "#fbbf24",
  unknown: "rgba(127,127,127,0.3)",
};

function elapsed(value: number | null): string {
  if (value === null) return "-";
  const total = Math.max(0, Math.round(value / 1000));
  if (total < 60) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function tokenLabel(value: number | null): string {
  if (value === null) return "";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k tok` : `${value} tok`;
}

function useSubagents(threadId: string | undefined, enabled: boolean): ChildView[] | null {
  const rpc = useRpc<typeof rpcContract>();
  const [children, setChildren] = useState<ChildView[] | null>(null);

  useEffect(() => {
    if (!enabled || threadId === undefined) {
      setChildren(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const result = await rpc.call("subagents_get", { threadId });
        if (!cancelled) setChildren(result.children as ChildView[]);
      } catch {
        // keep the last snapshot; a transient failure should not blank the chip
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [threadId, enabled, rpc]);

  return children;
}

// --- panel store -------------------------------------------------------------
// The chip sits in the composer's action row; the panel is a sibling banner.
// Both read this store so opening from one place renders in the other.

let openThread: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function closePanel(): void {
  if (openThread === null) return;
  openThread = null;
  emit();
}

function togglePanel(threadId: string): void {
  openThread = openThread === threadId ? null : threadId;
  emit();
}

function useOpenThread(): string | null {
  return useSyncExternalStore(subscribe, () => openThread, () => openThread);
}

function Roster({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const children = useSubagents(threadId, true);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(null);
    setDetail(null);
    setDetailError(null);
  }, [threadId]);

  // The panel renders inline above the composer, so it moves with the composer:
  // only Escape closes it. A scroll or resize auto-close fires on the layout
  // shift that opening the panel itself causes, making it flash and vanish.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const running = (children ?? []).filter((child) => child.status === "running").length;

  const loadDetail = (child: ChildView) => {
    if (expanded === child.id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(child.id);
    setDetail(null);
    setDetailError(null);
    rpc.call("subagent_detail", { threadId, childId: child.id }).then(
      (result) => setDetail(result as Detail),
      (cause: unknown) => setDetailError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  return (
    <div
      style={{
        margin: "2px 0",
        borderRadius: 9,
        border: "1px solid rgba(127,127,127,0.28)",
        // Inherit the surface: currentColor at low alpha tints light and dark
        // themes alike, so no palette is hardcoded.
        background: "color-mix(in srgb, currentColor 5%, transparent)",
        color: "inherit",
        maxHeight: 320,
        overflowY: "auto",
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "7px 12px 5px",
          fontSize: 11,
          opacity: 0.6,
          position: "sticky",
          top: 0,
          backdropFilter: "blur(6px)",
        }}
      >
        <span>Subagents</span>
        <span>-</span>
        <span>
          {running > 0 ? `${running} running, ` : ""}
          {(children ?? []).length} total
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            marginLeft: "auto",
            border: 0,
            background: "transparent",
            color: "inherit",
            opacity: 0.6,
            cursor: "pointer",
            fontSize: 13,
            lineHeight: "16px",
          }}
        >
          x
        </button>
      </div>

      {children === null && <div style={{ padding: "4px 12px 10px", opacity: 0.5 }}>loading...</div>}
      {children !== null && children.length === 0 && (
        <div style={{ padding: "4px 12px 10px", opacity: 0.6 }}>No subagents in this thread.</div>
      )}

      {(children ?? []).map((child) => {
        const isOpen = expanded === child.id;
        return (
          <div key={child.id} style={{ borderTop: "1px solid rgba(127,127,127,0.14)" }}>
            <button
              type="button"
              onClick={() => loadDetail(child)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                width: "100%",
                padding: "6px 12px",
                fontSize: 12,
                lineHeight: "18px",
                color: "inherit",
                textAlign: "left",
                cursor: "pointer",
                border: 0,
                background: isOpen ? "rgba(127,127,127,0.08)" : "transparent",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 4, background: DOT[child.status] ?? DOT.unknown }} />
              <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {child.label}
              </span>
              <span style={{ marginLeft: "auto", opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
                {elapsed(child.elapsedMs)}
              </span>
            </button>

            <div
              style={{
                padding: "0 12px 7px 26px",
                fontSize: 11,
                fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                opacity: child.status === "running" ? 0.75 : 0.45,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {child.activity ?? "no activity yet"}
              {tokenLabel(child.tokens) ? ` - ${tokenLabel(child.tokens)}` : ""}
            </div>

            {isOpen && (
              <div style={{ padding: "0 12px 10px 26px", fontSize: 11, lineHeight: "17px" }}>
                {detailError !== null && <div style={{ opacity: 0.7 }}>detail failed: {detailError}</div>}
                {detailError === null && detail === null && <div style={{ opacity: 0.5 }}>loading...</div>}
                {detail !== null && (
                  <>
                    {detail.steps.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ opacity: 0.5, marginBottom: 2 }}>steps ({detail.toolCount} tools)</div>
                        {detail.steps.map((step, index) => (
                          <div
                            key={`${child.id}-step-${index}`}
                            style={{
                              fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              opacity: 0.7,
                            }}
                          >
                            {step}
                          </div>
                        ))}
                      </div>
                    )}
                    {detail.result !== null && (
                      <div>
                        <div style={{ opacity: 0.5, marginBottom: 2 }}>result</div>
                        <div style={{ whiteSpace: "pre-wrap", opacity: 0.8 }}>{detail.result}</div>
                      </div>
                    )}
                    {detail.result === null && detail.steps.length === 0 && (
                      <div style={{ opacity: 0.5 }}>no log yet</div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Host-rendered banner that exists only while the panel is open, so it costs no
 * height when closed. Popups render inline and are composer-scoped; the overlay
 * slot is not available on this bb build. */
function SubagentPanel() {
  const threadId = useOpenThread();
  if (threadId === null) return null;
  return <Roster threadId={threadId} onClose={closePanel} />;
}

/** Read-only badge: which dsh composition this thread booted with. dsh locks the
 * preset at the session's first turn, so this is information, not a control. */
function ModeBadge() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const isDsh = (composer.selection?.providerId ?? null) === "acp-deepseek";
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : undefined;
  const [booted, setBooted] = useState<Mode | null>(null);

  useEffect(() => {
    if (!isDsh || threadId === undefined) {
      setBooted(null);
      return;
    }
    let cancelled = false;
    rpc.call("thread_mode", { threadId }).then(
      (result) => {
        if (!cancelled) setBooted(result.mode as Mode | null);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [isDsh, threadId, rpc]);

  if (!isDsh || threadId === undefined || booted === null) return null;

  const label = MODES.find((entry) => entry.id === booted)?.label ?? booted;

  return (
    <span
      title={`This thread started in the ${label} dsh composition. A thread's mode is fixed at start; pick another in New thread.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 22,
        padding: "0 7px",
        borderRadius: 999,
        border: "1px solid rgba(127,127,127,0.24)",
        color: "inherit",
        opacity: 0.55,
        fontSize: 11,
        lineHeight: "20px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function SubagentChip() {
  const composer = useComposer();
  const isDsh = (composer.selection?.providerId ?? null) === "acp-deepseek";
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : undefined;
  const children = useSubagents(threadId, isDsh);
  const openThreadId = useOpenThread();

  const counts = useMemo(() => {
    const list = children ?? [];
    return { total: list.length, running: list.filter((child) => child.status === "running").length };
  }, [children]);

  if (!isDsh || threadId === undefined || counts.total === 0) return null;

  const live = counts.running > 0;
  const isOpen = openThreadId === threadId;

  return (
    <button
      type="button"
      onClick={() => togglePanel(threadId)}
      title={
        live
          ? `${counts.running} of ${counts.total} subagents running - click for detail`
          : `${counts.total} subagent${counts.total === 1 ? "" : "s"} - click for detail`
      }
      aria-label="Subagents"
      aria-expanded={isOpen}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 22,
        padding: "0 7px",
        borderRadius: 999,
        border: `1px solid ${
          live ? "color-mix(in srgb, #34d399 55%, transparent)" : "rgba(127,127,127,0.28)"
        }`,
        background: live
          ? "color-mix(in srgb, #34d399 14%, transparent)"
          : isOpen
            ? "rgba(127,127,127,0.14)"
            : "transparent",
        color: "inherit",
        fontSize: 11,
        lineHeight: "20px",
        cursor: "pointer",
        opacity: live ? 1 : 0.8,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          background: live ? GREEN : "rgba(127,127,127,0.55)",
          boxShadow: live ? "0 0 0 3px color-mix(in srgb, #34d399 18%, transparent)" : "none",
        }}
      />
      <span style={{ fontVariantNumeric: "tabular-nums", color: live ? GREEN : "inherit" }}>
        {live ? `${counts.running}/${counts.total}` : counts.total}
      </span>
    </button>
  );
}

export default definePluginApp((app) => {
  // The mode is read by the launcher when it spawns the dsh process, and dsh
  // locks its preset at the session's first turn. Offering the picker inside a
  // running thread would only rewrite the next thread's mode, so it belongs to
  // the new-thread composer alone.
  app.composer.customize({
    id: "deepseek-mode",
    scopes: ["new-thread"],
    banners: [{ id: "deepseek-mode", chrome: "bare", component: ModeBanner }],
  });

  // Subagent surfaces are thread-only: a draft has no deployed children.
  app.composer.customize({
    id: "deepseek-subagents",
    scopes: ["thread"],
    banners: [{ id: "deepseek-subagents", chrome: "bare", component: SubagentPanel }],
    actions: [
      { id: "deepseek-mode-badge", component: ModeBadge },
      { id: "deepseek-subagents", component: SubagentChip },
    ],
  });
});
