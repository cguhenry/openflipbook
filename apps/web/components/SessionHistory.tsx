"use client";

import { useEffect, useState } from "react";

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

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="session-history-panel"
        onClick={() => setOpen((value) => !value)}
        className="rounded-full border border-[var(--color-ink)]/25 bg-[var(--color-paper)]/70 px-3 py-1 text-xs font-medium hover:bg-[var(--color-ink)]/10"
      >
        History
      </button>
      {open && (
        <div
          id="session-history-panel"
          role="dialog"
          aria-label="Session history"
          className="absolute right-0 top-9 z-40 w-[min(23rem,calc(100vw-2rem))] rounded-xl border border-[var(--color-ink)]/20 bg-[var(--color-paper)] p-3 text-[var(--color-ink)] shadow-xl"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide opacity-65">
              Recent sessions
            </span>
            <button
              type="button"
              onClick={onNewSession}
              className="rounded-full bg-[var(--color-ink)] px-2.5 py-1 text-[11px] text-[var(--color-canvas)]"
            >
              New session
            </button>
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
                      className="flex w-full items-start justify-between gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left hover:border-[var(--color-ink)]/20 hover:bg-[var(--color-ink)]/5"
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
