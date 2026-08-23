import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listNodesBySession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  listNodesBySession: mocks.listNodesBySession,
}));

import { GET } from "../app/api/sessions/[id]/route";

describe("persisted session image presentation", () => {
  beforeEach(() => {
    vi.stubEnv("MONGODB_URI", "mongodb://mongo");
    vi.stubEnv("MONGODB_DB", "openflipbook");
    vi.stubEnv("R2_PUBLIC_BASE_URL", "http://localhost:9000/openflipbook");
    mocks.listNodesBySession.mockResolvedValue({
      rows: [{
        id: "node-1",
        parent_id: null,
        source_hotspot_id: null,
        session_id: "session-1",
        query: "steam engine",
        page_title: "Steam Engine",
        image_key: "session-1/image.png",
        image_model: "openai/gpt-image-2",
        prompt_author_model: "openai/gpt-5.6-luna",
        aspect_ratio: "16:9",
        click_in_parent: null,
        sources: [],
        relation: "descend",
        scene_view: null,
        geo_extracted: false,
        page_plan: null,
        aligned_hotspots: null,
        seed_type: null,
        created_at: "2026-08-24T00:00:00.000Z",
      }],
      next_cursor: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("keeps the legacy storage URL while adding the normal browser URL", async () => {
    const response = await GET(
      new Request("http://openflipbook.test/api/sessions/session-1"),
      { params: Promise.resolve({ id: "session-1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.nodes[0].image_url).toBe(
      "http://localhost:9000/openflipbook/session-1/image.png",
    );
    expect(payload.nodes[0].browser_image_url).toBe("/api/image/node-1");
  });
});
