import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync(
  resolve(process.cwd(), "../../docker-compose.yml"),
  "utf8",
);
const nasCompose = readFileSync(
  resolve(process.cwd(), "../../docker-compose.nas.yml"),
  "utf8",
);
const nasComposeScript = readFileSync(
  resolve(process.cwd(), "../../scripts/nas-compose.sh"),
  "utf8",
);
const playPage = readFileSync(resolve(process.cwd(), "app/play/page.tsx"), "utf8");
const landingPage = readFileSync(resolve(process.cwd(), "app/page.tsx"), "utf8");
const webDockerfile = readFileSync(
  resolve(process.cwd(), "Dockerfile"),
  "utf8",
);
const i18nSource = readFileSync(resolve(process.cwd(), "lib/i18n.ts"), "utf8");

describe("NAS compose product defaults", () => {
  it("keeps the fixed OpenClaw path with zero-default operational caps", () => {
    expect(compose).toContain('FLIPBOOK_LIVE_PROVIDER: "openclaw"');
    expect(compose).toContain("FLIPBOOK_MAX_RUNTIME_GENERATIONS:-0");
    expect(compose).toContain("FLIPBOOK_MAX_SESSION_GENERATIONS:-0");
  });

  it("enables existing transitions/offline export without AI video or prefetch", () => {
    expect(compose).toContain("NEXT_PUBLIC_HTML5_TRANSITIONS:-true");
    expect(compose).toContain("NEXT_PUBLIC_OFFLINE_EXPORT:-true");
    expect(compose).toContain("NEXT_PUBLIC_VIDEO:-false");
    expect(compose).toContain("NEXT_PUBLIC_AI_PREFETCH:-false");
  });

  it("defaults NAS UI to zh-TW and gates Web health on core readiness", () => {
    expect(compose).toContain("NEXT_PUBLIC_DEFAULT_UI_LOCALE:-zh-TW");
    expect(nasCompose).toContain('NEXT_PUBLIC_DEFAULT_UI_LOCALE: "zh-TW"');
    expect(webDockerfile).toContain("ARG NEXT_PUBLIC_DEFAULT_UI_LOCALE");
    expect(i18nSource).toContain(
      "NEXT_PUBLIC_DEFAULT_UI_LOCALE: process.env.NEXT_PUBLIC_DEFAULT_UI_LOCALE",
    );
    expect(compose).toContain("http://127.0.0.1:3000/api/ready");
    expect(landingPage).toContain('if (PRODUCT_FLAGS.nasSlim) redirect("/play")');
  });

  it("neutralizes hidden legacy request knobs on the NAS request path", () => {
    expect(playPage).toContain("PRODUCT_FLAGS.nasSlim ? {} : wireFields(loopKnobs)");
    expect(playPage).toContain(
      'const requestImageTier = PRODUCT_FLAGS.nasSlim ? "balanced" : imageTier;',
    );
    expect(playPage).toContain("!PRODUCT_FLAGS.nasSlim && EDIT_REGION_ENABLED");
  });

  it("keeps narrow-screen navigation wrapping inside safe-area padding", () => {
    expect(playPage).toContain("env(safe-area-inset-bottom)");
    expect(playPage).toContain(
      "flex flex-wrap items-center justify-between gap-3 text-xs opacity-80",
    );
    expect(playPage).toContain("min-h-11 rounded-full border");
  });

  it("pins the canonical project and existing data volumes", () => {
    expect(nasCompose).toContain("name: openflipbook-a0");
    expect(nasCompose).toContain("name: openflipbook-a0_mongo-data");
    expect(nasCompose).toContain("name: openflipbook-a0_minio-data");
    expect(nasCompose.match(/external: true/g)).toHaveLength(2);
    expect(nasComposeScript).toContain("--project-name openflipbook-a0");
    expect(nasComposeScript).toContain("COMPOSE_PARALLEL_LIMIT=1");
    expect(nasComposeScript).toContain("docker-compose.nas.yml");
  });

  it("publishes only Web to NAS clients and binds data services to loopback", () => {
    expect(nasCompose).toContain('"3000:3000"');
    expect(nasCompose).not.toContain('"127.0.0.1:3000:3000"');
    expect(nasCompose).toContain('"127.0.0.1:8787:8787"');
    expect(nasCompose).toContain('"127.0.0.1:27017:27017"');
    expect(nasCompose).toContain('"127.0.0.1:9000:9000"');
    expect(nasCompose).toContain('"127.0.0.1:9001:9001"');
  });
});
