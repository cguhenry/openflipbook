"use client";

import { formatUi, getStrings, type LocaleStrings } from "@/lib/i18n";

interface Beacon {
  nodeId: string;
  title: string;
  clickInParent: { xPct: number; yPct: number };
}

interface Props {
  /** Children of the currently rendered page that should surface as beacons. */
  beacons: Beacon[];
  onSelect: (nodeId: string) => void;
  t?: LocaleStrings;
}

interface BranchChooserProps {
  beacons: Beacon[];
  onSelect: (nodeId: string) => void;
  t?: LocaleStrings;
}

/** Text navigation belongs in document flow; only the click-origin beacons
 * remain over the image. */
export function BranchChooser({
  beacons,
  onSelect,
  t = getStrings("en"),
}: BranchChooserProps) {
  if (beacons.length < 2) return null;
  return (
    <div
      data-testid="branch-chooser"
      aria-label={t.existingBranches}
      className="flex w-full flex-wrap items-center justify-center gap-1 rounded-xl border border-[var(--color-ink)]/20 bg-[var(--color-paper)]/90 px-2 py-2 text-xs shadow-sm"
    >
      <span className="px-1 opacity-70">{t.branches}</span>
      {beacons.map((kid) => (
        <button
          key={`chooser-${kid.nodeId}`}
          type="button"
          onClick={() => onSelect(kid.nodeId)}
          className="max-w-48 truncate rounded-full border border-[var(--color-ink)]/20 px-2.5 py-1 hover:bg-[var(--color-ink)]/10"
          title={kid.title}
        >
          {kid.title}
        </button>
      ))}
    </div>
  );
}

/**
 * Small pill markers at the click coordinates where a child page already
 * exists, so the user can jump straight back into a branch they already
 * explored. Hidden by parent when the page is mid-stream or beacons are
 * toggled off via the context menu.
 */
export function BranchBeacons({ beacons, onSelect, t = getStrings("en") }: Props) {
  if (beacons.length === 0) return null;
  return (
    <>
      {beacons.map((kid) => (
        <button
          key={kid.nodeId}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(kid.nodeId);
          }}
          className="group absolute z-10 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
          style={{
            left: `${kid.clickInParent.xPct * 100}%`,
            top: `${kid.clickInParent.yPct * 100}%`,
          }}
          title={formatUi(t.openBranch, { title: kid.title })}
          aria-label={formatUi(t.openBranch, { title: kid.title })}
        >
          <span className="absolute inline-block h-7 w-7 rounded-full bg-white/0 ring-1 ring-white/0 transition-all group-hover:bg-white/30 group-hover:ring-white/80" />
          <span className="relative inline-block h-2.5 w-2.5 rounded-full bg-white/55 shadow-[0_0_0_1.5px_rgba(0,0,0,0.45)] transition-all group-hover:h-3.5 group-hover:w-3.5 group-hover:bg-red-400 group-hover:shadow-[0_0_0_2px_rgba(0,0,0,0.7)]" />
        </button>
      ))}
    </>
  );
}
