import { describe, expect, it } from "vitest";

import { citationNumbers, safeExternalUrl, sourceId } from "./citation-utils";

describe("citation-utils", () => {
  const sources = [
    { id: "S1", title: "A", url: "https://a.test/", snippet: "a" },
    { title: "B", url: "https://b.test/", snippet: "b" },
  ];

  it("maps local source ids to stable one-based markers", () => {
    expect(sourceId(sources[1]!, 1)).toBe("S2");
    expect(citationNumbers({ source_ids: ["S2", "S1", "S2", "FAKE"] }, sources)).toEqual([2, 1]);
  });

  it("allows only external http(s) URLs", () => {
    expect(safeExternalUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("/local/page")).toBeNull();
  });
});
