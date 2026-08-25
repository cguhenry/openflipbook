import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    FLIPBOOK_NAS_SELF_USE: true,
    MONGODB_URI: "mongodb://test",
    MONGODB_DB: "openflipbook",
  },
  listNodesBySession: vi.fn(),
  deleteSessionRecords: vi.fn(),
  deleteStoredObjects: vi.fn(),
  uniqueStoredKeys: vi.fn(),
  requireOwner: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ readServerEnv: () => mocks.env }));
vi.mock("@/lib/db", () => ({
  listNodesBySession: mocks.listNodesBySession,
  deleteSessionRecords: mocks.deleteSessionRecords,
}));
vi.mock("@/lib/r2", () => ({
  deleteStoredObjects: mocks.deleteStoredObjects,
  uniqueStoredKeys: mocks.uniqueStoredKeys,
}));
vi.mock("@/lib/session-owner", () => ({ requireOwner: mocks.requireOwner }));

import { DELETE } from "@/app/api/sessions/[id]/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("DELETE /api/sessions/[id]", () => {
  beforeEach(() => {
    mocks.env.FLIPBOOK_NAS_SELF_USE = true;
    mocks.listNodesBySession.mockReset().mockResolvedValue({
      rows: [{ image_key: "images/session-cross-cookie.png" }],
      next_cursor: null,
    });
    mocks.deleteSessionRecords.mockReset().mockResolvedValue({ deleted_nodes: 1 });
    mocks.deleteStoredObjects.mockReset().mockResolvedValue(undefined);
    mocks.uniqueStoredKeys.mockReset().mockReturnValue(["images/session-cross-cookie.png"]);
    mocks.requireOwner.mockReset().mockResolvedValue({
      ok: false,
      res: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
  });

  it("allows NAS self-use deletion across owner cookies", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-cross-cookie"),
      params("session-cross-cookie"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      code: "SESSION_DELETE_OK",
      deleted_session_id: "session-cross-cookie",
      deleted_nodes: 1,
    });
    expect(mocks.requireOwner).not.toHaveBeenCalled();
    expect(mocks.deleteSessionRecords).toHaveBeenCalledWith("session-cross-cookie");
  });

  it("keeps the cross-owner deletion guard outside explicit NAS mode", async () => {
    mocks.env.FLIPBOOK_NAS_SELF_USE = false;
    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-cross-cookie"),
      params("session-cross-cookie"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "SESSION_DELETE_FORBIDDEN",
      error: "this session belongs to another browser",
    });
    expect(mocks.requireOwner).toHaveBeenCalledWith("session-cross-cookie");
    expect(mocks.listNodesBySession).not.toHaveBeenCalled();
    expect(mocks.deleteSessionRecords).not.toHaveBeenCalled();
  });

  it("returns stable error codes for invalid ids and persistence failures", async () => {
    const invalid = await DELETE(
      new Request("http://localhost/api/sessions/unsafe%2Fid"),
      params("unsafe/id"),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      code: "SESSION_DELETE_INVALID",
      error: "invalid session id",
    });

    mocks.listNodesBySession.mockRejectedValueOnce(new Error("db down"));
    const failed = await DELETE(
      new Request("http://localhost/api/sessions/session-failure"),
      params("session-failure"),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      code: "SESSION_DELETE_FAILED",
      error: "session delete failed",
    });
  });

  it("reports image cleanup as a warning after records are deleted", async () => {
    mocks.deleteStoredObjects.mockRejectedValueOnce(new Error("object store down"));
    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-cleanup-warning"),
      params("session-cleanup-warning"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      code: "SESSION_DELETE_IMAGE_CLEANUP_WARNING",
      image_cleanup_failed: true,
    });
  });
});
