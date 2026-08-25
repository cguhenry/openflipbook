"use client";

import { formatUi, getStrings, type LocaleStrings } from "@/lib/i18n";

interface Props {
  topics: string[];
  loading: boolean;
  error: boolean;
  onPick: (topic: string) => void;
  onClose: () => void;
  t?: LocaleStrings;
}
/** Text-only suggestions stay in normal document flow below the image. */
export function RelatedTopicsTray({
  topics,
  loading,
  error,
  onPick,
  onClose,
  t = getStrings("en"),
}: Props) {
  const empty = !loading && topics.length === 0;
  return (
    <div
      role="region"
      aria-label={t.relatedTopicsRegion}
      aria-busy={loading}
      data-testid="related-topics-tray"
      className="w-full rounded-xl border border-[var(--color-ink)]/20 bg-[var(--color-paper)]/90 px-3 py-2 shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{t.relatedTopics}</span>
        <button
          type="button"
          aria-label={t.closeRelatedTopics}
          onClick={onClose}
          className="rounded px-1.5 py-0.5 opacity-70 hover:bg-[var(--color-ink)]/10 hover:opacity-100"
        >
          {t.close}
        </button>
      </div>
      {loading ? (
        <p className="mt-2 text-xs opacity-70">{t.loadingRelatedTopics}</p>
      ) : error ? (
        <p className="mt-2 text-xs text-red-700">{t.relatedTopicsFailed}</p>
      ) : empty ? (
        <p className="mt-2 text-xs opacity-70">{t.relatedTopicsEmpty}</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="related-topic-chips">
          {topics.map((topic) => (
            <button
              key={topic}
              type="button"
              onClick={() => onPick(topic)}
              className="max-w-full rounded-full border border-teal-700/30 bg-teal-50 px-3 py-1.5 text-left text-xs text-teal-950 hover:bg-teal-100"
              aria-label={formatUi(t.chooseRelatedTopic, { topic })}
            >
              {topic}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
