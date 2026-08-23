"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MotionPreference } from "@/hooks/useReducedMotionPreference";
import { THEMES, type Theme } from "@/hooks/usePersistedTheme";
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@/lib/i18n";

interface BreakerStatus {
  state?: string;
  consecutive_failures?: number;
  retry_after_seconds?: number;
}

interface RuntimeStatus {
  ok?: boolean;
  live_provider?: string;
  openclaw_connected?: boolean;
  planner_vision_model?: string;
  image_model?: string;
  searxng_connected?: boolean;
  mongo_connected?: boolean | null;
  minio_connected?: boolean | null;
  alternate_provider_fallback?: boolean;
  breakers?: Record<string, BreakerStatus>;
  usage?: {
    scope?: string;
    counters?: Record<string, number>;
    caps?: {
      runtime_generations?: number;
      session_generations?: number;
    };
  };
}

interface RestoreSummary {
  dry_run: boolean;
  sessions: number;
  nodes: number;
  images: number;
  remapped_sessions?: number;
  remapped_nodes?: number;
  provider_calls: number;
}

interface Props {
  outputLocale: SupportedLocale;
  setOutputLocale: (locale: SupportedLocale) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  motionPreference: MotionPreference;
  setMotionPreference: (preference: MotionPreference) => void;
  currentSessionId: string;
  canExportOffline: boolean;
}

const COUNTERS = [
  ["generation_requests", "Generation requests"],
  ["generation_success", "Successful"],
  ["generation_failed", "Failed"],
  ["generation_cancelled", "Cancelled"],
  ["planner_calls", "Planner calls"],
  ["alignment_calls", "Alignment calls"],
  ["image_calls", "Image calls"],
  ["searxng_searches", "SearXNG searches"],
] as const;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function cap(value: number | undefined): string {
  return value && value > 0 ? String(value) : "Unlimited";
}

