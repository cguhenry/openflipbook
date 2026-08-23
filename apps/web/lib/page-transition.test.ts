import { describe, expect, it, vi } from "vitest";
import { runPageViewTransition } from "./page-transition";

function win(reduced: boolean) {
  return { matchMedia: () => ({ matches: reduced }) } as unknown as Window;
}

describe("runPageViewTransition", () => {
  it("uses native View Transitions when available", () => {
    const update = vi.fn();
    const start = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    const doc = {
      documentElement: { style: { setProperty: vi.fn() } },
      startViewTransition: start,
    } as unknown as Document;
    runPageViewTransition(update, { xPct: .2, yPct: .7 }, doc, win(false));
    expect(start).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });

  it("falls back synchronously when unsupported", () => {
    const update = vi.fn();
    const doc = {
      documentElement: { style: { setProperty: vi.fn() } },
    } as unknown as Document;
    expect(runPageViewTransition(update, {}, doc, win(false))).toBeNull();
    expect(update).toHaveBeenCalledOnce();
  });

  it("honors reduced motion", () => {
    const update = vi.fn();
    const start = vi.fn();
    const add = vi.fn();
    const doc = {
      documentElement: {
        style: { setProperty: vi.fn() },
        classList: { add, remove: vi.fn() },
      },
      startViewTransition: start,
    } as unknown as Document;
    runPageViewTransition(update, {}, doc, win(true));
    expect(start).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it("allows the persisted preference to force reduced motion", () => {
    const update = vi.fn();
    const start = vi.fn();
    const add = vi.fn();
    const doc = {
      documentElement: {
        style: { setProperty: vi.fn() },
        classList: { add, remove: vi.fn() },
      },
      startViewTransition: start,
    } as unknown as Document;
    runPageViewTransition(update, {}, doc, win(false), true);
    expect(start).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
});
