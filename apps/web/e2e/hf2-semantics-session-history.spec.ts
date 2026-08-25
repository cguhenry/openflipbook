import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

test.skip(
  !process.env.HF2_BROWSER_ACCEPTANCE,
  "HF2_BROWSER_ACCEPTANCE=1 is required for the serial NAS acceptance",
);
test.describe.configure({ mode: "serial" });

const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const OLD_SESSION_ID = "session_hf2_history_old";

const HOTSPOTS = [
  {
    id: "h001",
    label: "細胞核",
    sub_query: "細胞核的結構與功能",
    visual_target: "large purple nucleus at center",
    desired_bbox: [0.35, 0.28, 0.28, 0.38],
  },
  {
    id: "h002",
    label: "粒線體",
    sub_query: "粒線體如何產生 ATP",
    visual_target: "orange bean-shaped mitochondrion at upper left",
    desired_bbox: [0.22, 0.1, 0.14, 0.12],
  },
  {
    id: "h003",
    label: "高基氏體",
    sub_query: "高基氏體如何加工與運送蛋白質",
    visual_target: "pink stacked Golgi apparatus at lower right",
    desired_bbox: [0.6, 0.58, 0.18, 0.18],
  },
  {
    id: "h004",
    label: "粗糙內質網",
    sub_query: "粗糙內質網與蛋白質合成",
    visual_target: "blue folded rough ER left of nucleus",
    desired_bbox: [0.2, 0.3, 0.18, 0.24],
  },
  {
    id: "h005",
    label: "中心粒",
    sub_query: "中心粒在細胞分裂中的功能",
    visual_target: "yellow paired centrioles below nucleus",
    desired_bbox: [0.47, 0.68, 0.12, 0.15],
  },
  {
    id: "h006",
    label: "細胞膜",
    sub_query: "細胞膜如何控制物質進出",
    visual_target: "outer boundary membrane of the cell",
    desired_bbox: [0.1, 0.08, 0.8, 0.82],
  },
] as const;

const PAGE_PLAN = {
  schema_version: "1.0",
  title: "動物細胞結構",
  summary: "HF2 semantic fixture",
  scene: {
    prompt: "Animal cell illustration with no text and no labels",
    style: "clean illustrated textbook",
    aspect_ratio: "16:9",
  },
  text_blocks: [],
  hotspots: HOTSPOTS,
  motion_hints: [],
  sources: [],
};

const ALIGNED_HOTSPOTS = HOTSPOTS.map((hotspot, index) => {
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
    alignment_confidence: index === 5 ? 0.8 : 0.9 + index / 100,
  };
});

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function finalEvent(sessionId: string) {
  return {
    type: "final",
    image_data_url: IMAGE_DATA_URL,
    page_title: PAGE_PLAN.title,
    image_model: "hf2-intercepted",
    prompt_author_model: "hf2-browser-fixture",
    session_id: sessionId,
    final_prompt: "HF2 intercepted browser proof",
    sources: [],
    page_plan: PAGE_PLAN,
    aligned_hotspots: ALIGNED_HOTSPOTS,
  };
}

async function clickImageFraction(page: Page, xPct: number, yPct: number) {
  const point = await page.locator("figure img").first().evaluate(
    (element, fractions) => {
      const image = element as HTMLImageElement;
      const rect = image.getBoundingClientRect();
      const imageAspect = image.naturalWidth / image.naturalHeight;
      const boxAspect = rect.width / rect.height;
      const contentWidth = boxAspect > imageAspect ? rect.height * imageAspect : rect.width;
      const contentHeight = boxAspect > imageAspect ? rect.height : rect.width / imageAspect;
      const offsetX = (rect.width - contentWidth) / 2;
      const offsetY = (rect.height - contentHeight) / 2;
      return {
        x: rect.left + offsetX + fractions.x * contentWidth,
        y: rect.top + offsetY + fractions.y * contentHeight,
      };
    },
    { x: xPct, y: yPct },
  );
  await page.mouse.click(point.x, point.y);
}

function counterDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries(
    [...keys].sort().map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]),
  );
}

async function readStatus(page: Page, baseUrl: string) {
  let response = await page.request.get(`${baseUrl}/api/status`);
  for (let attempt = 0; !response.ok() && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    response = await page.request.get(`${baseUrl}/api/status`);
  }
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    usage?: { counters?: Record<string, number> };
    mongo_connected?: boolean;
    minio_connected?: boolean;
  };
}