function breakerLabel(row: BreakerStatus | undefined): string {
  const state = row?.state ?? "unknown";
  const retry = row?.retry_after_seconds ?? 0;
  return state === "open" && retry > 0 ? `open · retry in ${retry}s` : state;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function NasSettingsRuntime({
  outputLocale,
  setOutputLocale,
  theme,
  setTheme,
  motionPreference,
  setMotionPreference,
  currentSessionId,
  canExportOffline,
}: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreSummary, setRestoreSummary] = useState<RestoreSummary | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      const payload = await response.json() as RuntimeStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "runtime status unavailable");
      setStatus(payload);
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : "runtime status unavailable");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, loadStatus]);

  const inspectRestore = async (file: File | null) => {
    setRestoreFile(file);
    setRestoreSummary(null);
    setRestoreMessage(null);
    if (!file) return;
    setRestoreBusy(true);
    try {
      const response = await fetch("/api/backup/owner/restore", {
        method: "POST",
        body: file,
      });
      const payload = await response.json() as RestoreSummary & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "backup dry-run failed");
      setRestoreSummary(payload);
      setRestoreMessage(
        `Dry-run verified: ${payload.sessions} session, ${payload.nodes} pages · ` +
        `${payload.images} images · ${payload.provider_calls} provider calls`,
      );
    } catch (error) {
      setRestoreMessage(error instanceof Error ? error.message : "backup dry-run failed");
    } finally {
      setRestoreBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (!restoreFile || !restoreSummary?.dry_run) return;
    setRestoreBusy(true);
    setRestoreMessage("Restoring verified archive…");
    try {
      const response = await fetch("/api/backup/owner/restore?confirm=true", {
        method: "POST",
        headers: { "x-openflipbook-restore-confirm": "RESTORE_OWNER_BACKUP" },
        body: restoreFile,
      });
      const payload = await response.json() as RestoreSummary & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "owner restore failed");
      setRestoreSummary(payload);
      setRestoreFile(null);
      setRestoreMessage(
        `Restore complete: ${payload.sessions} session, ${payload.nodes} pages · ` +
        `${payload.images} images · ${payload.provider_calls} provider calls`,
      );
    } catch (error) {
      setRestoreMessage(error instanceof Error ? error.message : "owner restore failed");
    } finally {
      setRestoreBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="min-h-11 rounded-full border border-[var(--color-ink)]/25 bg-[var(--color-paper)]/70 px-3 text-xs font-medium hover:bg-[var(--color-ink)]/10 sm:min-h-0 sm:py-1"
      >
        Settings
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[70] bg-black/35 backdrop-blur-[1px]"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Settings and runtime"
            className="fixed inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto border-l border-[var(--color-edge)] bg-[var(--color-paper)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] text-[var(--color-ink)] shadow-2xl sm:px-6"
          >
            <header className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Settings / Runtime</h2>
                <p className="text-xs opacity-65">Private NAS self-use controls</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close settings"
                className="min-h-11 min-w-11 rounded-full border border-[var(--color-edge)] text-xl sm:min-h-9 sm:min-w-9"
              >
                ×
              </button>
            </header>

            <div className="mt-5 space-y-6 text-sm">
              <section aria-labelledby="preferences-heading">
                <h3 id="preferences-heading" className="font-semibold">Preferences</h3>
                <label className="mt-3 flex items-center justify-between gap-4">
                  <span>Output language</span>
                  <select
                    aria-label="Output language"
                    value={outputLocale}
                    onChange={(event) => setOutputLocale(event.target.value as SupportedLocale)}
                    className="min-h-11 rounded-lg border border-[var(--color-edge)] bg-transparent px-3 sm:min-h-9"
                  >
                    {SUPPORTED_LOCALES.map((locale) => (
                      <option key={locale} value={locale}>{locale}</option>
                    ))}
                  </select>
                </label>
                <div className="mt-3 flex items-center justify-between gap-4">
                  <span>Theme</span>
                  <div role="group" aria-label="Theme" className="flex overflow-hidden rounded-lg border border-[var(--color-edge)]">
                    {THEMES.map((item) => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={theme === item}
                        onClick={() => setTheme(item)}
                        className={`min-h-11 px-3 text-xs sm:min-h-9 ${theme === item ? "bg-[var(--color-ink)] text-[var(--color-canvas)]" : ""}`}
                      >
                        {titleCase(item)}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="mt-3 flex min-h-11 items-center justify-between gap-4">
                  <span>
                    Always reduce motion
                    <span className="block text-xs opacity-60">System preference is always honored</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={motionPreference === "reduce"}
                    onChange={(event) => setMotionPreference(event.target.checked ? "reduce" : "system")}
                    className="h-5 w-5"
                  />
                </label>
              </section>

              <section aria-labelledby="exports-heading">
                <h3 id="exports-heading" className="font-semibold">Export and backup</h3>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {canExportOffline ? (
                    <a
                      href={`/api/export/offline/${encodeURIComponent(currentSessionId)}`}
                      className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-edge)] px-3 text-center text-xs font-medium"
                    >
                      Export current offline book
                    </a>
                  ) : (
                    <span className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-edge)] px-3 text-center text-xs opacity-50">
                      Offline book available after first saved page
                    </span>
                  )}
                  <a
                    href="/api/backup/owner"
                    className="flex min-h-11 items-center justify-center rounded-lg bg-[var(--color-ink)] px-3 text-center text-xs font-medium text-[var(--color-canvas)]"
                  >
                    Download owner backup
                  </a>
                </div>
                <div className="mt-4 rounded-xl border border-[var(--color-edge)] p-3">
                  <p className="text-xs font-semibold">Restore owner backup</p>
                  <p className="mt-1 text-xs opacity-65">Selection validates and dry-runs only. Nothing is written until explicit confirmation.</p>
                  <label className="mt-3 flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-dashed border-[var(--color-edge)] px-3 text-center text-xs">
                    Choose owner backup archive
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      aria-label="Choose owner backup archive"
                      className="sr-only"
                      onChange={(event) => void inspectRestore(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  {restoreMessage && (
                    <p role="status" className="mt-2 break-words text-xs">{restoreMessage}</p>
                  )}
                  {restoreSummary?.dry_run && (
                    <p className="mt-1 text-xs opacity-65">
                      Collision remap: {count(restoreSummary.remapped_sessions)} sessions, {count(restoreSummary.remapped_nodes)} pages.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={restoreBusy || !restoreFile || !restoreSummary?.dry_run}
                    onClick={() => void confirmRestore()}
                    className="mt-3 min-h-11 w-full rounded-lg border border-amber-700 bg-amber-50 px-3 text-xs font-semibold text-amber-950 disabled:opacity-40"
                  >
                    {restoreBusy ? "Working…" : "Confirm restore"}
                  </button>
                </div>
              </section>

              <section aria-labelledby="runtime-heading">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="runtime-heading" className="font-semibold">Runtime</h3>
                  <button
                    type="button"
                    onClick={() => void loadStatus()}
                    disabled={statusLoading}
                    className="min-h-9 rounded-full border border-[var(--color-edge)] px-3 text-xs disabled:opacity-40"
                  >
                    Refresh
                  </button>
                </div>
                {statusLoading && !status ? (
                  <p className="mt-3 text-xs opacity-65">Loading runtime status…</p>
                ) : statusError ? (
                  <p role="alert" className="mt-3 break-words rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900">{statusError}</p>
                ) : status ? (
                  <div className="mt-3 space-y-4">
                    <div className="rounded-xl border border-[var(--color-edge)] p-3">
                      <p className="font-medium">OpenClaw (read-only)</p>
                      <dl className="mt-2 grid grid-cols-[auto,minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                        <dt className="opacity-60">Provider</dt><dd className="break-all">{status.live_provider ?? "openclaw"}</dd>
                        <dt className="opacity-60">Planner / alignment</dt><dd className="break-all">{status.planner_vision_model ?? "unknown"}</dd>
                        <dt className="opacity-60">Image</dt><dd className="break-all">{status.image_model ?? "unknown"}</dd>
                      </dl>
                      <p className="mt-2 text-xs font-medium">
                        {status.alternate_provider_fallback
                          ? "Warning: alternate provider fallback is enabled"
                          : "No alternate provider fallback"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-65">Health</p>
                      <ul className="mt-2 grid grid-cols-2 gap-2 text-xs">
                        {[
                          ["OpenClaw", status.openclaw_connected],
                          ["SearXNG", status.searxng_connected],
                          ["Mongo", status.mongo_connected],
                          ["MinIO", status.minio_connected],
                        ].map(([label, healthy]) => (
                          <li key={String(label)} className="rounded-lg border border-[var(--color-edge)] px-2 py-1.5">
                            {label}: {healthy === true ? "connected" : healthy === false ? "unavailable" : "unknown"}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-65">Circuit breakers</p>
                      <ul className="mt-2 space-y-1 text-xs">
                        {["responses", "image"].map((stage) => (
                          <li key={stage} className="flex justify-between gap-3 rounded-lg border border-[var(--color-edge)] px-2 py-1.5">
                            <span>{stage}</span>
                            <span>{breakerLabel(status.breakers?.[stage])}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-wide opacity-65">Usage</p>
                        <span className="text-[11px] opacity-60">{status.usage?.scope ?? "since backend start"}</span>
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        {COUNTERS.map(([key, label]) => (
                          <div key={key} className="contents"><dt>{label}</dt><dd className="text-right tabular-nums">{count(status.usage?.counters?.[key])}</dd></div>
                        ))}
                      </dl>
                      <p className="mt-2 text-xs">Caps: runtime {cap(status.usage?.caps?.runtime_generations)} · session {cap(status.usage?.caps?.session_generations)}</p>
                    </div>
                  </div>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
