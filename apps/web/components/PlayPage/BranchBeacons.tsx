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
      {beacons.length > 1 && (
        <div
          data-testid="branch-chooser"
          aria-label={t.existingBranches}
          className="pointer-events-auto absolute left-1/2 top-3 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-full border border-white/40 bg-black/60 px-2 py-1 text-[11px] text-white shadow-lg backdrop-blur"
        >
          <span className="px-1 opacity-75">{t.branches}</span>
          {beacons.map((kid) => (
            <button
              key={`chooser-${kid.nodeId}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(kid.nodeId);
              }}
              className="max-w-36 truncate rounded-full bg-white/15 px-2 py-0.5 hover:bg-white/30"
              title={kid.title}
            >
              {kid.title}
            </button>
          ))}
        </div>
      )}
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
