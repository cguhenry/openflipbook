"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MotionPreference } from "@/hooks/useReducedMotionPreference";
import { THEMES, type Theme } from "@/hooks/usePersistedTheme";
import {
  SUPPORTED_OUTPUT_LOCALES,
  SUPPORTED_UI_LOCALES,
  formatUi,
  localeDisplayName,
  type LocaleStrings,
  type SupportedOutputLocale,
  type SupportedUiLocale,
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
  t: LocaleStrings;
  uiLocale: SupportedUiLocale;
  setUiLocale: (locale: SupportedUiLocale) => void;
  outputLocale: SupportedOutputLocale;
  setOutputLocale: (locale: SupportedOutputLocale) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  motionPreference: MotionPreference;
  setMotionPreference: (preference: MotionPreference) => void;
  currentSessionId: string;
  canExportOffline: boolean;
}

const COUNTERS = [
  ["generation_requests", "generationRequests"],
  ["generation_success", "successful"],
  ["generation_failed", "failed"],
  ["generation_cancelled", "cancelled"],
  ["planner_calls", "plannerCalls"],
  ["alignment_calls", "alignmentCalls"],
  ["image_calls", "imageCalls"],
  ["searxng_searches", "searxngSearches"],
] as const;

function cap(value: number | undefined, t: LocaleStrings): string {
  return value && value > 0 ? String(value) : t.unlimited;
}

