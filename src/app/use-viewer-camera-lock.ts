import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { authoredGraph, type GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { kindOf } from "@domain/graph/node-kinds.ts";
import { kindLabelParts } from "@editor/nodes/kind-label.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { createCameraGizmoStore } from "@editor/viewer/camera-gizmo-store.ts";
import { cameraPoseAt, cameraPoseSaid } from "@editor/viewer/camera-pose.ts";
import type { PreviewOrbitStore } from "@editor/viewer/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * §T970 — THE VIEWER LOCKS TO THE CAMERA ITS PICTURE IS DRAWN THROUGH, AND FLIES IT.
 *
 * The owner, twice: "i'm still missing a way to actually change the position of the camera
 * in the camera node via flying around in that preview instead of manually having to deal
 * with it". A camera could be dragged on its own 170 px tile (§T692) and nowhere else; the
 * viewer, where the scene can actually be seen, said "drag on its tile in the graph".
 *
 * ## What is locked to what
 *
 * The compiler already says whose camera a picture is taken through
 * (`ResolvedOutput.previewCamera`, §T1655b): a row drawn through its own node's Eye and Look
 * At (`pose`: a camera, a projector, a Render Surface or Render Instances with no camera
 * named), or a picture FRAMED by another node (`through-camera`: a Render). Either way there
 * is exactly one node whose pose the picture follows, and that is the target. The button
 * NAMES it before the first press, because the gestures that follow edit a node that may not
 * be the one the viewer is showing (§T692 refused this on the Render's TILE for that reason;
 * a named target in the viewer is the answer to it).
 *
 * ## Every move is an edit
 *
 * Armed, the viewer's own gestures (drag, shift-drag, the wheel, the fly keys) go to a
 * `createCameraGizmoStore` instead of the inspection store: ordinary `setParameters`
 * patches through the bus, attributed and undoable. The picture is the camera's own at every
 * moment, so nothing is falsified (§T614 holds by construction) and nothing is rendered
 * twice. One drag, one wheel burst and one flight are one undo step each.
 *
 * `h`, which returns an INSPECTION camera home, here only leaves the mode: home must never
 * be an edit, and the way back from an edit is undo.
 *
 * ## A driven pose
 *
 * A target with no free channel of Eye or Look At cannot be flown and is not offered: the
 * button is absent and the driven sentence stands (§T1049). Its rig belongs in Origin and
 * Heading (§T1656b), which leaves Eye and Look At as the offsets flown here.
 */
export interface ViewerCameraLock {
  /** The node whose Eye and Look At this picture is drawn through and can be moved by, or null. */
  readonly target: NodeId | null;
  /** That node's name, for the button and its sentences. Empty when there is no target. */
  readonly name: string;
  /**
   * The name where its kind ends (`camera` + `_rig`), as a node's own label splits it, so
   * a button with no room gives up the KIND and keeps the role, which is what tells two
   * cameras apart. `rest` is the whole name when it does not carry its kind.
   */
  readonly nameParts: { readonly kind: string; readonly rest: string };
  /** A picture drawn through a pose nothing here can move: why. Null otherwise. */
  readonly refusal: string | null;
  /** The channels of a partly driven pose the flight will leave alone. Empty for none. */
  readonly held: string;
  /** The document-writing camera the viewer's gestures go to while `armed`. */
  readonly store: PreviewOrbitStore;
  readonly armed: boolean;
  /** Arm, disarm, or (undefined) toggle. Answers the state it left; false when nothing can be flown. */
  set(on: boolean | undefined): boolean;
}

/** The node a row's picture is drawn through, or null: its own pose, or the camera that frames it. */
export function cameraOfPicture(row: ResolvedOutput | null | undefined): NodeId | null {
  const control = row?.previewCamera;
  if (row === null || row === undefined || control === undefined) return null;
  if (control.kind === "pose") return row.nodeId;
  if (control.kind === "none" && control.reason.because === "through-camera") return control.reason.camera;
  return null;
}

/** The button's face: what it will fly, by name. */
export const flyCameraLabel = (name: string): string => `Fly ${name}`;

/** The button's hover and focus text, in both states. The keys are the keymap's defaults. */
export function flyCameraHint(name: string, armed: boolean, held = ""): string {
  const said = armed
    ? `Flying ${name}. Drag orbits, shift-drag trucks, the wheel dollies, W A S D + E Q fly (shift is faster). Every move is an edit and undo steps back. C or H leaves.`
    : `Fly ${name} from this picture (C): drag, shift-drag, the wheel and W A S D + E Q move the camera itself. Every move is an edit and undo steps back.`;
  return held === "" ? said : `${said} ${held}`;
}

/** The readout's line while armed: the one thing a pilot must not be surprised by, and what will not move. */
export const flyingCameraSentence = (name: string, held = ""): string =>
  `Flying ${name}: every move is an edit, undo steps back.${held === "" ? "" : ` ${held}`}`;

export function useViewerCameraLock(options: {
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly registry: NodeRegistryView;
  /** The document as the pane last rendered it: the NAMES. Poses are read off the store. */
  readonly graph: GraphDocument;
  readonly selected: ResolvedOutput | null | undefined;
}): ViewerCameraLock {
  const { bus, invocation, registry, graph, selected } = options;

  const editor = useMemo(() => createParameterEditor({ bus, context: invocation }), [bus, invocation]);
  useEffect(() => () => editor.dispose(), [editor]);
  /*
   * Off the STORE, at the gesture (§T1652b): this pane is not rendered for a values-only
   * revision, and a flight is a run of exactly those, so the `graph` prop is a pose behind.
   */
  const readPose = useCallback(
    (nodeId: NodeId) => {
      const current = bus.store.getGraph();
      const node = current.nodes[nodeId];
      if (node === undefined) return null;
      return cameraPoseAt(node, registry.get(node.type), { ...bus.readScope(), graph: authoredGraph(current), registry });
    },
    [bus, registry],
  );
  const store = useMemo(() => createCameraGizmoStore({ editor, readPose }), [editor, readPose]);

  const candidate = cameraOfPicture(selected);
  /* WHICH MODE decides each channel is a fact of the revision this pane rendered with (a
     mode change is structural, so the pane is rendered for it): `graph` is the right key. */
  const { target, refusal, held } = useMemo((): { target: NodeId | null; refusal: string | null; held: string } => {
    const node = candidate === null ? undefined : graph.nodes[candidate];
    // A camera inside a component is not in the document this pane edits.
    if (candidate === null || node === undefined) return { target: null, refusal: null, held: "" };
    const said = cameraPoseSaid(node, registry.get(node.type), { ...bus.readScope(), graph: authoredGraph(graph), registry });
    return said.driven === null ? { target: candidate, refusal: null, held: said.held } : { target: null, refusal: said.driven, held: "" };
  }, [bus, candidate, graph, registry]);
  const name = target === null ? "" : (graph.nodes[target]?.label ?? target);
  const nameParts = useMemo(() => {
    const definition = target === null ? undefined : registry.get(graph.nodes[target]?.type ?? "");
    if (definition === undefined) return { kind: "", rest: name };
    const parts = kindLabelParts(name, kindOf(definition));
    return parts.joined ? { kind: parts.kind, rest: parts.rest } : { kind: "", rest: name };
  }, [graph, name, registry, target]);

  const subscribe = useCallback(
    (listener: () => void) => (target === null ? () => {} : store.subscribe(target, listener)),
    [store, target],
  );
  const read = useCallback(() => target !== null && store.mode(target) === "adjustable", [store, target]);
  const armed = useSyncExternalStore(subscribe, read, read);

  // The lock belongs to the picture it was armed on: another subject, or a target that can
  // no longer be flown, leaves it (and closes whatever gesture was open).
  useEffect(() => {
    if (target === null) return;
    return () => store.setMode(target, "home");
  }, [store, target]);

  const set = useCallback(
    (on: boolean | undefined): boolean => {
      if (target === null) return false;
      const next = on ?? store.mode(target) !== "adjustable";
      store.setMode(target, next ? "adjustable" : "home");
      return next;
    },
    [store, target],
  );

  return { target, name, nameParts, refusal, held, store, armed, set };
}
