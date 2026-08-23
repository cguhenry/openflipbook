import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "public/theme-init.js"),
  "utf8",
);

function runThemeInit(input: {
  initialLang: string;
  uiLocale?: string;
  outputLocale?: string;
  browserLocale?: string;
}) {
  const attributes = new Map<string, string>([["lang", input.initialLang]]);
  const storage = new Map<string, string>();
  if (input.uiLocale) storage.set("openflipbook.uiLocale", input.uiLocale);
  if (input.outputLocale) {
    storage.set("openflipbook.outputLocale", input.outputLocale);
  }
  runInNewContext(source, {
    document: {
      documentElement: {
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value);
        },
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
    },
    navigator: { language: input.browserLocale ?? "en-US" },
  });
  return attributes;
}

describe("theme-init UI locale", () => {
  it("keeps the SSR NAS default when no UI preference exists", () => {
    const attributes = runThemeInit({
      initialLang: "zh-TW",
      browserLocale: "en-US",
    });
    expect(attributes.get("lang")).toBe("zh-TW");
    expect(attributes.get("dir")).toBe("ltr");
  });

  it("uses only the UI preference and never the output preference", () => {
    const attributes = runThemeInit({
      initialLang: "zh-TW",
      uiLocale: "en",
      outputLocale: "ar",
    });
    expect(attributes.get("lang")).toBe("en");
    expect(attributes.get("dir")).toBe("ltr");
  });

  it("preserves Traditional Chinese and applies RTL for Arabic UI", () => {
    expect(
      runThemeInit({ initialLang: "en", uiLocale: "zh-Hant" }).get("lang"),
    ).toBe("zh-TW");
    const arabic = runThemeInit({ initialLang: "zh-TW", uiLocale: "ar" });
    expect(arabic.get("lang")).toBe("ar");
    expect(arabic.get("dir")).toBe("rtl");
  });
});