function breakerLabel(row: BreakerStatus | undefined, t: LocaleStrings): string {
  const state = row?.state ?? "unknown";
  const retry = row?.retry_after_seconds ?? 0;
  const label = state === "open"
    ? t.breakerOpen
    : state === "closed"
      ? t.breakerClosed
      : state === "half_open"
        ? t.breakerHalfOpen
        : t.unknown;
  return state === "open" && retry > 0
    ? `${label} · ${formatUi(t.retryInSeconds, { seconds: retry })}`
    : label;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function counted(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function restoreResultMessage(
  label: string,
  payload: RestoreSummary,
  t: LocaleStrings,
): string {
  return `${label}: ${counted(payload.sessions, t.sessionSingular, t.sessionPlural)}, ` +
    `${counted(payload.nodes, t.pageSingular, t.pagePlural)} · ` +
    `${counted(payload.images, t.imageSingular, t.imagePlural)} · ` +
    counted(payload.provider_calls, t.providerCallSingular, t.providerCallPlural);
}

export function NasSettingsRuntime({
  t,
  uiLocale,
  setUiLocale,
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
      if (!response.ok) throw new Error(t.runtimeUnavailable);
      setStatus(payload);
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : t.runtimeUnavailable);
    } finally {
      setStatusLoading(false);
    }
  }, [t]);

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
      if (!response.ok) throw new Error(t.backupDryRunFailed);
      setRestoreSummary(payload);
      setRestoreMessage(restoreResultMessage(t.dryRunVerified, payload, t));
    } catch (error) {
      setRestoreMessage(error instanceof Error ? error.message : t.backupDryRunFailed);
    } finally {
      setRestoreBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (!restoreFile || !restoreSummary?.dry_run) return;
    setRestoreBusy(true);
    setRestoreMessage(t.restoringArchive);
    try {
      const response = await fetch("/api/backup/owner/restore?confirm=true", {
        method: "POST",
        headers: { "x-openflipbook-restore-confirm": "RESTORE_OWNER_BACKUP" },
        body: restoreFile,
      });
      const payload = await response.json() as RestoreSummary & { error?: string };
      if (!response.ok) throw new Error(t.ownerRestoreFailed);
      setRestoreSummary(payload);
      setRestoreFile(null);
      setRestoreMessage(restoreResultMessage(t.restoreComplete, payload, t));
    } catch (error) {
      setRestoreMessage(error instanceof Error ? error.message : t.ownerRestoreFailed);
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
        className="min-h-11 rounded-full border border-[var(--color-ink)]/25 bg-[var(--color-paper)]/70 px-3 text-xs font-medium hover:bg-[var(--color-ink)]/10"
      >
        {t.settings}
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
            aria-label={t.settingsRuntime}
            className="fixed inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto border-l border-[var(--color-edge)] bg-[var(--color-paper)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] text-[var(--color-ink)] shadow-2xl sm:px-6"
          >
            <header className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{t.settingsRuntime}</h2>
                <p className="text-xs opacity-65">{t.privateNasControls}</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.closeSettings}
                className="min-h-11 min-w-11 rounded-full border border-[var(--color-edge)] text-xl"
              >
                ×
              </button>
            </header>

            <div className="mt-5 space-y-6 text-sm">
              <section aria-labelledby="preferences-heading">
                <h3 id="preferences-heading" className="font-semibold">{t.preferences}</h3>
                <label className="mt-3 flex items-center justify-between gap-4">
                  <span>{t.uiLanguage}</span>
                  <select
                    aria-label={t.uiLanguage}
                    value={uiLocale}
                    onChange={(event) => setUiLocale(event.target.value as SupportedUiLocale)}
                    className="min-h-11 rounded-lg border border-[var(--color-edge)] bg-transparent px-3"
                  >
                    {SUPPORTED_UI_LOCALES.map((locale) => (
                      <option key={locale} value={locale}>{localeDisplayName(locale, t)}</option>
                    ))}
                  </select>
                </label>
                <label className="mt-3 flex items-center justify-between gap-4">
                  <span>{t.outputLanguage}</span>
                  <select
                    aria-label={t.outputLanguage}
                    value={outputLocale}
                    onChange={(event) => setOutputLocale(event.target.value as SupportedOutputLocale)}
                    className="min-h-11 rounded-lg border border-[var(--color-edge)] bg-transparent px-3"
                  >
                    {SUPPORTED_OUTPUT_LOCALES.map((locale) => (
                      <option key={locale} value={locale}>{localeDisplayName(locale, t)}</option>
                    ))}
                  </select>
                </label>
                <div className="mt-3 flex items-center justify-between gap-4">
                  <span>{t.theme}</span>
                  <div role="group" aria-label={t.theme} className="flex overflow-hidden rounded-lg border border-[var(--color-edge)]">
                    {THEMES.map((item) => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={theme === item}
                        onClick={() => setTheme(item)}
                        className={`min-h-11 px-3 text-xs ${theme === item ? "bg-[var(--color-ink)] text-[var(--color-canvas)]" : ""}`}
                      >
                        {item === "light" ? t.themeLight : item === "sepia" ? t.themeSepia : t.themeDark}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="mt-3 flex min-h-11 items-center justify-between gap-4">
                  <span>
                    {t.alwaysReduceMotion}
                    <span className="block text-xs opacity-60">{t.systemMotionHonored}</span>
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
                <h3 id="exports-heading" className="font-semibold">{t.exportAndBackup}</h3>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {canExportOffline ? (
                    <a
                      href={`/api/export/offline/${encodeURIComponent(currentSessionId)}`}
                      className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-edge)] px-3 text-center text-xs font-medium"
                    >
                      {t.exportOfflineBook}
                    </a>
                  ) : (
                    <span className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-edge)] px-3 text-center text-xs opacity-50">
                      {t.offlineAfterFirstPage}
                    </span>
                  )}
                  <a
                    href="/api/backup/owner"
                    className="flex min-h-11 items-center justify-center rounded-lg bg-[var(--color-ink)] px-3 text-center text-xs font-medium text-[var(--color-canvas)]"
                  >
                    {t.downloadOwnerBackup}
                  </a>
                </div>
                <div className="mt-4 rounded-xl border border-[var(--color-edge)] p-3">
                  <p className="text-xs font-semibold">{t.restoreOwnerBackup}</p>
                  <p className="mt-1 text-xs opacity-65">{t.restoreSelectionHelp}</p>
                  <label className="mt-3 flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-dashed border-[var(--color-edge)] px-3 text-center text-xs">
                    {t.chooseOwnerBackup}
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      aria-label={t.chooseOwnerBackup}
                      className="sr-only"
                      onChange={(event) => void inspectRestore(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  {restoreMessage && (
                    <p role="status" className="mt-2 break-words text-xs">{restoreMessage}</p>
                  )}
                  {restoreSummary?.dry_run && (
                    <p className="mt-1 text-xs opacity-65">
                      {t.collisionRemap}: {counted(count(restoreSummary.remapped_sessions), t.sessionSingular, t.sessionPlural)}, {counted(count(restoreSummary.remapped_nodes), t.pageSingular, t.pagePlural)}.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={restoreBusy || !restoreFile || !restoreSummary?.dry_run}
                    onClick={() => void confirmRestore()}
                    className="mt-3 min-h-11 w-full rounded-lg border border-amber-700 bg-amber-50 px-3 text-xs font-semibold text-amber-950 disabled:opacity-40"
                  >
                    {restoreBusy ? t.working : t.confirmRestore}
                  </button>
                </div>
              </section>

              <section aria-labelledby="runtime-heading">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="runtime-heading" className="font-semibold">{t.runtime}</h3>
                  <button
                    type="button"
                    onClick={() => void loadStatus()}
                    disabled={statusLoading}
                    className="min-h-11 rounded-full border border-[var(--color-edge)] px-3 text-xs disabled:opacity-40"
                  >
                    {t.refresh}
                  </button>
                </div>
                {statusLoading && !status ? (
                  <p className="mt-3 text-xs opacity-65">{t.loadingRuntime}</p>
                ) : statusError ? (
                  <p role="alert" className="mt-3 break-words rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900">{statusError}</p>
                ) : status ? (
                  <div className="mt-3 space-y-4">
                    <div className="rounded-xl border border-[var(--color-edge)] p-3">
                      <p className="font-medium">{t.openClawReadOnly}</p>
                      <dl className="mt-2 grid grid-cols-[auto,minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                        <dt className="opacity-60">{t.provider}</dt><dd className="break-all">{status.live_provider ?? "openclaw"}</dd>
                        <dt className="opacity-60">{t.plannerAlignment}</dt><dd className="break-all">{status.planner_vision_model ?? t.unknown}</dd>
                        <dt className="opacity-60">{t.imageModel}</dt><dd className="break-all">{status.image_model ?? t.unknown}</dd>
                      </dl>
                      <p className="mt-2 text-xs font-medium">
                        {status.alternate_provider_fallback
                          ? t.alternateFallbackWarning
                          : t.noAlternateFallback}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-65">{t.health}</p>
                      <ul className="mt-2 grid grid-cols-2 gap-2 text-xs">
                        {[
                          ["OpenClaw", status.openclaw_connected],
                          ["SearXNG", status.searxng_connected],
                          ["Mongo", status.mongo_connected],
                          ["MinIO", status.minio_connected],
                        ].map(([label, healthy]) => (
                          <li key={String(label)} className="rounded-lg border border-[var(--color-edge)] px-2 py-1.5">
                            {label}: {healthy === true ? t.connected : healthy === false ? t.unavailable : t.unknown}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-65">{t.circuitBreakers}</p>
                      <ul className="mt-2 space-y-1 text-xs">
                        {([
                          ["responses", t.responsesBreaker],
                          ["image", t.imageBreaker],
                        ] as const).map(([stage, label]) => (
                          <li key={stage} className="flex justify-between gap-3 rounded-lg border border-[var(--color-edge)] px-2 py-1.5">
                            <span>{label}</span>
                            <span>{breakerLabel(status.breakers?.[stage], t)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-wide opacity-65">{t.usage}</p>
                        <span className="text-[11px] opacity-60">{t.sinceBackendStart}</span>
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        {COUNTERS.map(([key, label]) => (
                          <div key={key} className="contents"><dt>{t[label]}</dt><dd className="text-right tabular-nums">{count(status.usage?.counters?.[key])}</dd></div>
                        ))}
                      </dl>
                      <p className="mt-2 text-xs">{t.caps}: {t.runtimeCap} {cap(status.usage?.caps?.runtime_generations, t)} · {t.sessionCap} {cap(status.usage?.caps?.session_generations, t)}</p>
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
