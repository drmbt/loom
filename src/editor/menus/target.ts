import type { MenuTarget } from "@domain/types/menus.ts";

/**
 * Resolving what was right-clicked (T126, §V78).
 *
 * ONE menu root sits over a whole pane and asks this module what the click landed on.
 * The alternative — a Radix root per node — costs a portal, a context and a subscription
 * per node on a graph that is meant to hold hundreds of them, which is exactly why the
 * canvas track declined to build it that way.
 *
 * Nothing here invents a marker. The graph canvas already ships React Flow's own DOM
 * contract on every node, edge and port handle, and those attributes are what we read:
 *
 *   node    `.react-flow__node[data-id="<nodeId>"]`
 *   edge    `.react-flow__edge[data-id="<edgeId>"]`
 *   port    `.react-flow__handle[data-nodeid="…"][data-handleid="…"]`
 *
 * The parameter surface is the one exception, because a parameter row is OURS: the
 * control carries `data-parameter-key` and something above it says which node owns it.
 * The inspector sets both (its pane root carries `data-node-id`), which is how reset and
 * publish reach the bus from a right-click there.
 *
 * ## The owner of a parameter ON THE CANVAS (T1034)
 *
 * A control rendered INSIDE a graph node has no `data-node-id` above it — React Flow's
 * wrapper says `data-id`, and `node-view.tsx` adds no second spelling of the same fact.
 * The owner lookup therefore accepts either marker, nearest wins. Without that, such a
 * row fell out of the parameter branch entirely and the walk carried on to the node
 * wrapper, so a right-click on a control opened the NODE menu: the wrong menu, silently,
 * with no `parameter.reset` on it. §T1033 had just removed double-click-to-reset on the
 * correct argument that the menu already carried it — true where it was checked (the
 * inspector) and never checked here (§V840).
 *
 * WHAT THIS DOES NOT DO, so nobody reads it as more than it is: nothing in the product
 * renders a parameter control inside a graph node today. `GraphCanvas`'s `renderControls`
 * slot has no caller (`node-box.ts` measured the same thing for its own reasons), and
 * `Inspector`'s `variant="node"` is never asked for. This closes the resolution half so
 * that the first caller to fill that slot gets a working parameter menu instead of
 * rediscovering this; it does not by itself put a reset back on screen.
 */

/** React Flow's own markers. Changing these means React Flow changed, not us. */
const NODE_CLASS = "react-flow__node";
const EDGE_CLASS = "react-flow__edge";
const HANDLE_CLASS = "react-flow__handle";
const RF_ID = "data-id";
const HANDLE_NODE_ID = "data-nodeid";
const HANDLE_PORT_ID = "data-handleid";

/** Ours: the inspector must put these on a parameter row for the parameter menu. */
export const PARAMETER_KEY_ATTRIBUTE = "data-parameter-key";
export const PARAMETER_NODE_ATTRIBUTE = "data-node-id";
/**
 * §T1393b: a value node's channel row. `data-channel-name` names the channel, the node
 * is the nearest owner (the card's React Flow wrapper, or a panel's `data-node-id`), and
 * `data-channel-value` is the reading the row shows, when it shows one.
 */
export const CHANNEL_NAME_ATTRIBUTE = "data-channel-name";
export const CHANNEL_VALUE_ATTRIBUTE = "data-channel-value";
/**
 * §T1619b: a live control widget (`control-widget.tsx`). `data-control` says which kind it
 * is and `data-control-node` which node; `data-control-panel`, on the Panel surface around
 * it, says which Panel's board it was clicked on. Only the kinds that hold a DEFAULT are a
 * surface of their own: a Button has nothing to reset, so a click on one falls through to
 * whatever is around it.
 *
 * NEAREST WINS, as everywhere here: on the canvas a control's widget sits inside its own
 * node (or inside a Panel node's body), so a right-click ON THE WIDGET opens the control's
 * menu and a right-click on the rest of the node — its header, its frame — still opens the
 * node's. The node menu is at its row cap, so the control's rows could not have joined it.
 */
export const CONTROL_KIND_ATTRIBUTE = "data-control";
export const CONTROL_NODE_ATTRIBUTE = "data-control-node";
export const CONTROL_PANEL_ATTRIBUTE = "data-control-panel";
/** The `data-control` values whose control holds a default: Slider, Toggle, XY Pad. */
const DEFAULT_HOLDING_CONTROLS: ReadonlySet<string> = new Set(["slider", "toggle", "xy"]);

