/**
 * Which display a perform window opens on, and where (§T1391b).
 *
 * Pure except for `readScreenDetails`, the one adapter over the browser's Window Management
 * API. Everything a test needs to pin — which screen a stored name resolves to, what its
 * physical size is, the `window.open` features string, the window's name — is a function of
 * plain data here.
 *
 * ## Screen identity
 *
 * A Window Out stores a display's LABEL (`ScreenDetailed.label`, "DELL U2720Q"). Labels are
 * what a person recognises, but they are neither unique nor promised stable across operating
 * systems, so resolution is forgiving and says so: an exact match wins (the first of a
 * duplicated label), and a name that matches nothing falls back to Auto — a screen other
 * than the editor's — with a warning the inspector shows. Auto is the empty string.
 */

export interface ScreenInfo {
  readonly label: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly availLeft: number;
  readonly availTop: number;
  readonly availWidth: number;
  readonly availHeight: number;
  readonly devicePixelRatio: number;
  readonly isPrimary: boolean;
  readonly isInternal: boolean;
}

export interface ResolvedScreen {
  readonly screen: ScreenInfo | undefined;
  /** Set when the stored name matched nothing and Auto was used instead. */
  readonly warning: string | undefined;
}

const sameScreen = (a: ScreenInfo, b: ScreenInfo): boolean => a.left === b.left && a.top === b.top;

/**
 * The screen a stored name means. `editor` is the display the editor window is on, so Auto
 * can prefer ANOTHER one — the projector, not the laptop panel the editor is open on.
 */
export function resolveScreen(
  screens: readonly ScreenInfo[],
  stored: string,
  editor: ScreenInfo | undefined,
): ResolvedScreen {
  const auto = (): ScreenInfo | undefined =>
    screens.find((screen) => editor === undefined || !sameScreen(screen, editor)) ?? screens[0];
  if (stored.trim() === "") return { screen: auto(), warning: undefined };
  const exact = screens.find((screen) => screen.label === stored);
  if (exact !== undefined) return { screen: exact, warning: undefined };
  return { screen: auto(), warning: `No screen named "${stored}" is connected; using another screen.` };
}

/** The display's size in PHYSICAL pixels — what "Match screen" writes into Width × Height. */
export function physicalSize(screen: ScreenInfo): readonly [number, number] {
  return [Math.round(screen.width * screen.devicePixelRatio), Math.round(screen.height * screen.devicePixelRatio)];
}

/**
 * The `window.open` features that place a popup on `screen`, filling its usable area.
 * `fullscreen` asks Chrome for a fullscreen popup, which it grants only with the
 * window-management permission and a user gesture; elsewhere it is ignored and the window
 * offers a click to go fullscreen instead.
 */
export function placementFeatures(screen: ScreenInfo | undefined, options: { readonly fullscreen: boolean }): string {
  const parts = ["popup=yes"];
  if (screen !== undefined) {
    parts.push(
      `left=${Math.round(screen.availLeft)}`,
      `top=${Math.round(screen.availTop)}`,
      `width=${Math.round(screen.availWidth)}`,
      `height=${Math.round(screen.availHeight)}`,
    );
  } else {
    parts.push("width=960", "height=540");
  }
  if (options.fullscreen) parts.push("fullscreen");
  return parts.join(",");
}

/**
 * The popup's window NAME. Electron allows only `loom-[a-z0-9-]+` popups (`policy.cjs`) and
 * node ids carry characters outside that set, so the id is spelled in lowercase hex: a
 * total, collision-free encoding (`a_b`, `a-b` and `A_b` are three names).
 */
export function performWindowName(nodeId: string): string {
  let hex = "";
  for (const unit of new TextEncoder().encode(nodeId)) hex += unit.toString(16).padStart(2, "0");
  return `loom-perform-${hex}`;
}

/** What the browser will say about screens, read once and kept current. */
export interface ScreenSource {
  readonly screens: () => readonly ScreenInfo[];
  /** The display the editor window is on, when known. */
  readonly editor: () => ScreenInfo | undefined;
  /** `granted` / `prompt` / `denied`, or `unsupported` where the API does not exist. */
  readonly permission: () => ScreenPermission;
  /** Ask for screen access. Needs a user gesture; resolves once the list is current. */
  readonly request: () => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
}

export type ScreenPermission = "granted" | "prompt" | "denied" | "unsupported";

interface BrowserScreen {
  readonly label?: string;
  readonly left?: number;
  readonly top?: number;
  readonly width: number;
  readonly height: number;
  readonly availLeft?: number;
  readonly availTop?: number;
  readonly availWidth: number;
  readonly availHeight: number;
  readonly devicePixelRatio?: number;
  readonly isPrimary?: boolean;
  readonly isInternal?: boolean;
}

interface BrowserScreenDetails extends EventTarget {
  readonly screens: readonly BrowserScreen[];
  readonly currentScreen: BrowserScreen;
}

function toInfo(screen: BrowserScreen, fallbackLabel: string, ratio: number): ScreenInfo {
  return {
    label: screen.label !== undefined && screen.label !== "" ? screen.label : fallbackLabel,
    left: screen.left ?? 0,
    top: screen.top ?? 0,
    width: screen.width,
    height: screen.height,
    availLeft: screen.availLeft ?? screen.left ?? 0,
    availTop: screen.availTop ?? screen.top ?? 0,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    devicePixelRatio: screen.devicePixelRatio ?? ratio,
    isPrimary: screen.isPrimary ?? true,
    isInternal: screen.isInternal ?? false,
  };
}

/**
 * The browser adapter. Without the Window Management API (or before permission) the list is
 * the ONE screen the editor is on, labelled "This screen" — a perform window still opens,
 * just not placed elsewhere. The details object is cached and followed on `screenschange`,
 * because asking again from a click would spend the click's activation on a prompt and the
 * popup it was for would then be blocked.
 */
export function createScreenSource(host: Window): ScreenSource {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const current = (): ScreenInfo => toInfo(host.screen as unknown as BrowserScreen, "This screen", host.devicePixelRatio);
  let details: BrowserScreenDetails | undefined;
  let permission: ScreenPermission =
    typeof (host as unknown as { getScreenDetails?: unknown }).getScreenDetails === "function" ? "prompt" : "unsupported";

  const adopt = async (): Promise<void> => {
    const getScreenDetails = (host as unknown as { getScreenDetails?: () => Promise<BrowserScreenDetails> }).getScreenDetails;
    if (getScreenDetails === undefined) return;
    try {
      details = await getScreenDetails.call(host);
      permission = "granted";
      details.addEventListener("screenschange", notify);
      details.addEventListener("currentscreenchange", notify);
    } catch {
      permission = "denied";
    }
    notify();
  };

  // Already granted in an earlier session: read the list now, with no prompt.
  if (permission === "prompt") {
    const query = (host.navigator as unknown as { permissions?: { query(d: { name: string }): Promise<{ state: string }> } }).permissions;
    void query
      ?.query({ name: "window-management" })
      .then((status) => {
        if (status.state === "granted") return adopt();
        if (status.state === "denied") permission = "denied";
        notify();
        return undefined;
      })
      .catch(() => undefined);
  }

  return {
    screens: () =>
      details === undefined
        ? [current()]
        : details.screens.map((screen, index) => toInfo(screen, `Screen ${String(index + 1)}`, host.devicePixelRatio)),
    editor: () => (details === undefined ? current() : toInfo(details.currentScreen, "This screen", host.devicePixelRatio)),
    permission: () => permission,
    request: adopt,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
