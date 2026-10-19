// bb-plugin-dsh-modes — composer mode picker for the acp-deepseek provider.
//
// Renders only when the composer is on acp-deepseek. The choice is written
// through the plugin's RPC to ~/.bb-dsh-modes, where launcher.mjs reads it and
// boots the matching dsh profile: standard -> acp, creator -> acp-creator,
// minimal -> acp-minimal. dsh locks its preset at the session's first turn, so
// the choice applies to the dsh process this thread starts.
import { useEffect, useRef, useState } from "react";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";


type Mode = "standard" | "creator" | "minimal";

const MODES: readonly { id: Mode; label: string; hint: string }[] = [
  { id: "standard", label: "Standard", hint: "Full tool roster" },
  { id: "creator", label: "Creator", hint: "Adds Cordis inspection, present, and the plugin manager" },
  { id: "minimal", label: "Minimal", hint: "Files, shell, and compaction only" },
];

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
        <span style={LABEL}>Mode: {error ?? "loading…"}</span>
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
        {error ?? `dsh ${active?.id ?? "standard"} · used when this thread's dsh starts`}
      </span>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "deepseek-modes",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "deepseek-mode", chrome: "bare", component: ModeBanner }],
  });
});