export interface ResolveMenuTargetOptions {
  /**
   * Surface for a click that landed on nothing marked — "canvas" for the graph pane.
   * `null`/omitted means such a click resolves to nothing and no menu opens.
   */
  fallback?: MenuTarget["surface"] | null;
  /** Graph-space click position, so "add node here" lands under the cursor. */
  position?: { x: number; y: number };
  /** Stop walking here (the menu host's own element). */
  boundary?: Element | null;
}

function attribute(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  return value === null || value === "" ? null : value;
}

/**
 * The first marker found walking OUT from the clicked element wins, which is what makes
 * a click on a port resolve to the port and not to the node that contains it.
 */
function surfaceOf(element: Element): MenuTarget | null {
  const classes = element.classList;

  if (classes.contains(HANDLE_CLASS)) {
    const nodeId = attribute(element, HANDLE_NODE_ID);
    const portId = attribute(element, HANDLE_PORT_ID);
    if (nodeId !== null && portId !== null) return { surface: "port", nodeId, portId };
  }

  const control = attribute(element, CONTROL_KIND_ATTRIBUTE);
  if (control !== null && DEFAULT_HOLDING_CONTROLS.has(control)) {
    const nodeId = attribute(element, CONTROL_NODE_ATTRIBUTE);
    const panel = element.closest(`[${CONTROL_PANEL_ATTRIBUTE}]`);
    const panelId = panel === null ? null : attribute(panel, CONTROL_PANEL_ATTRIBUTE);
    if (nodeId !== null) return { surface: "control", nodeId, ...(panelId === null ? {} : { panelId }) };
  }

  const channel = attribute(element, CHANNEL_NAME_ATTRIBUTE);
  if (channel !== null) {
    const owner = element.closest(`[${PARAMETER_NODE_ATTRIBUTE}], .${NODE_CLASS}[${RF_ID}]`);
    const nodeId = owner === null ? null : (attribute(owner, PARAMETER_NODE_ATTRIBUTE) ?? attribute(owner, RF_ID));
    const reading = Number(attribute(element, CHANNEL_VALUE_ATTRIBUTE) ?? Number.NaN);
    if (nodeId !== null) {
      return { surface: "channel", nodeId, channel, ...(Number.isFinite(reading) ? { channelValue: reading } : {}) };
    }
  }

  const parameterKey = attribute(element, PARAMETER_KEY_ATTRIBUTE);
  if (parameterKey !== null) {
    // Either spelling of "this is whose parameter it is", NEAREST WINS — ours in a panel,
    // React Flow's own on the canvas (T1034). One `closest` rather than two lookups is
    // what makes it nearest: an embedded panel inside a node must win over the node.
    const owner = element.closest(`[${PARAMETER_NODE_ATTRIBUTE}], .${NODE_CLASS}[${RF_ID}]`);
    const nodeId =
      owner === null ? null : (attribute(owner, PARAMETER_NODE_ATTRIBUTE) ?? attribute(owner, RF_ID));
    // A parameter with no owning node is not addressable: the reset/publish commands
    // need the node id, so resolving without one would build a half-formed command.
    if (nodeId !== null) return { surface: "parameter", nodeId, parameterKey };
  }

  if (classes.contains(NODE_CLASS)) {
    const nodeId = attribute(element, RF_ID);
    if (nodeId !== null) return { surface: "node", nodeId };
  }

  if (classes.contains(EDGE_CLASS)) {
    const edgeId = attribute(element, RF_ID);
    if (edgeId !== null) return { surface: "edge", edgeId };
  }

  return null;
}

/**
 * Walks up from the clicked element to the nearest marked ancestor. Returns `null` when
 * nothing matched and no fallback surface was given — the caller then opens no menu.
 */
export function resolveMenuTarget(
  start: Element | null,
  options: ResolveMenuTargetOptions = {},
): MenuTarget | null {
  const { fallback = null, position, boundary = null } = options;
  const withPosition = (target: MenuTarget): MenuTarget =>
    position === undefined ? target : { ...target, position: { x: position.x, y: position.y } };

  let element: Element | null = start;
  while (element !== null) {
    const found = surfaceOf(element);
    if (found !== null) return withPosition(found);
    if (element === boundary) break;
    element = element.parentElement;
  }

  return fallback === null ? null : withPosition({ surface: fallback });
}
