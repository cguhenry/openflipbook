import { describe, expect, it } from "vitest";

import { nodeImagePath, safeStoredImageMedia } from "./node-image";

describe("persisted node image presentation", () => {
  it("derives a same-origin route from the node id without exposing a storage key", () => {
    expect(nodeImagePath("node/with spaces")).toBe(
      "/api/image/node%2Fwith%20spaces",
    );
  });

  it("allows browser-safe raster types and rejects active content", () => {
    expect(safeStoredImageMedia("IMAGE/PNG; charset=binary")).toEqual({
      contentType: "image/png",
      extension: "png",
    });
    expect(safeStoredImageMedia("image/jpeg")).toEqual({
      contentType: "image/jpeg",
      extension: "jpg",
    });
    expect(safeStoredImageMedia("image/svg+xml")).toBeNull();
    expect(safeStoredImageMedia("text/html")).toBeNull();
  });
});
