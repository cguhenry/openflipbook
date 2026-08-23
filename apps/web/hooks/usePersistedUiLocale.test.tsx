import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usePersistedLocale } from "./usePersistedLocale";
import { usePersistedUiLocale } from "./usePersistedUiLocale";

const UI_KEY = "openflipbook.uiLocale";
const OUTPUT_KEY = "openflipbook.outputLocale";

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

describe("usePersistedUiLocale", () => {
  it("hydrates a valid explicit UI choice and applies document language", () => {
    window.localStorage.setItem(UI_KEY, "zh-TW");
    const { result } = renderHook(() => usePersistedUiLocale());
    expect(result.current[0]).toBe("zh-TW");
    expect(document.documentElement.lang).toBe("zh-TW");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("keeps interface and output preferences independent in both directions", () => {
    const { result } = renderHook(() => {
      const ui = usePersistedUiLocale();
      const output = usePersistedLocale();
      return { ui, output };
    });

    act(() => result.current.ui[1]("zh-TW"));
    expect(window.localStorage.getItem(UI_KEY)).toBe("zh-TW");
    expect(window.localStorage.getItem(OUTPUT_KEY)).toBeNull();
    expect(result.current.output[0]).toBe("auto");

    act(() => result.current.output[1]("fr"));
    expect(window.localStorage.getItem(OUTPUT_KEY)).toBe("fr");
    expect(window.localStorage.getItem(UI_KEY)).toBe("zh-TW");
    expect(result.current.ui[0]).toBe("zh-TW");
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("uses RTL direction only for the interface locale", () => {
    const { result } = renderHook(() => usePersistedUiLocale());
    act(() => result.current[1]("ar"));
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });
});
