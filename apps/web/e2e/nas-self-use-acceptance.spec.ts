import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

const SESSION_ID = "session_b3_live_8ce2bf1163044e9f92c878345dbbfec6";
const NODE_TRAIL = [
  "2c3cfd01-e5be-410d-8c0a-037247ba5a85",
  "67c762f9-e992-47a3-a4e6-80583f56d3a2",
  "453abed9-e09c-4282-b33e-39dd0b05ff85",
  "a03d8767-3048-4b15-963c-90aa7716b531",
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet_portrait", width: 768, height: 1024 },
  { name: "phone_portrait", width: 375, height: 812 },
  { name: "phone_landscape", width: 812, height: 375 },
] as const;

const GENERATION_PATHS = new Set([
  "/api/animate",
  "/api/generate-page",
  "/api/image-seed",
  "/api/precompute-candidates",
  "/api/resolve-click",
]);

interface Diagnostics {
  console_errors: string[];
  page_errors: string[];
  expected_abort_requests: Array<{ url: string; error: string | null }>;
  failed_requests: Array<{ url: string; error: string | null }>;
  failed_app_responses: Array<{ url: string; status: number }>;
  generation_endpoint_requests: Array<{ method: string; url: string }>;
}

interface RuntimeStatus {
  usage?: { counters?: Record<string, number> };
  mongo_connected?: boolean;
  minio_connected?: boolean;
}

interface SessionNode {
  id: string;
  image_url: string;
  browser_image_url: string;
}

interface SessionPayload {
  nodes: SessionNode[];
}

function diagnostics(): Diagnostics {
  return {
    console_errors: [],
    page_errors: [],
    expected_abort_requests: [],
    failed_requests: [],
    failed_app_responses: [],
    generation_endpoint_requests: [],
  };
}

function monitor(page: Page, appOrigin: string, result: Diagnostics): void {
  page.on("console", (message) => {
    if (message.type() === "error") result.console_errors.push(message.text());
  });
  page.on("pageerror", (error) => result.page_errors.push(String(error)));
  page.on("requestfailed", (request: Request) => {
    const failure = {
      url: request.url(),
      error: request.failure()?.errorText ?? null,
    };
    const path = new URL(request.url()).pathname;
    const expectedAbort =
      failure.error === "net::ERR_ABORTED" &&
      (/^\/api\/session\/[^/]+\/events$/.test(path) ||
        path.startsWith("/api/export/offline/"));
    (expectedAbort ? result.expected_abort_requests : result.failed_requests).push(failure);
  });
  page.on("response", (response: Response) => {
    if (response.url().startsWith(appOrigin) && response.status() >= 400) {
      result.failed_app_responses.push({
        url: response.url(),
        status: response.status(),
      });
    }
  });
  page.on("request", (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (GENERATION_PATHS.has(path)) {
      result.generation_endpoint_requests.push({
        method: request.method(),
        url: request.url(),
      });
    }
  });
}

async function targetMeasurement(name: string, locator: Locator) {
  await expect(locator, `${name} must be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name} must have a browser layout box`).not.toBeNull();
  expect(box!.height, `${name} must retain a practical 44px target`).toBeGreaterThanOrEqual(43.5);
  return { name, ...box! };
}

