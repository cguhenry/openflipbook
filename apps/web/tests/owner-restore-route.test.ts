import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existing: vi.fn(),
  commit: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  owner: vi.fn(),
}));

vi.mock("@/lib/owner-backup-store", () => ({
  existingBackupIds: mocks.existing,
  commitOwnerRestore: mocks.commit,
}));
vi.mock("@/lib/r2", () => ({
  putStoredBytesCreateOnly: mocks.put,
  deleteStoredObject: mocks.remove,
}));
vi.mock("@/lib/session-owner", () => ({
  currentOwnerToken: mocks.owner,
}));

import { POST } from "../app/api/backup/owner/restore/route";
import {
  buildOwnerBackupArchive,
  type BackupSourceNode,
} from "../lib/owner-backup";

const root: BackupSourceNode = {
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
  click_in_parent: null,
  sources: [],
  relation: "descend",
  scale: "peer",
  scale_tier: null,
  scene_view: null,
  page_plan: null,
  aligned_hotspots: null,
  seed_type: null,
  created_at: "2026-08-23T00:00:00.000Z",
};

async function request(options: { confirm?: boolean; header?: boolean } = {}) {
  const archive = await buildOwnerBackupArchive({
    sessions: ["session-a"],
    nodes: [root],
    images: new Map([
      ["root.png", { bytes: Buffer.from("image"), contentType: "image/png" }],
    ]),
  });
  const url = `http://localhost/api/backup/owner/restore${options.confirm ? "?confirm=true" : ""}`;
  const headers = new Headers({ "content-type": "application/zip" });
  if (options.header) {
    headers.set("x-openflipbook-restore-confirm", "RESTORE_OWNER_BACKUP");
  }
  const body = archive.bytes.buffer.slice(
    archive.bytes.byteOffset,
    archive.bytes.byteOffset + archive.bytes.byteLength,
  ) as ArrayBuffer;
  return POST(new Request(url, { method: "POST", headers, body }));
}

describe("POST /api/backup/owner/restore", () => {
  beforeEach(() => {
    mocks.existing.mockResolvedValue({
      sessionIds: new Set<string>(),
      nodeIds: new Set<string>(),
    });
    mocks.owner.mockResolvedValue("owner-token");
    mocks.put.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.commit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to a validated dry-run with no owner or storage mutation", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      dry_run: true,
      sessions: 1,
      nodes: 1,
      images: 1,
      provider_calls: 0,
    });
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("requires the explicit confirmation header before any mutation", async () => {
    const response = await request({ confirm: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "explicit restore confirmation header required",
    });
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("restores only after query and header confirmation", async () => {
    const response = await request({ confirm: true, header: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      dry_run: false,
      sessions: 1,
      nodes: 1,
      images: 1,
      provider_calls: 0,
    });
    expect(mocks.owner).toHaveBeenCalledWith({ mint: true });
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
