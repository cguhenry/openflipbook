"use client";

import { useEffect, useRef, useState } from "react";

interface SessionSummary {
  session_id: string;
  title: string;
  node_count: number;
  branch_count: number;
  updated_at: string;
  has_image_seed: boolean;
}

interface Props {
  currentSessionId: string;
  onNewSession: () => void;
  onResume: (sessionId: string) => void;
}

export default function SessionHistory({
  currentSessionId,
  onNewSession,
  onResume,
}: Props) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void fetch("/api/sessions", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("history unavailable");
        const payload = (await response.json()) as { sessions?: SessionSummary[] };
        setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSessions([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="session-history-panel"
        onClick={() => setOpen((value) => !value)}
        className="min-h-11 rounded-full border border-[var(--color-ink)]/25 bg-[var(--color-paper)]/70 px-3 text-xs font-medium hover:bg-[var(--color-ink)]/10 sm:min-h-0 sm:py-1"
      >
        History
      </button>
      {open && (
        <div
          id="session-history-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Session history"
          className="fixed inset-x-3 bottom-[max(.75rem,env(safe-area-inset-bottom))] top-[max(4.5rem,env(safe-area-inset-top))] z-40 overflow-y-auto rounded-xl border border-[var(--color-ink)]/20 bg-[var(--color-paper)] p-3 text-[var(--color-ink)] shadow-xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-9 sm:w-[min(23rem,calc(100vw-2rem))] sm:overflow-visible"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide opacity-65">
              Recent sessions
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNewSession();
                }}
                className="min-h-11 rounded-full bg-[var(--color-ink)] px-3 text-[11px] text-[var(--color-canvas)] sm:min-h-0 sm:py-1"
              >
                New session
              </button>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close history"
                className="min-h-11 min-w-11 rounded-full border border-[var(--color-edge)] text-lg sm:min-h-8 sm:min-w-8"
              >
                ×
              </button>
            </span>
          </div>
          {loading ? (
            <p className="mt-3 text-xs opacity-60">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="mt-3 text-xs opacity-60">No persisted sessions yet.</p>
          ) : (
            <ul className="mt-2 max-h-72 space-y-1.5 overflow-y-auto">
              {sessions.map((session) => {
                const current = session.session_id === currentSessionId;
                return (
                  <li key={session.session_id}>
                    <button
                      type="button"
                      aria-current={current ? "page" : undefined}
                      onClick={() => onResume(session.session_id)}
                      className="flex min-h-11 w-full items-start justify-between gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left hover:border-[var(--color-ink)]/20 hover:bg-[var(--color-ink)]/5"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {current ? "● " : ""}{session.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] opacity-60">
                          {new Date(session.updated_at).toLocaleString()} · {session.node_count} pages · {session.branch_count} branches
                          {session.has_image_seed ? " · image seed" : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] opacity-55">Resume</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
