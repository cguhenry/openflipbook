import { describe, expect, it } from "vitest";
import { resolveProductFlags } from "./product-flags";

describe("A2 NAS interaction flags", () => {
  it("keeps DOM labels and deterministic hitmap opt-in outside NAS compose", () => {
    expect(resolveProductFlags({})).toMatchObject({
      domLabels: false,
      deterministicHitmap: false,
    });
  });

  it("enables the new A2 interaction path explicitly", () => {
    expect(resolveProductFlags({
      NEXT_PUBLIC_NAS_SLIM: "1",
      NEXT_PUBLIC_DOM_LABELS: "1",
      NEXT_PUBLIC_DETERMINISTIC_HITMAP: "1",
    })).toMatchObject({
      nasSlim: true,
      video: false,
      aiPrefetch: false,
      domLabels: true,
      deterministicHitmap: true,
    });
  });
});
