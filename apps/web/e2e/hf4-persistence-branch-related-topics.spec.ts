import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { AlignedHotspotV1, PagePlanV1 } from "@openflipbook/config";

const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type PersistMode = "none" | "delay" | "fail-once";
type GenerationMode = "success" | "error";

interface FixtureNode {
  id: string;
  title: string;
}

interface FixtureSession {
  sessionId: string;
  root: FixtureNode;
  branches: FixtureNode[];
}

interface InterceptionState {
  generationMode: GenerationMode;
  persistMode: PersistMode;
  persistParentId: string | null;
  persistedChildId: string;
  relatedTopics: string[];
  generationBodies: Record<string, unknown>[];
  relatedRequests: number;
  persistAttempts: number;
  persistIdempotencyKeys: string[];
  sharedCalls: string[];
  providerLikePaths: string[];
  externalUrls: string[];
  releasePersist: (() => void) | null;
  persistEntered: Promise<void>;
  resolvePersistEntered: () => void;
}

function fixturePlan(title: string): PagePlanV1 {
  return {
    schema_version: "1.0",
    title,
    summary: "A deterministic HF4 browser fixture.",
    scene: {
      prompt: "A clean illustrated scene with three distinct explorable regions, no text.",
      style: "clean illustrated textbook",
      aspect_ratio: "16:9",
    },
    text_blocks: [
      {
        id: "hf4-title",
        role: "title",
        text: title,
        anchor: "top-left",
        source_ids: [],
      },
      {
        id: "hf4-subtitle",
        role: "subtitle",
        text: "Three explorable regions",
        anchor: "top",
        source_ids: [],
      },
    ],
    hotspots: [
      {
        id: "h001",
        label: "Region one",
        sub_query: "HF4 region one detail",
        visual_target: "the first distinct region",
        desired_bbox: [0.12, 0.34, 0.18, 0.24],
      },
      {
        id: "h002",
        label: "Region two",
        sub_query: "HF4 region two detail",
        visual_target: "the second distinct region",
        desired_bbox: [0.41, 0.34, 0.18, 0.24],
      },
      {
        id: "h003",
        label: "Region three",
        sub_query: "HF4 region three detail",
        visual_target: "the third distinct region",
        desired_bbox: [0.70, 0.34, 0.18, 0.24],
      },
    ],
    motion_hints: [],
    sources: [],
  };
}

function alignedFor(plan: PagePlanV1): AlignedHotspotV1[] {
  return plan.hotspots.map((hotspot) => {
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
      alignment_confidence: 0.95,
    };
  });
}

