"use client";

import { useEffect, useRef, useState } from "react";
import type { Citation, SourceRefV1 } from "@openflipbook/config";
import { safeExternalUrl } from "@/lib/citation-utils";
import { formatUi, getStrings, type LocaleStrings } from "@/lib/i18n";

interface CitationsChipProps {
  sources: Array<Citation | SourceRefV1>;
  t?: LocaleStrings;
}

export default function CitationsChip({ sources, t = getStrings("en") }: CitationsChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!sources || sources.length === 0) return null;

  return (
    <div
      ref={ref}
      className="pointer-events-auto absolute bottom-3 end-3 z-10 select-none"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={formatUi(t.sourcesAria, { count: sources.length })}
        title={formatUi(t.sourcesAria, { count: sources.length })}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1 rounded-full border border-[var(--color-ink)]/30 bg-[var(--color-paper)]/80 px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] backdrop-blur transition hover:bg-[var(--color-paper)]"
      >
        <span aria-hidden>📎</span>
        <span>{formatUi(t.sourcesCount, { count: sources.length })}</span>
      </button>
      {open && (
        <div className="absolute end-0 bottom-[calc(100%+0.5rem)] w-72 max-w-[80vw] rounded-xl border border-[var(--color-ink)]/20 bg-[var(--color-paper)] p-2 text-xs shadow-lg">
          <p className="px-1 pb-1 opacity-60">{t.sourcesUsed}</p>
          <ul className="flex flex-col gap-1">
            {sources.map((s, i) => {
              const host = safeHost(s.url);
              const href = safeExternalUrl(s.url);
              return (
                <li key={`${s.url}-${i}`}>
                  <a
                    href={href ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-md px-2 py-1.5 hover:bg-[var(--color-ink)]/5"
                    onClick={(event) => {
                      if (!href) event.preventDefault();
                    }}
                  >
                    <div className="line-clamp-2 font-medium">
                      {s.title || host || s.url}
                    </div>
                    {host && (
                      <div className="mt-0.5 truncate opacity-60">{host}</div>
                    )}
                    {s.snippet && (
                      <div className="mt-1 line-clamp-3 opacity-75">{s.snippet}</div>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
