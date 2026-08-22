export interface CitationSource {
  id?: string;
  title: string;
  url: string;
  snippet: string;
}

export interface CitationTextBlock {
  source_ids?: readonly string[];
}

export function sourceId(source: CitationSource, index: number): string {
  return source.id?.trim() || `S${index + 1}`;
}

export function citationNumbers(
  block: CitationTextBlock,
  sources: readonly CitationSource[],
): number[] {
  const byId = new Map<string, number>();
  sources.forEach((source, index) => {
    byId.set(sourceId(source, index), index + 1);
  });
  const out: number[] = [];
  for (const id of block.source_ids ?? []) {
    const number = byId.get(id);
    if (number !== undefined && !out.includes(number)) out.push(number);
  }
  return out;
}

export function safeExternalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
