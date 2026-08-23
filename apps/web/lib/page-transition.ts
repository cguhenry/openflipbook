export interface TransitionOrigin {
  xPct?: number;
  yPct?: number;
}

type ViewTransitionLike = { finished?: Promise<unknown> };
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
};

export function reducedMotion(
  win: Pick<Window, "matchMedia"> = window,
  forceReduced = false,
): boolean {
  return forceReduced || (win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false);
}

function runCssFallback(update: () => void, root: HTMLElement): void {
  const classes = root.classList;
  if (!classes) {
    update();
    return;
  }
  classes.add("flipbook-no-view-transition");
  update();
  globalThis.setTimeout(() => classes.remove("flipbook-no-view-transition"), 260);
}

export function runPageViewTransition(
  update: () => void,
  origin: TransitionOrigin = {},
  doc: Document = document,
  win: Pick<Window, "matchMedia"> = window,
  forceReduced = false,
): ViewTransitionLike | null {
  const root = doc.documentElement;
  const x = Math.min(1, Math.max(0, origin.xPct ?? 0.5));
  const y = Math.min(1, Math.max(0, origin.yPct ?? 0.5));
  root.style.setProperty("--flipbook-transition-x", x * 100 + "%");
  root.style.setProperty("--flipbook-transition-y", y * 100 + "%");

  const vtDoc = doc as ViewTransitionDocument;
  if (reducedMotion(win, forceReduced)) {
    update();
    return null;
  }
  if (typeof vtDoc.startViewTransition !== "function") {
    runCssFallback(update, root);
    return null;
  }
  try {
    return vtDoc.startViewTransition(update);
  } catch {
    runCssFallback(update, root);
    return null;
  }
}
