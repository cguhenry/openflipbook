import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNode: vi.fn(),
  getStoredBytes: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getNode: mocks.getNode }));
vi.mock("@/lib/r2", () => ({ getStoredBytes: mocks.getStoredBytes }));

import { GET } from "../app/api/image/[nodeId]/route";

const params = { params: Promise.resolve({ nodeId: "node-1" }) };

describe("GET /api/image/[nodeId]", () => {
  beforeEach(() => {
    vi.stubEnv("MONGODB_URI", "mongodb://mongo");
    vi.stubEnv("MONGODB_DB", "openflipbook");
    mocks.getNode.mockResolvedValue({
      id: "node-1",
      image_key: "session/private-key.png",
    });
    mocks.getStoredBytes.mockResolvedValue({
      bytes: Buffer.from([1, 2, 3]),
      contentType: "image/png",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("resolves node to image_key server-side and returns safe same-origin bytes", async () => {
    const response = await GET(
      new Request("http://openflipbook.test/api/image/node-1"),
      params,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(mocks.getNode).toHaveBeenCalledWith("node-1");
    expect(mocks.getStoredBytes).toHaveBeenCalledWith("session/private-key.png");
  });

  it("adds an attachment filename without exposing the storage key", async () => {
    const response = await GET(
      new Request("http://openflipbook.test/api/image/node-1?download=1"),
      params,
    );

    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="openflipbook-node-1.png"',
    );
    expect(response.headers.get("content-disposition")).not.toContain("private-key");
  });

  it("fails closed for unknown nodes and active stored content", async () => {
    mocks.getNode.mockResolvedValueOnce(null);
    const missing = await GET(
      new Request("http://openflipbook.test/api/image/missing"),
      { params: Promise.resolve({ nodeId: "missing" }) },
    );
    expect(missing.status).toBe(404);
    expect(mocks.getStoredBytes).not.toHaveBeenCalled();

    mocks.getNode.mockResolvedValueOnce({ id: "node-1", image_key: "unsafe" });
    mocks.getStoredBytes.mockResolvedValueOnce({
      bytes: Buffer.from("<svg/>"),
      contentType: "image/svg+xml",
    });
    const unsafe = await GET(
      new Request("http://openflipbook.test/api/image/node-1"),
      params,
    );
    expect(unsafe.status).toBe(415);
    expect(await unsafe.json()).toEqual({
      error: "unsupported image content type",
    });
  });
});