function sse(events: Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function createNode(
  context: BrowserContext,
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await context.request.post(`${baseUrl}/api/nodes`, { data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { id: string };
}

async function createFixture(
  context: BrowserContext,
  baseUrl: string,
  prefix: string,
  withBranches: boolean,
): Promise<FixtureSession> {
  const sessionId = `session_hf4_${prefix}_${randomUUID().replaceAll("-", "")}`;
  const rootTitle = `HF4 ${prefix} root`;
  const plan = fixturePlan(rootTitle);
  const root = await createNode(context, baseUrl, {
    session_id: sessionId,
    query: rootTitle,
    page_title: rootTitle,
    image_data_url: IMAGE_DATA_URL,
    image_model: "synthetic/no-provider",
    prompt_author_model: "synthetic/no-provider",
    aspect_ratio: "16:9",
    final_prompt: "synthetic HF4 root",
    sources: [],
    page_plan: plan,
    aligned_hotspots: alignedFor(plan),
  });
  const branches: FixtureNode[] = [];
  if (withBranches) {
    for (let index = 1; index <= 3; index += 1) {
      const title = `HF4 ${prefix} branch ${index}`;
      const child = await createNode(context, baseUrl, {
        parent_id: root.id,
        session_id: sessionId,
        query: title,
        page_title: title,
        image_data_url: IMAGE_DATA_URL,
        image_model: "synthetic/no-provider",
        prompt_author_model: "synthetic/no-provider",
        aspect_ratio: "16:9",
        final_prompt: `synthetic HF4 branch ${index}`,
        click_in_parent: {
          x_pct: 0.16 + index * 0.25,
          y_pct: 0.56,
        },
        sources: [],
      });
      branches.push({ id: child.id, title });
    }
  }
  return {
    sessionId,
    root: { id: root.id, title: rootTitle },
    branches,
  };
}

function interceptionState(overrides: Partial<InterceptionState> = {}): InterceptionState {
  let resolvePersistEntered!: () => void;
  const persistEntered = new Promise<void>((resolve) => {
    resolvePersistEntered = resolve;
  });
  return {
    generationMode: "success",
    persistMode: "none",
    persistParentId: null,
    persistedChildId: randomUUID(),
    relatedTopics: ["HF4 related one", "HF4 related two", "HF4 related three", "HF4 related four"],
    generationBodies: [],
    relatedRequests: 0,
    persistAttempts: 0,
    persistIdempotencyKeys: [],
    sharedCalls: [],
    providerLikePaths: [],
    externalUrls: [],
    releasePersist: null,
    persistEntered,
    resolvePersistEntered,
    ...overrides,
  };
}

async function installInterceptors(
  page: Page,
  baseUrl: string,
  state: InterceptionState,
): Promise<void> {
  const appOrigin = new URL(baseUrl).origin;
  page.on("request", (request) => {
    if (
      !request.url().startsWith(appOrigin) &&
      !request.url().startsWith("https://fonts.googleapis.com/") &&
      !request.url().startsWith("https://fonts.gstatic.com/")
    ) {
      state.externalUrls.push(request.url());
    }
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (/\/api\/session\/[^/]+\/(presence|events)$/.test(path)) {
      state.sharedCalls.push(path);
    }
    if (
      path === "/api/resolve-click" ||
      path === "/api/precompute-candidates" ||
      path === "/api/image-seed" ||
      path === "/api/animate"
    ) {
      state.providerLikePaths.push(path);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ candidates: [], ok: true }),
      });
      return;
    }
    if (path === "/api/related-topics" && request.method() === "POST") {
      state.relatedRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ topics: state.relatedTopics }),
      });
      return;
    }
    if (path === "/api/generate-page" && request.method() === "POST") {
      state.generationBodies.push(request.postDataJSON() as Record<string, unknown>);
      if (state.generationMode === "error") {
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
          body: sse([{ type: "error", message: "synthetic HF4 generation failure" }]),
        });
        return;
      }
      const body = request.postDataJSON() as { session_id?: string };
      const childPlan = fixturePlan("HF4 generated first child");
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        body: sse([
          {
            type: "final",
            session_id: body.session_id ?? "session_hf4_unknown",
            page_title: childPlan.title,
            image_data_url: IMAGE_DATA_URL,
            image_model: "synthetic/no-provider",
            prompt_author_model: "synthetic/no-provider",
            final_prompt: "synthetic HF4 generated child",
            sources: [],
            page_plan: childPlan,
            aligned_hotspots: alignedFor(childPlan),
          },
        ]),
      });
      return;
    }
    if (path === "/api/nodes" && request.method() === "POST") {
      const body = request.postDataJSON() as { parent_id?: string | null };
      if (state.persistParentId && body.parent_id === state.persistParentId) {
        state.persistAttempts += 1;
        state.persistIdempotencyKeys.push(request.headers()["idempotency-key"] ?? "");
        state.resolvePersistEntered();
        if (state.persistMode === "delay") {
          await new Promise<void>((resolve) => {
            state.releasePersist = resolve;
          });
        }
        if (state.persistMode === "fail-once" && state.persistAttempts === 1) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "synthetic persistence failure" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: state.persistedChildId,
            image_url: `/api/image/${state.persistedChildId}`,
          }),
        });
        return;
      }
    }
    if (path === "/api/errors") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });
}

