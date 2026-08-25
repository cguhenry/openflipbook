import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { AlignedHotspotV1, PagePlanV1 } from "@openflipbook/config";

const B4_SESSION_ID = "session_b3_live_8ce2bf1163044e9f92c878345dbbfec6";
const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

interface GenerationCall {
  source_hotspot_id?: string;
  query?: string;
}

function bboxFor(index: number): readonly [number, number, number, number] {
  return [
    (index % 4) * 0.24 + 0.02,
    Math.floor(index / 4) * 0.38 + 0.12,
    0.18,
    0.24,
  ];
}

function fixturePlan(): PagePlanV1 {
  return {
    schema_version: "1.0",
    title: "HF3 R1 rich scene",
    summary: "A deterministic rich-scene fixture for NAS acceptance.",
    scene: {
      prompt: "A clean illustrated machine cutaway with eight distinct regions, no text, no labels.",
      style: "clean illustrated textbook",
      aspect_ratio: "16:9",
    },
    text_blocks: [
      {
        id: "t001",
        role: "title",
        text: "HF3 R1 rich scene",
        anchor: "top-left",
        source_ids: ["S1", "S2"],
      },
      {
        id: "t002",
        role: "subtitle",
        text: "Eight explorable regions",
        anchor: "top",
        source_ids: ["S1"],
      },
    ],
    hotspots: Array.from({ length: 8 }, (_, index) => ({
      id: `h${String(index + 1).padStart(3, "0")}`,
      label: `Region ${index + 1}`,
      sub_query: `What does region ${index + 1} do?`,
      visual_target: `distinct machine region ${index + 1}`,
      desired_bbox: bboxFor(index),
    })),
    motion_hints: [],
    sources: [
      {
        id: "S1",
        title: "HF3 source one",
        url: "https://example.com/hf3-source-one",
        snippet: "Synthetic source metadata for the HF3 citation panel.",
      },
      {
        id: "S2",
        title: "HF3 source two",
        url: "https://example.com/hf3-source-two",
        snippet: "A second synthetic source retained in the page contract.",
      },
    ],
  };
}

function alignedFor(plan: PagePlanV1): AlignedHotspotV1[] {
  return plan.hotspots.slice(0, 5).map((hotspot) => {
    const [x, y, width, height] = hotspot.desired_bbox;
    return {
      id: hotspot.id,
      actual_bbox: hotspot.desired_bbox,
      tap_region: [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
      ],
      alignment_confidence: 0.9,
    };
  });
}

async function getJson(request: APIRequestContext, url: string): Promise<unknown> {
  const response = await request.get(url);
  expect(response.ok(), `${url} must be readable`).toBe(true);
  return response.json();
}

async function waitForImage(page: Page, nodeId: string): Promise<void> {
  const image = page.locator('figure img[alt]:not([alt=""])').first();
  await expect(image).toHaveAttribute("src", `/api/image/${nodeId}`);
  await expect.poll(
    () => image.evaluate((element) => {
      const img = element as HTMLImageElement;
      return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
    }),
    { timeout: 60_000 },
  ).toBe(true);
}

test.setTimeout(180_000);

