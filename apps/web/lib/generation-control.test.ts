import { describe, expect, it, vi } from "vitest";

import { createGeneration, stopGeneration } from "./generation-control";

describe("generation-control", () => {
  it("cancels the backend before aborting the local controller", async () => {
    const active = createGeneration();
    const order: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      order.push("request");
      expect(init?.body).toBe(JSON.stringify({ generation_id: active.generationId }));
      expect(active.controller.signal.aborted).toBe(false);
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
    });
    active.controller.signal.addEventListener("abort", () => order.push("abort"));

    await stopGeneration(active, "/api/generate-page/cancel");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/generate-page/cancel",
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
    expect(order).toEqual(["request", "abort"]);
    expect(active.controller.signal.aborted).toBe(true);
    fetchMock.mockRestore();
  });
});