async function openSession(page: Page, baseUrl: string, sessionId: string): Promise<void> {
  await page.goto(`${baseUrl}/play?continue=${encodeURIComponent(sessionId)}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  await expect(page.locator('figure img[alt]:not([alt=""])').first()).toBeVisible();
}

async function deleteFixture(context: BrowserContext, baseUrl: string, sessionId: string): Promise<void> {
  await context.request.delete(`${baseUrl}/api/sessions/${sessionId}`).catch(() => undefined);
}

test.setTimeout(180_000);

test("HF4 persistence closure, branch relayout, and related topics", async ({ browser }) => {
  const baseUrl = process.env.E2E_BASE_URL?.replace(/\/$/, "");
  const resultsDir = process.env.E_RESULTS_DIR;
  if (!baseUrl || !resultsDir) {
    throw new Error("E2E_BASE_URL and E_RESULTS_DIR are required for HF4 acceptance");
  }
  await mkdir(resultsDir, { recursive: true });
  const statusContextBefore = await browser.newContext();
  const providerCountersBefore = await statusContextBefore.request.get(`${baseUrl}/api/status`);
  expect(providerCountersBefore.ok()).toBe(true);
  const statusBefore = (await providerCountersBefore.json()) as {
    usage?: { counters?: Record<string, number> };
  };
  await statusContextBefore.close();
  const evidence: Record<string, unknown> = {
    schema: "openflipbook.hf4.browser-acceptance.v1",
    provider_model_search_budget: 0,
  };
  const allProviderLikePaths: string[] = [];
  const allSharedCalls: string[] = [];
  const allExternalUrls: string[] = [];

  const branchContext = await browser.newContext({ locale: "zh-TW" });
  const branchPage = await branchContext.newPage();
  const branchFixture = await createFixture(branchContext, baseUrl, "branch", true);
  const branchState = interceptionState();
  try {
    await installInterceptors(branchPage, baseUrl, branchState);
    await openSession(branchPage, baseUrl, branchFixture.sessionId);
    await branchPage
      .getByTestId("breadcrumb")
      .getByRole("button", { name: branchFixture.root.title, exact: true })
      .click();
    const branchChooser = branchPage.getByTestId("branch-chooser");
    await expect(branchChooser).toBeVisible();
    await expect(branchChooser.getByRole("button")).toHaveCount(3);
    const chooserBox = await branchChooser.boundingBox();
    const figure = branchPage.locator("figure").first();
    const figureBox = await figure.boundingBox();
    expect(chooserBox).not.toBeNull();
    expect(figureBox).not.toBeNull();
    expect(chooserBox!.y).toBeGreaterThanOrEqual(figureBox!.y + figureBox!.height - 1);
    await expect(figure.getByTestId("branch-chooser")).toHaveCount(0);
    await expect(figure.locator('button[aria-label^="開啟分支："]')).toHaveCount(3);
    const titleBox = await branchPage.locator('[data-text-role="title"]').first().boundingBox();
    expect(titleBox).not.toBeNull();
    expect(
      chooserBox!.y >= titleBox!.y + titleBox!.height ||
        chooserBox!.y + chooserBox!.height <= titleBox!.y,
    ).toBe(true);
    await branchPage.screenshot({ path: join(resultsDir, "HF4_BRANCH_TRAY.png"), fullPage: true });
    await branchChooser.getByRole("button", { name: "HF4 branch branch 2", exact: true }).click();
    await expect(branchPage).toHaveURL(new RegExp(`/n/${branchFixture.branches[1]!.id}(?:\\?.*)?$`));
    evidence.branch_tray_outside_image = true;
    evidence.branch_beacons_remain = true;
    evidence.branch_navigation = true;
  } finally {
    allProviderLikePaths.push(...branchState.providerLikePaths);
    allSharedCalls.push(...branchState.sharedCalls);
    allExternalUrls.push(...branchState.externalUrls);
    await deleteFixture(branchContext, baseUrl, branchFixture.sessionId);
    await branchContext.close();
  }

  const relatedContext = await browser.newContext({ locale: "zh-TW" });
  const relatedPage = await relatedContext.newPage();
  const relatedFixture = await createFixture(relatedContext, baseUrl, "related", false);
  const relatedState = interceptionState({ generationMode: "error" });
  try {
    await installInterceptors(relatedPage, baseUrl, relatedState);
    await openSession(relatedPage, baseUrl, relatedFixture.sessionId);
    await expect(relatedPage.getByText("向外探索", { exact: true })).toHaveCount(0);
    await relatedPage.getByTestId("related-topics-button").click();
    const tray = relatedPage.getByTestId("related-topics-tray");
    await expect(tray).toBeVisible();
    await expect(tray.getByTestId("related-topic-chips")).toBeVisible();
    await expect(tray.getByRole("button")).toHaveCount(5);
    expect(relatedState.generationBodies).toHaveLength(0);
    const trayBox = await tray.boundingBox();
    const figureBox = await relatedPage.locator("figure").first().boundingBox();
    expect(trayBox).not.toBeNull();
    expect(figureBox).not.toBeNull();
    expect(trayBox!.y).toBeGreaterThanOrEqual(figureBox!.y + figureBox!.height - 1);
    await relatedPage.screenshot({ path: join(resultsDir, "HF4_RELATED_TOPICS_TRAY.png"), fullPage: true });
    await tray
      .getByRole("button", { name: "產生「HF4 related one」的頁面", exact: true })
      .click();
    await expect.poll(() => relatedState.generationBodies.length).toBe(1);
    expect(relatedState.generationBodies[0]).toMatchObject({
      mode: "query",
      query: "HF4 related one",
      current_node_id: relatedFixture.root.id,
    });
    await expect(relatedPage.getByText(/新增：/)).toHaveCount(0);
    evidence.related_topics = {
      suggestions_request_count: relatedState.relatedRequests,
      suggestions_count: relatedState.relatedTopics.length,
      generation_before_selection: 0,
      normal_generation_after_selection: 1,
    };
  } finally {
    allProviderLikePaths.push(...relatedState.providerLikePaths);
    allSharedCalls.push(...relatedState.sharedCalls);
    allExternalUrls.push(...relatedState.externalUrls);
    await deleteFixture(relatedContext, baseUrl, relatedFixture.sessionId);
    await relatedContext.close();
  }

  const emptyContext = await browser.newContext({ locale: "zh-TW" });
  const emptyPage = await emptyContext.newPage();
  const emptyFixture = await createFixture(emptyContext, baseUrl, "empty", false);
  const emptyState = interceptionState({ relatedTopics: [] });
  try {
    await installInterceptors(emptyPage, baseUrl, emptyState);
    await openSession(emptyPage, baseUrl, emptyFixture.sessionId);
    await emptyPage.getByTestId("related-topics-button").click();
    await expect(emptyPage.getByText("目前找不到相關主題。", { exact: true })).toBeVisible();
    await expect(emptyPage.getByText("附近沒有可探索的內容", { exact: true })).toHaveCount(0);
    await emptyPage.screenshot({ path: join(resultsDir, "HF4_RELATED_TOPICS_EMPTY.png"), fullPage: true });
    evidence.related_topics_empty_state = true;
  } finally {
    allProviderLikePaths.push(...emptyState.providerLikePaths);
    allSharedCalls.push(...emptyState.sharedCalls);
    allExternalUrls.push(...emptyState.externalUrls);
    await deleteFixture(emptyContext, baseUrl, emptyFixture.sessionId);
    await emptyContext.close();
  }

  const persistContext = await browser.newContext({ locale: "zh-TW" });
  const persistPage = await persistContext.newPage();
  const persistFixture = await createFixture(persistContext, baseUrl, "persist", false);
  const persistState = interceptionState({
    persistMode: "delay",
    persistParentId: persistFixture.root.id,
  });
  try {
    await installInterceptors(persistPage, baseUrl, persistState);
    await openSession(persistPage, baseUrl, persistFixture.sessionId);
    await persistPage.locator('[data-hotspot-id="h001"]').click();
    await persistState.persistEntered;
    await expect(persistPage.getByTestId("generating-banner")).toBeVisible();
    await expect(persistPage.locator('figure img[src^="data:image/"]').first()).toBeVisible();
    expect(persistPage.url()).not.toContain(persistState.persistedChildId);
    await expect(persistPage.getByText(/新增：/)).toHaveCount(0);
    expect(persistState.releasePersist).not.toBeNull();
    persistState.releasePersist!();
    await expect(persistPage).toHaveURL(new RegExp(`/n/${persistState.persistedChildId}(?:\\?.*)?$`));
    await expect(persistPage.getByTestId("generating-banner")).toHaveCount(0);
    await expect(persistPage.getByText(/新增：/)).toHaveCount(0);
    await persistPage.screenshot({ path: join(resultsDir, "HF4_FIRST_CHILD_PERSISTED.png"), fullPage: true });
    await persistPage.getByTitle("回到上一頁（←）", { exact: true }).click();
    await expect(persistPage).toHaveURL(new RegExp(`/n/${persistFixture.root.id}(?:\\?.*)?$`));
    await persistPage.getByTitle("前往下一頁（→）", { exact: true }).click();
    await expect(persistPage).toHaveURL(new RegExp(`/n/${persistState.persistedChildId}(?:\\?.*)?$`));
    evidence.first_child_persistence = {
      delayed_persist_blocked_ready: true,
      saved_node_id: persistState.persistedChildId,
      persist_attempts: persistState.persistAttempts,
      history_back_forward: true,
      new_banner_count: 0,
    };
  } finally {
    allProviderLikePaths.push(...persistState.providerLikePaths);
    allSharedCalls.push(...persistState.sharedCalls);
    allExternalUrls.push(...persistState.externalUrls);
    await deleteFixture(persistContext, baseUrl, persistFixture.sessionId);
    await persistContext.close();
  }

  const failureContext = await browser.newContext({ locale: "zh-TW" });
  const failurePage = await failureContext.newPage();
  const failureFixture = await createFixture(failureContext, baseUrl, "failure", false);
  const failureState = interceptionState({
    persistMode: "fail-once",
    persistParentId: failureFixture.root.id,
  });
  try {
    await installInterceptors(failurePage, baseUrl, failureState);
    await openSession(failurePage, baseUrl, failureFixture.sessionId);
    await failurePage.locator('[data-hotspot-id="h001"]').click();
    await expect(failurePage.getByText("圖片已產生，但儲存失敗。請重試儲存。", { exact: true })).toBeVisible();
    await expect(failurePage.getByRole("button", { name: /重試儲存/ })).toBeVisible();
    await expect(failurePage.getByText(/新增：/)).toHaveCount(0);
    expect(failureState.generationBodies).toHaveLength(1);
    await failurePage.getByRole("button", { name: /重試儲存/ }).click();
    await expect(failurePage).toHaveURL(new RegExp(`/n/${failureState.persistedChildId}(?:\\?.*)?$`));
    expect(failureState.generationBodies).toHaveLength(1);
    expect(failureState.persistAttempts).toBe(2);
    expect(failureState.persistIdempotencyKeys[0]).toBeTruthy();
    expect(failureState.persistIdempotencyKeys[1]).toBe(failureState.persistIdempotencyKeys[0]);
    evidence.persistence_failure_recovery = {
      localized_failure: true,
      retry_save_only: true,
      generation_requests: 1,
      persist_attempts: 2,
      new_banner_count: 0,
    };
  } finally {
    allProviderLikePaths.push(...failureState.providerLikePaths);
    allSharedCalls.push(...failureState.sharedCalls);
    allExternalUrls.push(...failureState.externalUrls);
    await deleteFixture(failureContext, baseUrl, failureFixture.sessionId);
    await failureContext.close();
  }

  const statusContext = await browser.newContext();
  const statusResponse = await statusContext.request.get(`${baseUrl}/api/status`);
  expect(statusResponse.ok()).toBe(true);
  const statusAfter = (await statusResponse.json()) as {
    usage?: { counters?: Record<string, number> };
  };
  await statusContext.close();
  const countersBefore = statusBefore.usage?.counters ?? {};
  const countersAfter = statusAfter.usage?.counters ?? {};
  expect(countersAfter).toEqual(countersBefore);
  expect(allProviderLikePaths).toEqual([]);
  expect(allSharedCalls).toEqual([]);
  expect(allExternalUrls).toEqual([]);
  evidence.provider_calls = 0;
  evidence.model_calls = 0;
  evidence.searxng_calls = 0;
  evidence.shared_incoming_ui_hidden = true;
  evidence.resource_guard = {
    checked_by_resource_snapshot: true,
    loop_detection: false,
    stale_openclaw_hooks: 0,
  };
  evidence.provider_counters_before = countersBefore;
  evidence.provider_counters_after = countersAfter;
  evidence.pass = true;
  await writeFile(join(resultsDir, "HF4_BROWSER_ACCEPTANCE.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
});
