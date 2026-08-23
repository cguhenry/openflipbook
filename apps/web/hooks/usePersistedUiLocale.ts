"use client";

import {
  DEFAULT_UI_LOCALE,
  SUPPORTED_UI_LOCALES,
  type SupportedUiLocale,
  isRTL,
  normalizeLocaleTag,
} from "@/lib/i18n";

import { usePersistedState } from "./usePersistedState";

const KEY = "openflipbook.uiLocale";

function isUiLocale(value: unknown): value is SupportedUiLocale {
  return typeof value === "string" &&
    (SUPPORTED_UI_LOCALES as readonly string[]).includes(value);
}

function applyDocumentLocale(locale: SupportedUiLocale): void {
  const resolved = locale === "auto"
    ? normalizeLocaleTag(navigator.language || "en")
    : normalizeLocaleTag(locale);
  document.documentElement.setAttribute("lang", resolved);
  document.documentElement.setAttribute("dir", isRTL(resolved) ? "rtl" : "ltr");
}

/** Independent, SSR-safe interface-language preference. */
export function usePersistedUiLocale(): readonly [
  SupportedUiLocale,
  (locale: SupportedUiLocale) => void,
] {
  return usePersistedState<SupportedUiLocale>(
    KEY,
    DEFAULT_UI_LOCALE,
    isUiLocale,
    applyDocumentLocale,
  );
}