async function runtimeStatus(page: Page, baseUrl: string): Promise<RuntimeStatus> {
  const response = await page.context().request.get(`${baseUrl}/api/status`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as RuntimeStatus;
}

function counters(status: RuntimeStatus): Record<string, number> {
  return { ...(status.usage?.counters ?? {}) };
}

async function sessionState(page: Page, baseUrl: string): Promise<SessionPayload> {
  const response = await page.context().request.get(
    `${baseUrl}/api/sessions/${encodeURIComponent(SESSION_ID)}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as SessionPayload;
}

async function waitForNodeImage(page: Page, nodeId: string) {
  const image = page.locator('figure img[alt]:not([alt=""])').first();
  await expect(image).toHaveAttribute("src", `/api/image/${nodeId}`);
  await page.waitForFunction(
    (expectedNodeId) => {
      const element = document.querySelector(
        'figure img[alt]:not([alt=""])',
      );
      return (
        element instanceof HTMLImageElement &&
        element.getAttribute("src") === `/api/image/${expectedNodeId}` &&
        element.complete &&
        element.naturalWidth > 0 &&
        element.naturalHeight > 0
      );
    },
    nodeId,
  );
  return image;
}

async function dragSelectDomText(page: Page) {
  const text = page.locator("[data-text-block-id] > span").first();
  await expect(text).toBeVisible();
  const textRect = await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = Array.from(range.getClientRects()).find(
      (candidate) => candidate.width > 8 && candidate.height > 0,
    );
    return rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null;
  });
  expect(textRect).not.toBeNull();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(textRect!.x + 2, textRect!.y + textRect!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    textRect!.x + textRect!.width - 2,
    textRect!.y + textRect!.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString().trim() ?? "");
  expect(selected.length).toBeGreaterThan(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  return {
    selected_text: selected,
    pointer_events: await text.evaluate((element) => getComputedStyle(element).pointerEvents),
    user_select: await text.evaluate((element) => getComputedStyle(element).userSelect),
  };
}

test.setTimeout(600_000);

test("canonical NAS self-use acceptance uses persisted B4 data only", async ({ browser }) => {
  const configuredBaseUrl = process.env.E2E_BASE_URL;
  const resultsDir = process.env.E_RESULTS_DIR;
  if (!configuredBaseUrl || !resultsDir) {
    throw new Error("E2E_BASE_URL and E_RESULTS_DIR are required for E acceptance");
  }
  const baseUrl = configuredBaseUrl.replace(/\/$/, "");
  const appOrigin = new URL(baseUrl).origin;
  await mkdir(resultsDir, { recursive: true });

  const viewportResults: Record<string, unknown>[] = [];
  let offlineExport: Record<string, unknown> | null = null;

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      acceptDownloads: true,
    });
    try {
    const observed = diagnostics();
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.setDefaultNavigationTimeout(60_000);
    monitor(page, appOrigin, observed);

    const statusBefore = await runtimeStatus(page, baseUrl);

    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(`${baseUrl}/play`);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");

    const query = page.getByRole("textbox").first();
    const upload = page.getByRole("button", { name: "⬆ 上傳", exact: true });
    const generate = page.getByRole("button", { name: "產生", exact: true });
    const history = page.getByRole("button", { name: "歷史紀錄", exact: true });
    const settings = page.getByRole("button", { name: "設定", exact: true });
    const primaryTargets = [];
    primaryTargets.push(await targetMeasurement("query", query));
    primaryTargets.push(await targetMeasurement("upload", upload));
    primaryTargets.push(await targetMeasurement("generate", generate));
    primaryTargets.push(await targetMeasurement("history", history));
    primaryTargets.push(await targetMeasurement("settings", settings));

    const initialOverflow = await page.evaluate(() => ({
      document_scroll_width: document.documentElement.scrollWidth,
      document_client_width: document.documentElement.clientWidth,
      body_scroll_width: document.body.scrollWidth,
      pass:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 &&
        document.body.scrollWidth <= document.documentElement.clientWidth + 1,
    }));
    expect(initialOverflow.pass).toBe(true);

    await settings.click();
    let settingsDialog = page.getByRole("dialog", { name: "設定 / 執行狀態" });
    await expect(settingsDialog).toBeVisible();
    const settingsTargets = [];
    settingsTargets.push(
      await targetMeasurement("settings UI language", settingsDialog.getByLabel("介面語言")),
    );
    settingsTargets.push(
      await targetMeasurement("settings output language", settingsDialog.getByLabel("輸出語言")),
    );
    settingsTargets.push(
      await targetMeasurement("settings close", settingsDialog.getByLabel("關閉設定")),
    );
    const outputBefore = await settingsDialog.getByLabel("輸出語言").inputValue();
    await settingsDialog.getByLabel("介面語言").selectOption("en");
    settingsDialog = page.getByRole("dialog", { name: "Settings / Runtime" });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(settingsDialog.getByLabel("Output language")).toHaveValue(outputBefore);
    const motion = settingsDialog.getByRole("checkbox", { name: /Always reduce motion/ });
    await motion.check();
    await expect(motion).toBeChecked();
    await motion.uncheck();
    await expect(motion).not.toBeChecked();
    await settingsDialog.getByLabel("UI language").selectOption("zh-TW");
    settingsDialog = page.getByRole("dialog", { name: "設定 / 執行狀態" });
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
    await expect(settingsDialog.getByLabel("輸出語言")).toHaveValue(outputBefore);
    await settingsDialog.getByLabel("關閉設定").click();
    await expect(settingsDialog).toBeHidden();

    const statusPage = await context.newPage();
    statusPage.setDefaultTimeout(60_000);
    statusPage.setDefaultNavigationTimeout(60_000);
    monitor(statusPage, appOrigin, observed);
    await statusPage.goto(`${baseUrl}/status`, { waitUntil: "domcontentloaded" });
    await expect(statusPage.getByRole("heading", { name: "環境狀態" })).toBeVisible();
    const visibleStatus = await statusPage.locator("main").innerText();
    expect(visibleStatus).toMatch(/Backend:\s*已連線/);
    expect(visibleStatus).toMatch(/Mongo:\s*已連線/);
    expect(visibleStatus).toMatch(/MinIO:\s*已連線/);
    const readyResponse = await statusPage.context().request.get(`${baseUrl}/api/ready`);
    expect(readyResponse.ok()).toBe(true);
    const ready = (await readyResponse.json()) as Record<string, unknown>;
    expect(ready).toMatchObject({ mongo: true, minio: true });
    await statusPage.close();

    const beforeSession = await sessionState(page, baseUrl);
    expect(beforeSession.nodes).toHaveLength(4);
    expect(beforeSession.nodes.map((node) => node.id)).toEqual([...NODE_TRAIL]);
    for (const node of beforeSession.nodes) {
      expect(node.image_url).toMatch(/^http:\/\/localhost:9000\/openflipbook\//);
      expect(node.browser_image_url).toBe(`/api/image/${node.id}`);
    }

    await page.goto(`${baseUrl}/play?continue=${encodeURIComponent(SESSION_ID)}`, {
      waitUntil: "domcontentloaded",
    });
    let image = await waitForNodeImage(page, NODE_TRAIL[3]);
    const firstRenderedImage = await image.evaluate((element) => {
      if (!(element instanceof HTMLImageElement)) {
        throw new Error("persisted illustration is not an image element");
      }
      return {
        src_attribute: element.getAttribute("src"),
        src: element.src,
        natural_width: element.naturalWidth,
        natural_height: element.naturalHeight,
      };
    });
    expect(firstRenderedImage.src).toBe(`${appOrigin}/api/image/${NODE_TRAIL[3]}`);

    const domText = await dragSelectDomText(page);
    const back = page.getByRole("button", { name: "← 上一頁", exact: true });
    const forward = page.getByRole("button", { name: "下一頁 →", exact: true });
    const map = page.getByRole("button", { name: "🗺 地圖", exact: true });
    const atlas = page.getByRole("link", { name: "↗ 圖集", exact: true });
    const navigationTargets = [];
    navigationTargets.push(await targetMeasurement("back", back));
    navigationTargets.push(await targetMeasurement("forward", forward));
    navigationTargets.push(await targetMeasurement("map", map));
    navigationTargets.push(await targetMeasurement("atlas", atlas));

    await expect(back).toBeDisabled();
    const breadcrumb = page.getByRole("navigation", { name: "位置" });
    await breadcrumb
      .locator('button[title*="Reciprocating Engine Cross-Section"]')
      .click();
    image = await waitForNodeImage(page, NODE_TRAIL[0]);
    await expect(back).toBeEnabled();
    await back.click();
    await waitForNodeImage(page, NODE_TRAIL[3]);
    await forward.click();
    image = await waitForNodeImage(page, NODE_TRAIL[0]);
    const h001Beacon = page.getByRole("button", {
      name: "開啟分支：Piston Pressure To Motion",
      exact: true,
    });
    const h001Target = await targetMeasurement("persisted h001 beacon", h001Beacon);
    const beforeRevisitStatus = await runtimeStatus(page, baseUrl);
    await h001Beacon.click();
    await waitForNodeImage(page, NODE_TRAIL[1]);
    const afterRevisitStatus = await runtimeStatus(page, baseUrl);
    expect(counters(afterRevisitStatus)).toEqual(counters(beforeRevisitStatus));

    await back.click();
    await waitForNodeImage(page, NODE_TRAIL[0]);
    await forward.click();
    await waitForNodeImage(page, NODE_TRAIL[1]);

    await page.getByRole("button", { name: "歷史紀錄", exact: true }).click();
    const historyDialog = page.getByRole("dialog", { name: "工作階段歷史紀錄" });
    await expect(historyDialog).toBeVisible();
    const currentSession = historyDialog.locator('button[aria-current="page"]');
    await expect(currentSession).toBeVisible();
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      currentSession.click(),
    ]);
    await waitForNodeImage(page, NODE_TRAIL[3]);

    if (viewport.name === "desktop") {
      await page.getByRole("button", { name: "設定", exact: true }).click();
      const exportDialog = page.getByRole("dialog", { name: "設定 / 執行狀態" });
      const downloadPromise = page.waitForEvent("download");
      await exportDialog.getByRole("link", { name: "匯出目前的離線書" }).click();
      const download = await downloadPromise;
      const exportPath = join(resultsDir, "E_B4_OFFLINE_EXPORT.zip");
      await download.saveAs(exportPath);
      const exportStat = await stat(exportPath);
      expect(exportStat.size).toBeGreaterThan(0);
      offlineExport = {
        path: exportPath,
        suggested_filename: download.suggestedFilename(),
        bytes: exportStat.size,
      };
      await exportDialog.getByLabel("關閉設定").click();
    }

    const afterSession = await sessionState(page, baseUrl);
    const statusAfter = await runtimeStatus(page, baseUrl);
    expect(afterSession.nodes.map((node) => node.id)).toEqual([...NODE_TRAIL]);
    expect(counters(statusAfter)).toEqual(counters(statusBefore));

    const finalOverflow = await page.evaluate(() => ({
      document_scroll_width: document.documentElement.scrollWidth,
      document_client_width: document.documentElement.clientWidth,
      body_scroll_width: document.body.scrollWidth,
      pass:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 &&
        document.body.scrollWidth <= document.documentElement.clientWidth + 1,
    }));
    expect(finalOverflow.pass).toBe(true);

    const screenshot = join(resultsDir, `E_BROWSER_${viewport.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });

    expect(observed.console_errors).toEqual([]);
    expect(observed.page_errors).toEqual([]);
    expect(observed.failed_requests).toEqual([]);
    expect(observed.failed_app_responses).toEqual([]);
    expect(observed.generation_endpoint_requests).toEqual([]);

    viewportResults.push({
      ...viewport,
      pass: true,
      origin: appOrigin,
      root_redirect: page.url().includes(`/play?continue=${SESSION_ID}`),
      document_lang: await page.locator("html").getAttribute("lang"),
      primary_touch_targets: primaryTargets,
      settings_touch_targets: settingsTargets,
      navigation_touch_targets: navigationTargets,
      initial_overflow: initialOverflow,
      final_overflow: finalOverflow,
      settings: {
        initial_output_locale: outputBefore,
        output_unchanged_after_ui_english: true,
        ui_restored_to: "zh-TW",
        reduced_motion_toggled_without_counter_change: true,
      },
      ready,
      node_count_before: beforeSession.nodes.length,
      node_count_after: afterSession.nodes.length,
      persisted_image_srcs: afterSession.nodes.map((node) => node.browser_image_url),
      legacy_image_urls: afterSession.nodes.map((node) => node.image_url),
      rendered_image: firstRenderedImage,
      dom_text: domText,
      revisited_hotspot: "h001",
      revisited_node_id: NODE_TRAIL[1],
      h001_touch_target: h001Target,
      back_forward_pass: true,
      history_resume_pass: true,
      provider_counters_before: counters(statusBefore),
      provider_counters_after: counters(statusAfter),
      screenshot,
      ...observed,
    });

    } finally {
      await context.close();
    }
  }

  expect(offlineExport).not.toBeNull();
  const evidence = {
    schema: "openflipbook.e.browser-acceptance.v1",
    pass: true,
    persisted_session_id: SESSION_ID,
    persisted_root_id: NODE_TRAIL[0],
    provider_budget: 0,
    generation_requests_made: 0,
    offline_export: offlineExport,
    viewports: viewportResults,
  };
  await writeFile(
    join(resultsDir, "E_BROWSER_ACCEPTANCE.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
});
