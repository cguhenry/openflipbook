import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOwned: vi.fn(),
  listNodes: vi.fn(),
  getStored: vi.fn(),
}));

vi.mock("@/lib/session-owner", () => ({
  listCurrentOwnerSessionIds: mocks.listOwned,
}));
vi.mock("@/lib/db", () => ({
  listNodesBySession: mocks.listNodes,
}));
vi.mock("@/lib/r2", () => ({
  getStoredBytes: mocks.getStored,
}));

import { GET } from "../app/api/backup/owner/route";
import { parseOwnerBackupArchive } from "../lib/owner-backup";

const row = {
  id: "root",
  parent_id: null,
  source_hotspot_id: null,
  session_id: "session-a",
  query: "steam engine",
  page_title: "Steam Engine",
  image_key: "root.png",
  image_model: "openai/gpt-image-2",
  prompt_author_model: "openai/gpt-5.6-luna",
  aspect_ratio: "16:9",
  final_prompt: null,
  click_in_parent: null,
  sources: [],
  relation: "descend",
  scale: "peer",
  scale_tier: null,
  scene_view: null,
  page_plan: null,
  aligned_hotspots: null,
  seed_type: null,
  geo_extracted: false,
  created_at: "2026-08-23T00:00:00.000Z",
};

describe("GET /api/backup/owner", () => {
  beforeEach(() => {
    vi.stubEnv("MONGODB_URI", "mongodb://mongo");
    vi.stubEnv("MONGODB_DB", "openflipbook");
    vi.stubEnv("R2_ENDPOINT", "http://minio:9000");
    vi.stubEnv("R2_BUCKET", "openflipbook");
    vi.stubEnv("R2_ACCESS_KEY_ID", "fake-access");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "fake-secret");
    vi.stubEnv("R2_PUBLIC_BASE_URL", "http://minio/openflipbook");
    mocks.listOwned.mockResolvedValue(["session-a"]);
    mocks.listNodes.mockResolvedValue({ rows: [row], next_cursor: null });
    mocks.getStored.mockResolvedValue({
      bytes: Buffer.from("image"),
      contentType: "image/png",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("exports only current-browser owner rows with a verified manifest", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("x-openflipbook-backup-sessions")).toBe("1");
    expect(response.headers.get("x-openflipbook-backup-nodes")).toBe("1");
    const parsed = await parseOwnerBackupArchive(
      new Uint8Array(await response.arrayBuffer()),
    );
    expect(parsed.sessions).toEqual(["session-a"]);
    expect(parsed.nodes.map((node) => node.id)).toEqual(["root"]);
    expect(mocks.listNodes).toHaveBeenCalledWith("session-a", {
      cursor: null,
      limit: 200,
    });
  });

  it("fails closed when a required owner image is missing", async () => {
    mocks.getStored.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "owner backup image is unavailable",
      node_id: "root",
    });
  });

  it("does not export another browser when there is no owner cookie", async () => {
    mocks.listOwned.mockResolvedValue([]);

    const response = await GET();

    expect(response.status).toBe(404);
    expect(mocks.listNodes).not.toHaveBeenCalled();
  });
});
