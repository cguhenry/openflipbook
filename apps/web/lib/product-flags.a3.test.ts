import { describe, expect, it } from "vitest";
import { resolveProductFlags } from "./product-flags";

describe("A3 product flags", () => {
  it("enables offline export and HTML5 transitions explicitly", () => {
    const flags = resolveProductFlags({
      NEXT_PUBLIC_NAS_SLIM: "1",
      NEXT_PUBLIC_HTML5_TRANSITIONS: "1",
      NEXT_PUBLIC_OFFLINE_EXPORT: "1",
      NEXT_PUBLIC_DOM_LABELS: "1",
      NEXT_PUBLIC_DETERMINISTIC_HITMAP: "1",
    });
    expect(flags.html5Transitions).toBe(true);
    expect(flags.offlineExport).toBe(true);
    expect(flags.domLabels).toBe(true);
    expect(flags.deterministicHitmap).toBe(true);
  });

  it("keeps A3 features opt-in outside the NAS profile", () => {
    const flags = resolveProductFlags({});
    expect(flags.html5Transitions).toBe(false);
    expect(flags.offlineExport).toBe(false);
  });
});
