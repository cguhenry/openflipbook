import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync(
  resolve(process.cwd(), "../../docker-compose.yml"),
  "utf8",
);
const playPage = readFileSync(resolve(process.cwd(), "app/play/page.tsx"), "utf8");

describe("NAS compose product defaults", () => {
  it("keeps the fixed OpenClaw path with zero-default operational caps", () => {
    expect(compose).toContain('FLIPBOOK_LIVE_PROVIDER: "openclaw"');
    expect(compose).toContain("FLIPBOOK_MAX_RUNTIME_GENERATIONS:-0");
    expect(compose).toContain("FLIPBOOK_MAX_SESSION_GENERATIONS:-0");
  });

  it("enables existing transitions/offline export without AI video or prefetch", () => {
    expect(compose).toContain("NEXT_PUBLIC_HTML5_TRANSITIONS:-true");
    expect(compose).toContain("NEXT_PUBLIC_OFFLINE_EXPORT:-true");
    expect(compose).toContain("NEXT_PUBLIC_VIDEO:-false");
    expect(compose).toContain("NEXT_PUBLIC_AI_PREFETCH:-false");
  });

  it("neutralizes hidden legacy request knobs on the NAS request path", () => {
    expect(playPage).toContain("PRODUCT_FLAGS.nasSlim ? {} : wireFields(loopKnobs)");
    expect(playPage).toContain(
      'const requestImageTier = PRODUCT_FLAGS.nasSlim ? "balanced" : imageTier;',
    );
    expect(playPage).toContain("!PRODUCT_FLAGS.nasSlim && EDIT_REGION_ENABLED");
  });

  it("keeps narrow-screen navigation wrapping inside safe-area padding", () => {
    expect(playPage).toContain("env(safe-area-inset-bottom)");
    expect(playPage).toContain(
      "flex flex-wrap items-center justify-between gap-3 text-xs opacity-80",
    );
    expect(playPage).toContain("min-h-11 rounded-full border");
  });
});
