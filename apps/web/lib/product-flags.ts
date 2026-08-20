export interface ProductFlags {
  nasSlim: boolean;
  video: boolean;
  aiPrefetch: boolean;
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
  };
}

export const PRODUCT_FLAGS = resolveProductFlags({
  NEXT_PUBLIC_NAS_SLIM: process.env.NEXT_PUBLIC_NAS_SLIM,
  NEXT_PUBLIC_VIDEO: process.env.NEXT_PUBLIC_VIDEO,
  NEXT_PUBLIC_AI_PREFETCH: process.env.NEXT_PUBLIC_AI_PREFETCH,
});
