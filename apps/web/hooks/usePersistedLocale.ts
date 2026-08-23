"use client";

import {
  SUPPORTED_OUTPUT_LOCALES,
  type SupportedOutputLocale,
} from "@/lib/i18n";

import { usePersistedState } from "./usePersistedState";

const KEY = "openflipbook.outputLocale";

function isLocale(v: unknown): v is SupportedOutputLocale {
  return typeof v === "string" && (SUPPORTED_OUTPUT_LOCALES as readonly string[]).includes(v);
}

/**
 * Generated-content locale only. It intentionally has no DOM-language side
 * effect; interface language belongs to usePersistedUiLocale.
 */
export function usePersistedLocale(): readonly [SupportedOutputLocale, (l: SupportedOutputLocale) => void] {
  return usePersistedState<SupportedOutputLocale>(KEY, "auto", isLocale);
}
