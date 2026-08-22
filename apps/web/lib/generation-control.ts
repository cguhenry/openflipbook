export interface ActiveGeneration {
  generationId: string;
  controller: AbortController;
}

export function createGeneration(): ActiveGeneration {
  const generationId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `g-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { generationId, controller: new AbortController() };
}

/** Notify the backend first, then always abort the local SSE/fetch. */
export async function stopGeneration(
  active: ActiveGeneration,
  cancelEndpoint: string,
): Promise<void> {
  try {
    await fetch(cancelEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation_id: active.generationId }),
      keepalive: true,
    });
  } catch {
    // The local abort remains authoritative when the best-effort proxy fails.
  } finally {
    active.controller.abort();
  }
}
