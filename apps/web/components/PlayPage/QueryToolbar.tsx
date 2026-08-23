"use client";

import type { ChangeEvent, FormEvent, RefObject } from "react";
import type { Autonomy, ImageTier } from "@openflipbook/config";

import {
  SUPPORTED_OUTPUT_LOCALES,
  localeDisplayName,
  type SupportedOutputLocale,
  type LocaleStrings,
} from "@/lib/i18n";
import { THEMES, type Theme } from "@/hooks/usePersistedTheme";
import type { LoopKnobs } from "@/hooks/useSpeedPreset";
import { PRODUCT_FLAGS } from "@/lib/product-flags";
import { SpeedPreset } from "./SpeedPreset";

const TIERS: readonly ImageTier[] = ["fast", "balanced", "pro"] as const;

interface Props {
  t: LocaleStrings;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
  busy: boolean;
  outputLocale: SupportedOutputLocale;
  setOutputLocale: (l: SupportedOutputLocale) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  imageTier: ImageTier;
  setImageTier: (t: ImageTier) => void;
  loopKnobs: LoopKnobs;
  setLoopKnobs: (k: LoopKnobs) => void;
  sessionSpend?: number | null | undefined;
  devModel?: string | null | undefined;
  setDevModel?: ((m: string | null) => void) | undefined;
  worldMode: boolean;
  setWorldMode: (on: boolean) => void;
  autonomy: Autonomy;
  setAutonomy: (a: Autonomy) => void;
  domLabels: boolean;
  setDomLabels: (on: boolean) => void;
  nasSlim?: boolean;
}

export function QueryToolbar({
  t,
  input,
  onInputChange,
  onSubmit,
  fileInputRef,
  onFileInputChange,
  busy,
  outputLocale,
  setOutputLocale,
  theme,
  setTheme,
  imageTier,
  setImageTier,
  loopKnobs,
  setLoopKnobs,
  sessionSpend,
  devModel,
  setDevModel,
  worldMode,
  setWorldMode,
  autonomy,
  setAutonomy,
  domLabels,
  setDomLabels,
  nasSlim = PRODUCT_FLAGS.nasSlim,
}: Props) {
  return (
    <>
      <form
        onSubmit={onSubmit}
        className="flex w-full flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-edge)] bg-[var(--color-canvas)]/80 p-2 shadow-sm sm:rounded-full sm:px-4"
      >
        <input
          autoFocus
          className="min-h-11 min-w-0 basis-full bg-transparent px-2 outline-none placeholder:opacity-60 sm:min-h-0 sm:basis-auto"
          placeholder={t.placeholder}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="min-h-11 rounded-full border border-[var(--color-edge)] px-4 text-xs hover:bg-[var(--color-ink)]/5 disabled:opacity-40 sm:min-h-0 sm:px-3 sm:py-1"
          title={t.uploadTitle}
        >
          {t.upload}
        </button>
        {!nasSlim && <select
          value={outputLocale}
          onChange={(e) => setOutputLocale(e.target.value as SupportedOutputLocale)}
          disabled={busy}
          aria-label={t.outputLanguage}
          title={t.outputLanguage}
          className="rounded-full border border-[var(--color-edge)] bg-transparent px-2 py-1 text-xs disabled:opacity-40"
        >
          {SUPPORTED_OUTPUT_LOCALES.map((loc) => (
            <option key={loc} value={loc}>
              {localeDisplayName(loc, t)}
            </option>
          ))}
        </select>}
        {!nasSlim && <div
          role="group"
          aria-label={t.theme}
          className="flex items-center overflow-hidden rounded-full border border-[var(--color-edge)] text-xs"
          title={t.themeTitle}
        >
          {THEMES.map((th) => (
            <button
              key={th}
              type="button"
              onClick={() => setTheme(th)}
              aria-pressed={theme === th}
              className={
                "px-2.5 py-1 transition-colors " +
                (theme === th
                  ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                  : "hover:bg-[var(--color-ink)]/5")
              }
            >
              {th === "light"
                ? t.themeLight
                : th === "sepia"
                  ? t.themeSepia
                  : t.themeDark}
            </button>
          ))}
        </div>}
        {!nasSlim && <div
          role="group"
          aria-label="Image quality tier"
          className="flex items-center overflow-hidden rounded-full border border-[var(--color-edge)] text-xs"
          title="Image quality tier — fast (cheap), balanced (default), pro (premium)"
        >
          <span className="px-2 py-1 opacity-60">image</span>
          {TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setImageTier(tier)}
              disabled={busy}
              aria-pressed={imageTier === tier}
              className={
                "px-2.5 py-1 transition-colors disabled:opacity-40 " +
                (imageTier === tier
                  ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                  : "hover:bg-[var(--color-ink)]/5")
              }
            >
              {tier}
            </button>
          ))}
        </div>}
        {!nasSlim && <SpeedPreset
          busy={busy}
          imageTier={imageTier}
          setImageTier={setImageTier}
          knobs={loopKnobs}
          setKnobs={setLoopKnobs}
          sessionSpend={sessionSpend}
          devModel={devModel}
          setDevModel={setDevModel}
        />}
        {!nasSlim && <div
          role="group"
          aria-label="World Mode"
          className="flex items-center overflow-hidden rounded-full border border-[var(--color-edge)] text-xs"
          title="World Mode — tap to ENTER places (immersive scenes / closer sub-maps) instead of explaining a topic; entered places persist and reopen."
        >
          <button
            type="button"
            onClick={() => setWorldMode(!worldMode)}
            aria-pressed={worldMode}
            className={
              "px-2.5 py-1 transition-colors " +
              (worldMode
                ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                : "hover:bg-[var(--color-ink)]/5")
            }
          >
            world
          </button>
          {worldMode &&
            (["auto", "semi"] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAutonomy(a)}
                aria-pressed={autonomy === a}
                title={
                  a === "auto"
                    ? "Auto — enter straight away"
                    : "Semi — ask a quick question first"
                }
                className={
                  "px-2.5 py-1 transition-colors " +
                  (autonomy === a
                    ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                    : "hover:bg-[var(--color-ink)]/5")
                }
              >
                {a}
              </button>
            ))}
          {worldMode && (
            <button
              type="button"
              onClick={() => setDomLabels(!domLabels)}
              aria-pressed={domLabels}
              title="DOM labels — maps render with no baked text; place names overlay the image (crisper lettering, names never break clicks)"
              className={
                "px-2.5 py-1 transition-colors " +
                (domLabels
                  ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                  : "hover:bg-[var(--color-ink)]/5")
              }
            >
              labels
            </button>
          )}
        </div>}
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          className="min-h-11 flex-1 rounded-full bg-[var(--color-ink)] px-4 text-[var(--color-canvas)] disabled:opacity-40 sm:min-h-0 sm:flex-none sm:py-1"
        >
          {busy ? t.generating : t.go}
        </button>
      </form>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFileInputChange}
      />
    </>
  );
}