test("HF2 semantics, fresh-root toolbar, and exact-session history deletion", async ({
  browser,
  baseURL,
}) => {
  const baseUrl = (baseURL ?? "http://localhost:3000").replace(/\/$/, "");
  const resultsDir = process.env.E_RESULTS_DIR;
  if (!resultsDir) throw new Error("E_RESULTS_DIR is required for HF2 acceptance");
  await mkdir(resultsDir, { recursive: true });

  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  const generationBodies: Record<string, unknown>[] = [];
  const tapBodies: Record<string, unknown>[] = [];
  const queryBodies: Record<string, unknown>[] = [];
  let rootDelivered = false;

  await page.route("**/api/generate-page", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    generationBodies.push(body);
    if (body.mode === "tap") {
      tapBodies.push(body);
      await route.fulfill({ status: 500, body: "HF2 intercepted generation failure" });
      return;
    }
    if (body.mode === "query") {
      queryBodies.push(body);
      if (!rootDelivered) {
        rootDelivered = true;
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: sse(finalEvent(String(body.session_id))),
        });
      } else {
        await route.fulfill({ status: 500, body: "HF2 intercepted fresh-root failure" });
      }
      return;
    }
    await route.fulfill({ status: 500, body: "unexpected HF2 generation mode" });
  });
  await page.route("**/api/nodes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "hf2-browser-root-node",
        image_url: "/api/image/hf2-browser-root-node",
        created_at: new Date().toISOString(),
      }),
    });
  });
  await page.route("**/api/errors", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== "/api/sessions") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [{
          session_id: OLD_SESSION_ID,
          title: "HF2 history root",
          node_count: 1,
          branch_count: 0,
          updated_at: "2026-08-25T00:00:00Z",
          has_image_seed: false,
        }],
      }),
    });
  });
  let oldSessionReads = 0;
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.endsWith(`/${OLD_SESSION_ID}`)) return route.fallback();
    oldSessionReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session_id: OLD_SESSION_ID,
        next_cursor: null,
        nodes: [{
          id: "hf2-old-node",
          parent_id: null,
          session_id: OLD_SESSION_ID,
          query: "old history topic",
          page_title: "HF2 old history page",
          image_url: IMAGE_DATA_URL,
          browser_image_url: IMAGE_DATA_URL,
          click_in_parent: null,
          sources: [],
          relation: "descend",
          page_plan: null,
          aligned_hotspots: null,
          seed_type: null,
        }],
      }),
    });
  });

  const statusBefore = await readStatus(page, baseUrl);
  await page.goto(`${baseUrl}/play`, { waitUntil: "domcontentloaded" });
  const query = page.getByRole("textbox").first();
  await query.fill("HF2 animal cell root");
  await page.getByRole("button", { name: /產生|Go/ }).click();
  await expect(page.locator('[data-hotspot-label="true"]')).toHaveCount(6);
  const labels = page.locator('[data-hotspot-label="true"]');
  for (let index = 0; index < HOTSPOTS.length; index += 1) {
    const hotspot = HOTSPOTS[index]!;
    const label = page.locator(
      `[data-hotspot-label="true"][data-hotspot-id="${hotspot.id}"]`,
    );
    await expect(label).toBeVisible();
    expect((await label.innerText()).trim()).toBe(hotspot.label);
    await label.click();
    await expect.poll(() => tapBodies.length).toBe(index + 1);
    expect(tapBodies[index]).toMatchObject({
      mode: "tap",
      source_hotspot_id: hotspot.id,
      query: hotspot.sub_query,
    });
    await page.waitForTimeout(120);
  }
  expect(await labels.evaluateAll((nodes) => nodes.every((node) => node.textContent?.trim()))).toBe(true);
  await page.screenshot({ path: join(resultsDir, "HF2_LABELS.png"), fullPage: true });

  await clickImageFraction(page, 0.69, 0.67);
  await expect.poll(() => tapBodies.length).toBe(7);
  expect(tapBodies[6]).toMatchObject({
    source_hotspot_id: "h003",
    query: "高基氏體如何加工與運送蛋白質",
  });
  await page.waitForTimeout(120);
  await clickImageFraction(page, 0.49, 0.47);
  await expect.poll(() => tapBodies.length).toBe(8);
  expect(tapBodies[7]).toMatchObject({
    source_hotspot_id: "h001",
    query: "細胞核的結構與功能",
  });

  const rootSessionId = String(queryBodies[0]?.session_id);
  await query.fill("HF2 toolbar fresh topic");
  await page.getByRole("button", { name: /產生|Go/ }).click();
  await expect.poll(() => queryBodies.length).toBe(2);
  const toolbarBody = queryBodies[1]!;
  expect(toolbarBody.mode).toBe("query");
  expect(toolbarBody.current_node_id).toBe("");
  expect(toolbarBody.session_id).not.toBe(rootSessionId);
  expect(toolbarBody.session_id).not.toBe(OLD_SESSION_ID);
  expect(toolbarBody).not.toHaveProperty("image");
  expect(toolbarBody).not.toHaveProperty("parent_query");
  expect(toolbarBody).not.toHaveProperty("parent_title");
  expect(toolbarBody).not.toHaveProperty("condition_image_urls");

  await page.getByRole("button", { name: "歷史紀錄" }).click();
  await page.locator("li").filter({ hasText: "HF2 history root" }).getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`continue=${OLD_SESSION_ID}$`));
  await expect(page.locator("figure img").first()).toBeVisible();
  expect(oldSessionReads).toBe(1);
  const resumedQuery = page.getByRole("textbox").first();
  await resumedQuery.fill("HF2 new topic after resume");
  await page.getByRole("button", { name: /產生|Go/ }).click();
  await expect.poll(() => queryBodies.length).toBe(3);
  const resumedToolbarBody = queryBodies[2]!;
  expect(resumedToolbarBody.current_node_id).toBe("");
  expect(resumedToolbarBody.session_id).not.toBe(OLD_SESSION_ID);
  expect(resumedToolbarBody).not.toHaveProperty("image");
  expect(resumedToolbarBody).not.toHaveProperty("condition_image_urls");
  expect(oldSessionReads).toBe(1);

  await page.screenshot({ path: join(resultsDir, "HF2_RESUME_STATE.png"), fullPage: true });
  await page.close();

  const deletePage = await browser.newPage();
  deletePage.setDefaultTimeout(60_000);
  let temporarySessionId: string | null = null;
  let deleteResponsePayload: Record<string, unknown> | null = null;
  deletePage.on("response", async (response) => {
    if (!temporarySessionId || !response.url().endsWith(`/api/sessions/${temporarySessionId}`)) return;
    if (response.request().method() !== "DELETE") return;
    try {
      deleteResponsePayload = (await response.json()) as Record<string, unknown>;
    } catch {
      deleteResponsePayload = null;
    }
  });
  try {
    const temporaryTitle = "HF2 temporary delete session";
    temporarySessionId = `session_hf2_delete_${Date.now().toString(36)}`;
    let parentId: string | null = null;
    for (let index = 0; index < 3; index += 1) {
      const response = await deletePage.request.post(`${baseUrl}/api/nodes`, {
        data: {
          parent_id: parentId,
          session_id: temporarySessionId,
          query: `${temporaryTitle} page ${index + 1}`,
          page_title: index === 0 ? temporaryTitle : `${temporaryTitle} ${index + 1}`,
          image_data_url: IMAGE_DATA_URL,
          image_model: "hf2-browser-fixture",
          prompt_author_model: "hf2-browser-fixture",
          aspect_ratio: "16:9",
          final_prompt: "HF2 delete acceptance fixture",
          sources: [],
          relation: "descend",
          page_plan: null,
          aligned_hotspots: null,
        },
      });
      expect(response.ok()).toBe(true);
      const payload = (await response.json()) as { id: string };
      parentId = payload.id;
    }

    const b4BeforeResponse = await deletePage.request.get(
      `${baseUrl}/api/sessions/session_b3_live_8ce2bf1163044e9f92c878345dbbfec6`,
    );
    expect(b4BeforeResponse.ok()).toBe(true);
    const b4Before = await b4BeforeResponse.json();
    const backup = await deletePage.request.get(`${baseUrl}/api/backup/owner`);
    expect(backup.ok()).toBe(true);
    expect(backup.headers()["content-type"]).toContain("application/zip");
    await writeFile(join(resultsDir, "HF2_OWNER_BACKUP_BEFORE_DELETE.zip"), await backup.body());

    const sessionsBeforeResponse = await deletePage.request.get(`${baseUrl}/api/sessions`);
    expect(sessionsBeforeResponse.ok()).toBe(true);
    const sessionsBefore = (await sessionsBeforeResponse.json()) as {
      sessions: { session_id: string }[];
    };
    expect(sessionsBefore.sessions.some((row) => row.session_id === temporarySessionId)).toBe(true);

    await deletePage.goto(`${baseUrl}/play`, { waitUntil: "domcontentloaded" });
    await deletePage.locator('button[aria-controls="session-history-panel"]').click();
    const deleteButton = deletePage.locator(
      `button[aria-label="刪除: ${temporaryTitle}"]`,
    );
    await expect(deleteButton).toBeVisible();
    let confirmationMessage = "";
    deletePage.once("dialog", async (dialog) => {
      confirmationMessage = dialog.message();
      await dialog.accept();
    });
    await deleteButton.click();
    await expect(deleteButton).toHaveCount(0);
    expect(confirmationMessage).toContain(temporaryTitle);
    await expect.poll(() => deleteResponsePayload).not.toBeNull();
    expect(deleteResponsePayload).toMatchObject({
      deleted_session_id: temporarySessionId,
      deleted_nodes: 3,
      image_cleanup_failed: false,
    });

    const deletedSession = await deletePage.request.get(
      `${baseUrl}/api/sessions/${encodeURIComponent(temporarySessionId)}`,
    );
    expect(deletedSession.ok()).toBe(true);
    expect(((await deletedSession.json()) as { nodes: unknown[] }).nodes).toHaveLength(0);

    const sessionsAfterResponse = await deletePage.request.get(`${baseUrl}/api/sessions`);
    expect(sessionsAfterResponse.ok()).toBe(true);
    const sessionsAfter = (await sessionsAfterResponse.json()) as {
      sessions: { session_id: string }[];
    };
    const beforeIds = sessionsBefore.sessions.map((row) => row.session_id).filter((id) => id !== temporarySessionId).sort();
    const afterIds = sessionsAfter.sessions.map((row) => row.session_id).sort();
    expect(afterIds).toEqual(beforeIds);
    expect(afterIds).toContain("session_b3_live_8ce2bf1163044e9f92c878345dbbfec6");

    const b4AfterResponse = await deletePage.request.get(
      `${baseUrl}/api/sessions/session_b3_live_8ce2bf1163044e9f92c878345dbbfec6`,
    );
    expect(b4AfterResponse.ok()).toBe(true);
    expect(await b4AfterResponse.json()).toEqual(b4Before);
  } finally {
    if (temporarySessionId) {
      await deletePage.request.delete(`${baseUrl}/api/sessions/${temporarySessionId}`).catch(() => undefined);
    }
    await deletePage.close();
  }

  const statusPage = await browser.newPage();
  const statusAfter = await readStatus(statusPage, baseUrl);
  await statusPage.close();
  const providerSearchDelta = counterDelta(
    statusBefore.usage?.counters ?? {},
    statusAfter.usage?.counters ?? {},
  );
  expect(providerSearchDelta).toEqual({
    alignment_calls: 0,
    generation_cancelled: 0,
    generation_failed: 0,
    generation_requests: 0,
    generation_success: 0,
    image_calls: 0,
    planner_calls: 0,
    searxng_searches: 0,
  });
  await writeFile(
    join(resultsDir, "HF2_BROWSER_PROOF.json"),
    JSON.stringify(
      {
        hf2_browser_acceptance: true,
        visible_non_empty_hotspot_labels: HOTSPOTS.map(({ id, label }) => ({ id, label })),
        label_clicks: tapBodies.slice(0, 6).map((body) => ({
          source_hotspot_id: body.source_hotspot_id,
          query: body.query,
        })),
        coordinate_clicks: tapBodies.slice(6, 8).map((body) => ({
          source_hotspot_id: body.source_hotspot_id,
          query: body.query,
        })),
        first_failure_then_second_dispatch: tapBodies.length >= 2,
        resumed_old_session_id: OLD_SESSION_ID,
        fresh_root_requests: [toolbarBody, resumedToolbarBody],
        deleted_session_id: temporarySessionId,
        deleted_nodes: 3,
        b4_unchanged: true,
        provider_search_counter_delta: providerSearchDelta,
        generation_interception: {
          intercepted_generation_requests: generationBodies.length,
          provider_model_search_budget: 0,
        },
      },
      null,
      2,
    ),
  );
});
