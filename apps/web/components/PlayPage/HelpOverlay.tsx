"use client";

import { getStrings, type LocaleStrings } from "@/lib/i18n";

interface Props {
  onClose: () => void;
  t?: LocaleStrings;
}

/**
 * Modal that lists every keyboard shortcut. Reachable via `?` and from
 * the first-run coach overlay. Click-outside or the explicit Close
 * button dismisses; Esc handling is wired on the page so it stacks
 * properly with the quickbar / context menu.
 */
export function HelpOverlay({ onClose, t = getStrings("en") }: Props) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-[var(--color-edge)] bg-[var(--color-canvas)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg">{t.shortcuts}</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row k="←" v={t.back} />
          <Row k="→" v={t.forward} />
          <Row k={t.keyBackspace} v={t.shortcutBackShift} />
          <Row k="M" v={t.shortcutToggleMap} />
          <Row k="T" v={t.shortcutToggleScrubber} />
          <Row k="K" v={t.shortcutToggleCodex} />
          <Row k="G" v={t.shortcutToggleGeometry} />
          <Row k="E" v={t.shortcutLookAround} />
          <Row k="/" v={t.shortcutJump} />
          <Row k="?" v={t.shortcutHelp} />
          <Row k={t.keyEscape} v={t.shortcutClose} />
          <Row k={t.keyRightClick} v={t.shortcutPageMenu} />
          <Row k={t.keyModifiedClick} v={t.shortcutClickNote} />
          <Row k={t.keyShiftDrag} v={t.shortcutCircle} />
        </dl>
        <button
          type="button"
          className="mt-4 w-full rounded-md border border-[var(--color-edge)] py-1.5 text-sm hover:bg-[var(--color-ink)]/10"
          onClick={onClose}
        >
          {t.close}
        </button>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="font-mono text-xs opacity-80">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </div>
  );
}
