import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import SessionHistory from "./SessionHistory";

describe("SessionHistory", () => {
  it("loads newest-first cards and exposes resume plus explicit new-session actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [
            {
              session_id: "s-new",
              title: "New atlas",
              node_count: 3,
              branch_count: 1,
              updated_at: "2026-08-22T01:00:00Z",
              has_image_seed: true,
            },
          ],
        }),
      }),
    );
    const onNewSession = vi.fn();
    const onResume = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(
      <SessionHistory
        currentSessionId="s-current"
        onNewSession={onNewSession}
        onResume={onResume}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const history = container.querySelector('button[aria-controls="session-history-panel"]');
    expect(history).toBeTruthy();
    history!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resume = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New atlas"),
    );
    expect(resume).toBeTruthy();
    expect(container.textContent).toContain("3 pages · 1 branches · image seed");
    resume!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onResume).toHaveBeenCalledWith("s-new");

    const newSession = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New session"),
    );
    expect(newSession).toBeTruthy();
    newSession!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    root.unmount();
    container.remove();
  });
});
