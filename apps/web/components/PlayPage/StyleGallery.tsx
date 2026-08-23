"use client";

import { STYLE_PRESETS } from "@/lib/styles";
import { getStrings, type LocaleStrings } from "@/lib/i18n";

interface Props {
  onPick: (presetId: string) => void;
  onSkip: () => void;
  t?: LocaleStrings;
}

function presetName(id: string, fallback: string, t: LocaleStrings): string {
  const names: Record<string, string> = {
    storybook: t.styleStorybook,
    woodcut: t.styleWoodcut,
    cyberpunk: t.styleCyberpunk,
    vintage: t.styleVintage,
    botanical: t.styleBotanical,
    comic: t.styleComic,
    noir: t.styleNoir,
    pixel: t.stylePixel,
  };
  return names[id] ?? fallback;
}

/**
 * Empty-state style picker on /play. Renders the 8 preset tiles plus a
 * skip link that drops to a bare query box. No internal state — the
 * orchestrator handles what to do on pick/skip.
 */
export function StyleGallery({ onPick, onSkip, t = getStrings("en") }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 py-10">
      <div className="text-center">
        <h2 className="text-xl font-medium tracking-tight">
          {t.pickStyleHeading}
        </h2>
        <p className="mt-1 text-sm opacity-60">
          {t.pickStyleHelp}
        </p>
      </div>

      <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
        {STYLE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p.id)}
            aria-label={presetName(p.id, p.name, t)}
            className="ec-style-tile group relative aspect-[4/3] overflow-hidden rounded-md text-left shadow-sm transition-transform hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink)]"
            style={{
              background: `linear-gradient(135deg, ${p.gradient[0]}, ${p.gradient[1]})`,
              color: p.textColor,
            }}
          >
            <span
              aria-hidden
              className="absolute inset-0 bg-gradient-to-b from-transparent to-black/55"
            />
            <span className="absolute bottom-2 left-3 z-10 text-xs font-semibold uppercase tracking-wider drop-shadow-sm">
              {presetName(p.id, p.name, t)}
            </span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onSkip}
        className="text-sm opacity-60 underline-offset-4 transition hover:opacity-100 hover:underline"
      >
        {t.skipStyle}
      </button>
    </div>
  );
}