test("HF3 R1 NAS cross-cookie history and rich hotspot acceptance", async ({ browser }) => {
  const configuredBaseUrl = process.env.E2E_BASE_URL;
  const resultsDir = process.env.E_RESULTS_DIR;
  if (!configuredBaseUrl || !resultsDir) {
    throw new Error("E2E_BASE_URL and E_RESULTS_DIR are required for HF3 R1 acceptance");
  }
  const baseUrl = configuredBaseUrl.replace(/\/$/, "");
  await mkdir(resultsDir, { recursive: true });

  const sessionId = `session_hf3_r1_${randomUUID().replaceAll("-", "")}`;
  const sessionTitle = "HF3 R1 synthetic rich scene";
  const plan = fixturePlan();
  const aligned = alignedFor(plan);
  const contextA = await browser.newContext({ locale: "zh-TW" });
  const contextB = await browser.newContext({ locale: "zh-TW" });
  let created = false;
  const generationCalls: GenerationCall[] = [];
  const unexpectedSemanticCalls: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    const existingSessions = (await getJson(
      contextB.request,
      `${baseUrl}/api/sessions`,
    )) as { sessions: Array<{ session_id: string }> };
    const controlSessionId = existingSessions.sessions.find(
      (session) => session.session_id !== B4_SESSION_ID,
    )?.session_id;
    expect(controlSessionId, "an existing control session is required").toBeTruthy();

    const createResponse = await contextA.request.post(`${baseUrl}/api/nodes`, {
      data: {
        session_id: sessionId,
        query: "HF3 R1 synthetic rich scene",
        page_title: sessionTitle,
        image_data_url: IMAGE_DATA_URL,
        image_model: "synthetic/no-provider",
        prompt_author_model: "synthetic/no-provider",
        aspect_ratio: "16:9",
        final_prompt: "synthetic HF3 fixture",
        sources: plan.sources,
        page_plan: plan,
        aligned_hotspots: aligned,
      },
    });
    expect(createResponse.ok(), await createResponse.text()).toBe(true);
    const createdNode = (await createResponse.json()) as { id: string };
    created = true;

    const backupResponse = await contextA.request.get(`${baseUrl}/api/backup/owner`);
    expect(backupResponse.ok(), await backupResponse.text()).toBe(true);
    const backupPath = `${resultsDir}/HF3_R1_OWNER_BACKUP.zip`;
    await writeFile(backupPath, await backupResponse.body());

    const b4Before = await getJson(
      contextB.request,
      `${baseUrl}/api/sessions/${B4_SESSION_ID}`,
    );
    const controlBefore = await getJson(
      contextB.request,
      `${baseUrl}/api/sessions/${controlSessionId}`,
    );

    const page = await contextB.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/generate-page") {
        const payload = route.request().postDataJSON() as GenerationCall;
        generationCalls.push({
          ...(typeof payload.source_hotspot_id === "string"
            ? { source_hotspot_id: payload.source_hotspot_id }
            : {}),
          ...(typeof payload.query === "string" ? { query: payload.query } : {}),
        });
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
          body: `data: ${JSON.stringify({ type: "error", message: "synthetic HF3 interception" })}\n\n`,
        });
        return;
      }
      if (path === "/api/errors") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      if (
        path === "/api/resolve-click" ||
        path === "/api/image-seed" ||
        path === "/api/precompute-candidates" ||
        path === "/api/animate" ||
        path.startsWith("/api/generate-page/")
      ) {
        unexpectedSemanticCalls.push(path);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ candidates: [], ok: true }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${baseUrl}/play?continue=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
    await waitForImage(page, createdNode.id);

    const overlay = page.locator('[data-testid="page-contract-overlay"]');
    await expect(overlay).toHaveAttribute("data-planned-hotspot-count", "8");
    await expect(overlay).toHaveAttribute("data-aligned-hotspot-count", "5");
    await expect(overlay).toHaveAttribute("data-visible-label-count", "8");
    await expect(overlay).toHaveAttribute("data-fallback-label-count", "3");
    await expect(page.locator('[data-hotspot-label="true"]')).toHaveCount(8);
    await expect(page.locator('[data-geometry-source="planned_fallback"]')).toHaveCount(3);

    await expect(page.locator('[data-text-role="title"] [data-source-marker]')).toHaveCount(0);
    await expect(page.locator('[data-text-role="subtitle"] [data-source-marker]')).toHaveCount(0);
    const sourcesButton = page.getByRole("button", { name: "2 個來源", exact: true });
    await expect(sourcesButton).toBeVisible();
    await sourcesButton.click();
    await expect(page.getByText("HF3 source one", { exact: true })).toBeVisible();
    await expect(page.getByText("HF3 source two", { exact: true })).toBeVisible();

    for (const [index, hotspot] of plan.hotspots.entries()) {
      await page.locator(`[data-hotspot-id="${hotspot.id}"]`).click();
      await expect.poll(() => generationCalls.length, { timeout: 15_000 }).toBe(index + 1);
      await expect(page.locator('[data-hotspot-label="true"]')).toHaveCount(8);
    }
    expect(generationCalls).toEqual(
      plan.hotspots.map((hotspot) => ({
        source_hotspot_id: hotspot.id,
        query: hotspot.sub_query,
      })),
    );
    expect(unexpectedSemanticCalls).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);

    await page.getByRole("button", { name: "歷史紀錄", exact: true }).click();
    const history = page.getByRole("dialog", { name: "工作階段歷史紀錄" });
    const deleteButton = history.locator('button[aria-label^="刪除: HF3 R1"]');
    await expect(deleteButton).toHaveCount(1);
    await expect(deleteButton).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await deleteButton.click();
    await expect(history).toBeHidden();

    const deleted = await contextB.request.get(`${baseUrl}/api/sessions/${sessionId}`);
    expect(deleted.ok()).toBe(true);
    expect((await deleted.json()).nodes).toEqual([]);
    const afterSessions = (await getJson(
      contextB.request,
      `${baseUrl}/api/sessions`,
    )) as { sessions: Array<{ session_id: string }> };
    expect(afterSessions.sessions.some((session) => session.session_id === sessionId)).toBe(false);
    expect(afterSessions.sessions.some((session) => session.session_id === B4_SESSION_ID)).toBe(true);
    expect(afterSessions.sessions.some((session) => session.session_id === controlSessionId)).toBe(true);
    expect(await getJson(contextB.request, `${baseUrl}/api/sessions/${B4_SESSION_ID}`)).toEqual(b4Before);
    expect(await getJson(contextB.request, `${baseUrl}/api/sessions/${controlSessionId}`)).toEqual(controlBefore);

    await writeFile(
      `${resultsDir}/HF3_R1_BROWSER_ACCEPTANCE.json`,
      `${JSON.stringify({
        schema: "openflipbook.hf3-r1.browser-acceptance.v1",
        pass: true,
        session_id: sessionId,
        created_node_id: createdNode.id,
        fresh_owner_backup: backupPath,
        nas_delete_status: 200,
        deleted_session_absent: true,
        b4_unchanged: true,
        control_session_id: controlSessionId,
        control_unchanged: true,
        planned_hotspots: 8,
        aligned_hotspots: 5,
        visible_labels: 8,
        fallback_labels: 3,
        direct_label_parity: generationCalls,
        provider_calls: 0,
        model_calls: 0,
        searxng_calls: 0,
        title_inline_markers: 0,
        subtitle_inline_markers: 0,
        sources_panel: true,
      }, null, 2)}\n`,
      "utf8",
    );
  } finally {
    if (created) {
      await contextA.request.delete(`${baseUrl}/api/sessions/${sessionId}`).catch(() => undefined);
    }
    await contextA.close();
    await contextB.close();
  }
});
