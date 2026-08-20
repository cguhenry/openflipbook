import { describe, expect, it } from "vitest";

import { resolveProductFlags } from "./product-flags";

describe("NAS product flags", () => {
  it("defaults to upstream-compatible optional features", () => {
    expect(resolveProductFlags({})).toEqual({
      nasSlim: false,
      video: true,
      aiPrefetch: true,
    });
  });

  it("NAS slim force-disables video and automatic AI prefetch", () => {
    expect(
      resolveProductFlags({
        NEXT_PUBLIC_NAS_SLIM: "1",
        NEXT_PUBLIC_VIDEO: "1",
        NEXT_PUBLIC_AI_PREFETCH: "1",
      }),
    ).toEqual({ nasSlim: true, video: false, aiPrefetch: false });
  });

  it("allows individual opt-out outside NAS slim", () => {
    expect(
      resolveProductFlags({
        NEXT_PUBLIC_VIDEO: "false",
        NEXT_PUBLIC_AI_PREFETCH: "0",
      }),
    ).toEqual({ nasSlim: false, video: false, aiPrefetch: false });
  });
});
