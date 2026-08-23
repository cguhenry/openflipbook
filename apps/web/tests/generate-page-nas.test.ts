import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyOwner: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  inline: vi.fn(),
  resolveWorld: vi.fn(),
  getWorldMap: vi.fn(),
  spendOverCap: vi.fn(),
  recordSpend: vi.fn(),
  estimateCost: vi.fn(),
}));

vi.mock("@/lib/product-flags", () => ({
  PRODUCT_FLAGS: { nasSlim: true },
}));
vi.mock("@/lib/session-owner", () => ({
  verifyOwnerReadonly: mocks.verifyOwner,
}));
vi.mock("@/lib/idempotency", () => ({
  claimIdempotencyKey: mocks.claim,
  releaseIdempotencyKey: mocks.release,
}));
vi.mock("@/lib/r2", () => ({
  inlineStoredImage: mocks.inline,
}));
vi.mock("@/lib/world", () => ({
  resolveEntitiesForPrompt: mocks.resolveWorld,
}));
vi.mock("@/lib/world-map", () => ({
  getWorldMap: mocks.getWorldMap,
}));
vi.mock("@/lib/spend-ledger", () => ({
  spendOverCap: mocks.spendOverCap,
  recordSpend: mocks.recordSpend,
  estimateGenerationCost: mocks.estimateCost,
}));
vi.mock("@/lib/modal", () => ({
  modalAuthHeaders: () => ({}),
  modalUrl: (base: string, path: string) => base + path,
}));

import { POST } from "../app/api/generate-page/route";

describe("POST /api/generate-page in NAS slim", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("does not enforce or record guessed provider-dollar spend", async () => {
    vi.stubEnv("MODAL_API_URL", "http://backend.test");
    mocks.verifyOwner.mockResolvedValue({ ok: true });
    mocks.resolveWorld.mockResolvedValue([]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('data: {"type":"final"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost/api/generate-page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "steam engine",
        aspect_ratio: "16:9",
        web_search: false,
        session_id: "session-a",
        current_node_id: "",
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.spendOverCap).not.toHaveBeenCalled();
    expect(mocks.estimateCost).not.toHaveBeenCalled();
    expect(mocks.recordSpend).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
