export interface ProductFlags {
  nasSlim: boolean;
  video: boolean;
  aiPrefetch: boolean;
  domLabels: boolean;
  deterministicHitmap: boolean;
  html5Transitions: boolean;
  offlineExport: boolean;
}

function flag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null || raw.trim() === "") return defaultValue;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

export function resolveProductFlags(
  env: Record<string, string | undefined>,
): ProductFlags {
  const nasSlim = flag(env.NEXT_PUBLIC_NAS_SLIM, false);
  return {
    nasSlim,
    // NAS slim is an overriding safety profile. Explicit sub-flags can disable
    // features elsewhere, but cannot re-enable them while NAS slim is on.
    video: !nasSlim && flag(env.NEXT_PUBLIC_VIDEO, true),
    aiPrefetch: !nasSlim && flag(env.NEXT_PUBLIC_AI_PREFETCH, true),
    domLabels: flag(env.NEXT_PUBLIC_DOM_LABELS, false),
    deterministicHitmap: flag(env.NEXT_PUBLIC_DETERMINISTIC_HITMAP, false),
    html5Transitions: flag(env.NEXT_PUBLIC_HTML5_TRANSITIONS, false),
    offlineExport: flag(env.NEXT_PUBLIC_OFFLINE_EXPORT, false),
  };
}

export const PRODUCT_FLAGS = resolveProductFlags({
  NEXT_PUBLIC_NAS_SLIM: process.env.NEXT_PUBLIC_NAS_SLIM,
  NEXT_PUBLIC_VIDEO: process.env.NEXT_PUBLIC_VIDEO,
  NEXT_PUBLIC_AI_PREFETCH: process.env.NEXT_PUBLIC_AI_PREFETCH,
  NEXT_PUBLIC_DOM_LABELS: process.env.NEXT_PUBLIC_DOM_LABELS,
  NEXT_PUBLIC_DETERMINISTIC_HITMAP: process.env.NEXT_PUBLIC_DETERMINISTIC_HITMAP,
  NEXT_PUBLIC_HTML5_TRANSITIONS: process.env.NEXT_PUBLIC_HTML5_TRANSITIONS,
  NEXT_PUBLIC_OFFLINE_EXPORT: process.env.NEXT_PUBLIC_OFFLINE_EXPORT,
});
