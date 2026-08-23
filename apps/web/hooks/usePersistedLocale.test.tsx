import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usePersistedLocale } from "./usePersistedLocale";

const KEY = "openflipbook.outputLocale";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
});

describe("usePersistedLocale", () => {
  it("defaults to 'auto' and does not control document language", () => {
    const { result } = renderHook(() => usePersistedLocale());
    expect(result.current[0]).toBe("auto");
    // First-run guard: don't clobber storage with "auto" or write attrs.
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(document.documentElement.getAttribute("lang")).toBeNull();
    expect(document.documentElement.getAttribute("dir")).toBeNull();
  });

  it("hydrates from a valid stored locale on mount", () => {
    window.localStorage.setItem(KEY, "fr");
    const { result } = renderHook(() => usePersistedLocale());
    expect(result.current[0]).toBe("fr");
  });

  it("ignores a stored value not in SUPPORTED_LOCALES", () => {
    window.localStorage.setItem(KEY, "xx-not-a-locale");
    const { result } = renderHook(() => usePersistedLocale());
    expect(result.current[0]).toBe("auto");
  });

  it("setting a new locale writes only the output preference", () => {
    const { result } = renderHook(() => usePersistedLocale());
    act(() => result.current[1]("fr"));
    expect(window.localStorage.getItem(KEY)).toBe("fr");
    expect(document.documentElement.getAttribute("lang")).toBeNull();
    expect(document.documentElement.getAttribute("dir")).toBeNull();
  });
});
