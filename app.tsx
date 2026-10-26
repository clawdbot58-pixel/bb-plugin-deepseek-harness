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
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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

// DeepSeek's official whale, as dsh's own UI draws it (dsh-client-ui-primitives
// FishLogo), in currentColor so it follows bb's theme like the built-in marks.
const WHALE_PATH =
  "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z";

function DeepSeekWhale({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 -3.06 23.16 23.16" fill="none" aria-hidden="true">
      <path d={WHALE_PATH} fill="currentColor" />
    </svg>
  );
}

export default definePluginApp((app) => {
  // Without a registered mark bb falls back to a generic toolbox glyph.
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "acp-deepseek", icon: DeepSeekWhale });

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
