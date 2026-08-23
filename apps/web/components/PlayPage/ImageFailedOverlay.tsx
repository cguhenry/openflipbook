"use client";

import { getStrings, type LocaleStrings } from "@/lib/i18n";

/**
 * Shown when the rendered <img> fires `onError`. Most common cause: a
 * permalink-replayed page whose R2 link expired (or the bucket's
 * public-access toggle got flipped off). The user just needs to start
 * a fresh query.
 */
export function ImageFailedOverlay({ t = getStrings("en") }: { t?: LocaleStrings }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/70 p-6 text-center text-white">
      <div className="max-w-md text-sm leading-relaxed">
        {t.imageLoadFailed}
      </div>
    </div>
  );
}
