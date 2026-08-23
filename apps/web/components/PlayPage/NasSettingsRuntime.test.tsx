import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getStrings, type SupportedUiLocale } from "@/lib/i18n";
import { NasSettingsRuntime } from "./NasSettingsRuntime";

const runtimeStatus = {
  ok: true,
  live_provider: "openclaw",
  openclaw_connected: true,
  planner_vision_model: "openai/gpt-5.6-luna",
  image_model: "openai/gpt-image-2",
  searxng_connected: true,
  mongo_connected: true,
  minio_connected: true,
  provider_control: "read_only",
  model_control: "read_only",
  alternate_provider_fallback: false,
  breakers: {
    responses: { state: "closed", consecutive_failures: 0, retry_after_seconds: 0 },
    image: { state: "open", consecutive_failures: 3, retry_after_seconds: 42 },
  },
  usage: {
    scope: "since backend start",
    counters: {
      generation_requests: 4,
      generation_success: 3,
      generation_failed: 1,
      generation_cancelled: 0,
      planner_calls: 4,
      alignment_calls: 3,
      image_calls: 3,
      searxng_searches: 4,
    },
    caps: { runtime_generations: 0, session_generations: 10 },
  },
};

function setup(uiLocale: SupportedUiLocale = "en") {
  const t = getStrings(uiLocale);
  const props = {
    t,
    uiLocale,
    setUiLocale: vi.fn(),
    outputLocale: "auto" as const,
    setOutputLocale: vi.fn(),
    theme: "light" as const,
    setTheme: vi.fn(),
    motionPreference: "system" as const,
    setMotionPreference: vi.fn(),
    currentSessionId: "session-a",
    canExportOffline: true,
  };
  render(<NasSettingsRuntime {...props} />);
  fireEvent.click(screen.getByRole("button", { name: t.settings }));
  return props;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("NasSettingsRuntime", () => {
  it("shows only effective controls and read-only OpenClaw runtime truth", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(runtimeStatus), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
    const props = setup();
    const dialog = screen.getByRole("dialog", { name: "Settings / Runtime" });

    await within(dialog).findByText("openai/gpt-5.6-luna");
    expect(dialog.className).toContain("w-full");
    expect(dialog.className).toContain("overflow-y-auto");
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Close settings" }),
    );
    expect(within(dialog).getByText("OpenClaw (read-only)")).toBeTruthy();
    expect(within(dialog).getByText("No alternate provider fallback")).toBeTruthy();
    expect(within(dialog).getByText("since backend start")).toBeTruthy();
    expect(within(dialog).getByText("open · retry in 42s")).toBeTruthy();
    expect(dialog.textContent?.toLowerCase()).not.toContain("dollar");
    expect(within(dialog).queryByRole("combobox", { name: /provider/i })).toBeNull();

    fireEvent.change(within(dialog).getByRole("combobox", { name: "Output language" }), {
      target: { value: "fr" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sepia" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /always reduce motion/i }));
    expect(props.setOutputLocale).toHaveBeenCalledWith("fr");
    expect(props.setTheme).toHaveBeenCalledWith("sepia");
    expect(props.setMotionPreference).toHaveBeenCalledWith("reduce");

    expect(within(dialog).getByRole("link", { name: /offline book/i }).getAttribute("href"))
      .toBe("/api/export/offline/session-a");
    expect(within(dialog).getByRole("link", { name: /owner backup/i }).getAttribute("href"))
      .toBe("/api/backup/owner");
  });

  it("dry-runs a selected backup before enabling confirmed restore", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeStatus), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        dry_run: true,
        sessions: 1,
        nodes: 2,
        images: 2,
        remapped_sessions: 1,
        remapped_nodes: 2,
        provider_calls: 0,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        dry_run: false,
        sessions: 1,
        nodes: 2,
        images: 2,
        provider_calls: 0,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    const dialog = screen.getByRole("dialog", { name: "Settings / Runtime" });
    const input = within(dialog).getByLabelText("Choose owner backup archive");
    const file = new File(["zip"], "owner.zip", { type: "application/zip" });

    fireEvent.change(input, { target: { files: [file] } });
    await within(dialog).findByText(/Dry-run verified: 1 session, 2 pages/);
    const restore = within(dialog).getByRole("button", { name: "Confirm restore" });
    expect((restore as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(restore);
    await within(dialog).findByText(/Restore complete: 1 session, 2 pages/);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backup/owner/restore",
      expect.objectContaining({ method: "POST", body: file }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/backup/owner/restore?confirm=true",
      expect.objectContaining({
        method: "POST",
        body: file,
        headers: { "x-openflipbook-restore-confirm": "RESTORE_OWNER_BACKUP" },
      }),
    );
    await waitFor(() => expect((restore as HTMLButtonElement).disabled).toBe(true));
  });

  it("renders complete zh-TW NAS controls and keeps UI/output setters separate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(runtimeStatus), { status: 200 }),
    ));
    const props = setup("zh-TW");
    const dialog = screen.getByRole("dialog", { name: "設定 / 執行狀態" });

    await within(dialog).findByText("OpenClaw（唯讀）");
    expect(within(dialog).getByText("匯出與備份")).toBeTruthy();
    expect(within(dialog).getByText("服務狀態")).toBeTruthy();
    expect(within(dialog).getByText("斷路器")).toBeTruthy();
    expect(within(dialog).getByText("使用量")).toBeTruthy();

    fireEvent.change(within(dialog).getByRole("combobox", { name: "介面語言" }), {
      target: { value: "fr" },
    });
    expect(props.setUiLocale).toHaveBeenCalledWith("fr");
    expect(props.setOutputLocale).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole("combobox", { name: "輸出語言" }), {
      target: { value: "ja" },
    });
    expect(props.setOutputLocale).toHaveBeenCalledWith("ja");
    expect(props.setUiLocale).toHaveBeenCalledTimes(1);
  });
});
