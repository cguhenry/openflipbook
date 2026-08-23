import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useReducedMotionPreference } from "./useReducedMotionPreference";

afterEach(() => window.localStorage.clear());

describe("useReducedMotionPreference", () => {
  it("defaults to the system preference and persists a forced reduction", () => {
    const { result } = renderHook(() => useReducedMotionPreference());
    expect(result.current[0]).toBe("system");

    act(() => result.current[1]("reduce"));
    expect(window.localStorage.getItem("openflipbook.motionPreference")).toBe("reduce");
  });

  it("hydrates a valid stored preference and rejects junk", () => {
    window.localStorage.setItem("openflipbook.motionPreference", "reduce");
    const reduced = renderHook(() => useReducedMotionPreference());
    expect(reduced.result.current[0]).toBe("reduce");
    reduced.unmount();

    window.localStorage.setItem("openflipbook.motionPreference", "animate-everything");
    const invalid = renderHook(() => useReducedMotionPreference());
    expect(invalid.result.current[0]).toBe("system");
  });
});
