"use client";

import { usePersistedState } from "./usePersistedState";

export type MotionPreference = "system" | "reduce";

const KEY = "openflipbook.motionPreference";

function isMotionPreference(value: unknown): value is MotionPreference {
  return value === "system" || value === "reduce";
}

/** The system setting always wins; this preference can additionally force reduction. */
export function useReducedMotionPreference(): readonly [
  MotionPreference,
  (value: MotionPreference) => void,
] {
  return usePersistedState(KEY, "system", isMotionPreference);
}
