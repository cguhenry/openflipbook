import { describe, expect, it } from "vitest";

const { readFileSync } = process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const globals = readFileSync(`${process.cwd()}/app/globals.css`, "utf8");
const playPage = readFileSync(`${process.cwd()}/app/play/page.tsx`, "utf8");

const interactionEffect = playPage.slice(
  playPage.indexOf("  useEffect(() => {\n    const img = imgRef.current;"),
  playPage.indexOf("  // When the page changes, tear down any running stream."),
);

describe("HF1 interactive surface recovery", () => {
  it("defines opaque paper surfaces for every theme", () => {
    expect(globals).toContain("--color-paper: #fffdf8;");
    expect(globals).toContain("--color-paper: #f8ecd4;");
    expect(globals).toContain("--color-paper: #211e1a;");
    expect(globals).not.toMatch(/--color-paper:\s*transparent/);
  });

  it("keeps deterministic image listeners while skipping legacy hover prefetch", () => {
    expect(interactionEffect).not.toContain(
      "if (page.pagePlan && page.alignedHotspots?.length) return;",
    );
    expect(interactionEffect).toContain(
      "const deterministicPage = Boolean(page.pagePlan && page.alignedHotspots?.length);",
    );
    expect(interactionEffect).toContain("if (deterministicPage) return;");
    expect(interactionEffect).toContain('img.addEventListener("click", handler);');
    expect(interactionEffect).toContain('img.addEventListener("pointermove", move);');
  });

  it("uses the native NAS idle cursor without the duplicate custom crosshair", () => {
    expect(playPage).toContain(
      'PRODUCT_FLAGS.nasSlim\n                          ? "cursor-pointer"\n                          : "cursor-none"',
    );
    expect(playPage).toContain("{!PRODUCT_FLAGS.nasSlim &&\n                hoverPos &&");
  });
});
