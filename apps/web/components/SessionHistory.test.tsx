import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { getStrings } from "@/lib/i18n";
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
    const onDelete = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(
      <SessionHistory
        t={getStrings("en")}
        uiLocale="en"
        currentSessionId="s-current"
        onNewSession={onNewSession}
        onResume={onResume}
        onDelete={onDelete}
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
    expect(container.textContent).toContain("3 pages · 1 branch · image seed");
    const close = container.querySelector('button[aria-label="Close history"]');
    expect(close).toBeTruthy();
    expect(document.activeElement).toBe(close);
    expect(document.getElementById("session-history-panel")?.className).toContain("inset-x-3");
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

  it("renders normal History chrome in zh-TW", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] }),
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(
      <SessionHistory
        t={getStrings("zh-TW")}
        uiLocale="zh-TW"
        currentSessionId="s-current"
        onNewSession={vi.fn()}
        onResume={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const history = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("歷史紀錄"),
    );
    history?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("最近的工作階段");
    expect(container.textContent).toContain("新工作階段");
    expect(container.textContent).toContain("尚無已儲存的工作階段");
    root.unmount();
    container.remove();
  });

  it("confirms and deletes only the selected exact session", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/sessions/s-delete") {
        expect(init?.method).toBe("DELETE");
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          sessions: [{
            session_id: "s-delete",
            title: "Temporary HF2",
            node_count: 3,
            branch_count: 0,
            updated_at: "2026-08-22T01:00:00Z",
            has_image_seed: false,
          }],
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDelete = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(
      <SessionHistory
        t={getStrings("en")}
        uiLocale="en"
        currentSessionId="s-other"
        onNewSession={vi.fn()}
        onResume={vi.fn()}
        onDelete={onDelete}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector('button[aria-controls="session-history-panel"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deleteButton = container.querySelector('button[aria-label="Delete: Temporary HF2"]');
    expect(deleteButton).toBeTruthy();
    deleteButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Temporary HF2"));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s-delete", { method: "DELETE" });
    expect(onDelete).toHaveBeenCalledWith("s-delete");
    expect(container.querySelector('button[aria-label="Delete: Temporary HF2"]')).toBeNull();
    confirm.mockRestore();
    root.unmount();
    container.remove();
  });
});
