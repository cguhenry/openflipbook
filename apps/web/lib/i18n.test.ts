import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultUiLocale,
  detectLocale,
  getStrings,
  isRTL,
  localizeGenerationError,
  normalizeLocaleTag,
  resolveOutputLocale,
  SUPPORTED_OUTPUT_LOCALES,
  SUPPORTED_UI_LOCALES,
} from "./i18n";

function withNavigatorLanguage<T>(lang: string | undefined, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(navigator, "language");
  Object.defineProperty(navigator, "language", {
    value: lang ?? "",
    configurable: true,
  });
  try {
    return fn();
  } finally {
    if (orig) Object.defineProperty(navigator, "language", orig);
  }
}

describe("isRTL", () => {
  it("flags RTL short tags", () => {
    expect(isRTL("ar")).toBe(true);
    expect(isRTL("ar-EG")).toBe(true);
    expect(isRTL("he")).toBe(true);
  });
  it("rejects LTR tags", () => {
    expect(isRTL("en-US")).toBe(false);
    expect(isRTL("ja")).toBe(false);
  });
});

describe("detectLocale", () => {
  it("returns supported short tag from navigator", () => {
    withNavigatorLanguage("fr-CA", () => {
      expect(detectLocale()).toBe("fr");
    });
  });
  it("falls back to auto for unsupported locales", () => {
    withNavigatorLanguage("xx-YY", () => {
      expect(detectLocale()).toBe("auto");
    });
  });

  it("preserves a browser Traditional Chinese preference", () => {
    withNavigatorLanguage("zh-Hant-TW", () => {
      expect(detectLocale()).toBe("zh-TW");
    });
  });
});

describe("getStrings", () => {
  it("falls back to English for missing keys", () => {
    const fr = getStrings("fr");
    // 'generating' is only defined in `en`; every other locale falls back.
    expect(fr.generating).toBe("…");
    expect(fr.go).toBe("Aller");
  });
  it("resolves auto via navigator", () => {
    withNavigatorLanguage("ja-JP", () => {
      const s = getStrings("auto");
      expect(s.upload).toContain("アップロード");
    });
  });
  it("returns English for an unknown locale", () => {
    const en = getStrings("xx");
    expect(en.go).toBe("Go");
  });

  it("provides Taiwan Traditional Chinese instead of the existing Simplified catalog", () => {
    expect(getStrings("zh-TW").settings).toBe("設定");
    expect(getStrings("zh-TW").upload).toContain("上傳");
    expect(getStrings("zh").upload).toContain("上传");
  });
});

describe("Chinese BCP-47 normalization", () => {
  it.each([
    ["zh-TW", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-CN", "zh"],
    ["zh-Hans", "zh"],
    ["zh-Hans-CN", "zh"],
    ["zh-SG", "zh"],
    ["zh", "zh"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeLocaleTag(input)).toBe(expected);
  });
});

describe("resolveOutputLocale", () => {
  it("returns explicit locale unchanged", () => {
    expect(resolveOutputLocale("es")).toBe("es");
  });
  it("auto resolves to navigator short tag", () => {
    withNavigatorLanguage("de-AT", () => {
      expect(resolveOutputLocale("auto")).toBe("de");
    });
  });

  it("normalizes Traditional Chinese without collapsing to plain zh", () => {
    expect(resolveOutputLocale("zh-Hant-TW")).toBe("zh-TW");
  });
});

describe("locale contracts", () => {
  it("has distinct UI/output locale sets with first-class zh-TW", () => {
    expect(SUPPORTED_UI_LOCALES).not.toBe(SUPPORTED_OUTPUT_LOCALES);
    expect(SUPPORTED_UI_LOCALES).toContain("zh-TW");
    expect(SUPPORTED_OUTPUT_LOCALES).toContain("zh-TW");
  });

  it("defaults the NAS profile to zh-TW while honoring an explicit valid value", () => {
    expect(defaultUiLocale({ NEXT_PUBLIC_NAS_SLIM: "true" })).toBe("zh-TW");
    expect(defaultUiLocale({
      NEXT_PUBLIC_NAS_SLIM: "true",
      NEXT_PUBLIC_DEFAULT_UI_LOCALE: "fr",
    })).toBe("fr");
  });
});

describe("generation error localization", () => {
  it("localizes cap and circuit-breaker messages without hiding retry time", () => {
    const t = getStrings("zh-TW");
    expect(localizeGenerationError("Runtime generation cap reached.", t)).toContain("產生上限");
    expect(localizeGenerationError(
      "OpenClaw is cooling down after repeated failures. Retry in about 42s",
      t,
    )).toContain("42 秒");
    expect(localizeGenerationError("opaque upstream detail", t)).toBe(t.generationFailedRetry);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
