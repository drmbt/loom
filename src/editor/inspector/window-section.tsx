import { useState, useSyncExternalStore } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { Button } from "@ui/primitives/button.tsx";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";

/**
 * The perform window's controls, on the Window Out node (§T1391b, T960: on the node, not in
 * a device pane).
 *
 * Screen is a PICKER over the displays the browser reports; the other window settings
 * (Width, Height, Fit, Fullscreen, Hide cursor) stay ordinary parameter rows below. "Match
 * screen" writes the chosen display's physical pixels into Width × Height as ONE edit (one
 * undo). Open / Close runs `perform.toggle` by name (§V97) — the same command the key and
 * the palette run, so the button cannot open a window differently from them.
 *
 * Screen access is asked for with a click, because the browser's permission prompt needs
 * one and must not spend the gesture that opens a window.
 */

/** A display, as the section needs it. The app's `ScreenInfo` satisfies this shape. */
export interface WindowScreenView {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly isPrimary: boolean;
}

export interface WindowSectionSurface {
  screens(): readonly WindowScreenView[];
  permission(): "granted" | "prompt" | "denied" | "unsupported";
  requestScreenAccess(): Promise<void>;
  isOpen(nodeId: string): boolean;
  /** One line about this node's window: where it is, or why it is not. */
  describe(nodeId: string): string;
  subscribe(listener: () => void): () => void;
}

/** T994's claim: the section presents Screen; every other parameter keeps its row. */
// eslint-disable-next-line react-refresh/only-export-components -- T994: the claim lives WITH the section it mirrors.
export function windowSectionParameters(): readonly string[] {
  return ["screen"];
}

export interface WindowSectionProps {
  readonly nodeId: NodeId;
  /** The stored Screen label; empty = Auto. */
  readonly screen: string;
  readonly bus: LoomBus;
  readonly context: InvocationContext;
  readonly editor: ParameterEditor;
  readonly windows: WindowSectionSurface;
}

const AUTO = "";

export function WindowSection({ nodeId, screen, bus, context, editor, windows }: WindowSectionProps) {
  // Re-render on open/close, on a screen being plugged in, and on a permission change.
  const version = useSyncExternalStore(
    windows.subscribe,
    () => `${windowsVersion(windows)}|${windows.describe(nodeId)}`,
    () => "",
  );
  void version;
  const [refusal, setRefusal] = useState<string | null>(null);
  const screens = windows.screens();
  const permission = windows.permission();
  const open = windows.isOpen(nodeId);
  const chosen = screens.find((entry) => entry.label === screen);

  const options = [
    { value: AUTO, label: "Auto — a screen other than the editor's" },
    ...(screen !== AUTO && chosen === undefined ? [{ value: screen, label: `${screen} (not connected)` }] : []),
    ...screens.map((entry) => ({
      value: entry.label,
      label: `${entry.label} — ${String(Math.round(entry.width * entry.devicePixelRatio))}×${String(Math.round(entry.height * entry.devicePixelRatio))}${entry.isPrimary ? ", primary" : ""}`,
    })),
  ];

  const toggle = () => {
    void bus.execute("perform.toggle", { nodeIds: [nodeId] }, context).then((result) => {
      setRefusal(result.status === "rejected" ? (result.diagnostics?.[0]?.message ?? "The window did not open.") : null);
    });
  };

  const match = () => {
    const target = chosen ?? screens[0];
    if (target === undefined) return;
    editor.setStored(
      nodeId,
      {
        width: Math.round(target.width * target.devicePixelRatio),
        height: Math.round(target.height * target.devicePixelRatio),
      },
      "commit",
    );
  };

  return (
    <section className={styles.section} aria-label="Window">
      <div className={styles.sectionHeader}>
        <span>Window</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

      <div className={styles.statusLine} role="status" data-window-open={open ? "true" : "false"}>
        {windows.describe(nodeId)}
      </div>
      {refusal === null ? null : (
        <span className={styles.statusHint} role="alert">
          {refusal}
        </span>
      )}

      <ControlRow label="Screen">
        <EnumField
          label="Screen"
          value={screen}
          options={options}
          onChange={(value, phase) => editor.setParameter(nodeId, "screen", value, phase)}
        />
      </ControlRow>
      {permission === "prompt" ? (
        <ControlRow label="Screens">
          <Button variant="outline" onClick={() => void windows.requestScreenAccess()}>
            Allow screen access
          </Button>
        </ControlRow>
      ) : null}
      {permission === "denied" ? (
        <span className={styles.statusHint}>Screen access was refused, so only this screen is listed. Allow window management for this site to pick another.</span>
      ) : null}
      {permission === "unsupported" ? (
        <span className={styles.statusHint}>This browser cannot list screens; the window opens here and can be dragged to another.</span>
      ) : null}

      <ControlRow label="Size">
        <Button variant="outline" onClick={match} disabled={screens.length === 0}>
          Match screen
        </Button>
      </ControlRow>

      <ControlRow label="Perform">
        <Button variant="outline" onClick={toggle}>
          {open ? "Close window" : "Open window"}
        </Button>
      </ControlRow>
    </section>
  );
}

/**
 * A snapshot for `useSyncExternalStore` that changes whenever anything this section shows
 * does: the open state and the screen list's shape.
 */
function windowsVersion(windows: WindowSectionSurface): string {
  return `${windows.permission()}|${windows
    .screens()
    .map((entry) => `${entry.label}:${String(entry.width)}x${String(entry.height)}@${String(entry.devicePixelRatio)}`)
    .join(",")}`;
}
