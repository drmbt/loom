import { parseComponentNodeType } from "@domain/components/component-type.ts";
import { isNameOnlyInput } from "@domain/graph/source-references.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { incomingEdgesInOrder } from "./edge-order.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { previewablePort } from "./previewable.ts";
import { publishesValueChannels } from "@domain/types/node-definition.ts";
import { CONTROL_WIDGET_TYPES, isOneSocketInput, panelBoard, panelLayout, type PanelSection } from "@nodes/definitions/controls.ts";

/**
 * WHAT A NODE ACTUALLY OCCUPIES, IN GRAPH-SPACE PIXELS (T460, §V389).
 *
 * ## Why this exists
 *
 * Example layouts are authored as fixed offsets in `documents.ts` while the rendered box
 * is a CONSEQUENCE of the node — does it preview, how many port rows survive the
 * reference filter, is it a user-sized node. Author a 150px gap between two 178px nodes
 * and they overlap; that is not a subtle failure, and E25 shipped with three of them.
 *
 * §V389 is the rule that came out of it: where positions are authored, the geometry gets
 * a gate, so the next size change fails loudly instead of shipping crooked. The gate is
 * `src/examples/layout.test.ts`; this is the function it measures with.
 *
 * ## Why a model of a DOM lives in `src/domain/`
 *
 * It was in `src/editor/nodes/` until B84, when `layoutGraph` — which had been carrying its
 * own 180×100 GUESS — was made to ask it instead. Layout is domain code and runs headless
 * (the MCP server has no editor), so it cannot import the editor. This file only ever took
 * a `GraphNode` and a `NodeDefinition`, both domain types, and returned arithmetic; the
 * CSS it models is a fact about the app, not a dependency of this function. The measuring
 * spec (`src/tests/e2e/node-box.spec.ts`) is where the browser stays involved.
 *
 * ## It is a MODEL of a DOM, and that is a liability
 *
 * Every number below is read off `node-view.module.css` and the tokens it uses. A model
 * that drifts from what the browser paints makes the gate pass while the picture
 * overlaps — this bug again, one level up. So it is not trusted on arithmetic:
 * `node-box.spec.ts` measures REAL nodes in a REAL browser and fails if any of these
 * constants is wrong (§V339 — jsdom paints nothing, so the pinning cannot live in the
 * jsdom suite). Change the CSS, that spec goes red, and this file is what you fix.
 *
 * ## What it deliberately does NOT model
 *
 * The diagnostic message row and the agent-activity row are RUNTIME state, not document
 * state: the same document renders with and without them depending on whether something
 * failed or an agent is mid-edit. They can only make a node TALLER, so the gutter in the
 * layout gate is what covers them; pretending to predict them would be a fiction with a
 * number attached. The inference note (T1487b) is the same kind of row. `node-view.tsx`
 * marks each `data-runtime-row`, which is how the measuring spec leaves them out of the
 * box it compares (T1515b).
 *
 * The `.controls` region IS modelled since the live controls (T1388b, T1512b) — the graph
 * pane supplies `renderControls` (`control-bodies.tsx`) for exactly two kinds of node, and
 * both are document state: a widget's own control, and a Panel's live body, whose height
 * follows its members (`panelLayout`). One piece of it is not: the widget's "+ panel"
 * button, drawn only while the document's ONE Panel lacks that widget — a widget waiting to
 * be wired, not a laid-out document; the vertical gutter covers its one line. T1501b: a
 * Presets bank, a Layer and a Cue List draw the same "+ panel" under the same condition and
 * NOTHING else in this region (empty, it takes no room), so they stay unmodelled here for
 * the same reason — on a Panel, which is the laid-out state, they are exactly their box.
 */

/** `--node-width` in `node-view.module.css`. A node that was never resized is this wide. */
export const NODE_WIDTH = 178;

/**
 * `--pane-header-h`. NOT plus its hairline: `box-sizing: border-box` is global, so
 * `.title { height: 24px; border-bottom: 1px }` occupies 24px with the border inside it.
 * Adding the border was this model's first wrong answer, and the browser said so.
 */
const TITLE_HEIGHT = 24;

/**
 * `.preview` is `aspect-ratio: 16 / 9`, and since T540 it is `box-sizing: content-box`,
 * so the ratio governs the CONTENT box and the hairline below is ADDED to the derived
 * height rather than taken out of it.
 *
 * That inversion is the whole of T540: while the ratio governed the border box, the box
 * the preview system measures and fits its tile into was 16:(9 − hairline), so a 16:9
 * output letterboxed inside its own slot and left a band of ground down each side —
 * "an extra border inside the area of the preview". Measured in the real DOM at 178 px
 * node width: content 176 × 99, border box 176 × 100.
 *
 * T668, decided twice and the second decision is the owner's: the slot FOLLOWS the
 * project's configured resolution, as TouchDesigner's do — every slot that shows the
 * project's picture, which since T1168 is stated as the exception it always had
 * (`PLOT_PREVIEW_ASPECT`, just below). The first pass recorded
 * §V622 ("stay 16:9") from the measured re-author cost; the owner overruled with the
 * costs on the table — consistency across nodes and with the configured output wins.
 * A graph reflowing when the project's aspect changes is therefore an ACCEPTED COST,
 * not a bug: do not "fix" the reflow later as though it were an oversight — manual
 * re-layout after an aspect change is normal TD workflow, and the owner chose it.
 * §V621 still applies: this arithmetic is a compatibility surface, which is why the
 * aspect arrives as an ARGUMENT from the document's own settings rather than as a
 * constant two files have to agree on, and why the shipped square examples were
 * re-authored in the same change that landed it.
 *
 * The default below is for callers with no document in hand (a bare NumericSpec UI,
 * a node dragged before any project exists): the parent guides us initially, 16:9.
 */
export const DEFAULT_PREVIEW_ASPECT = 16 / 9;

/**
 * T1168 — THE ONE SLOT T668'S RULE DOES NOT GOVERN: A PLOT IS NOT THE PROJECT'S PICTURE.
 *
 * A node that publishes value channels draws a PLOT in its body, never a tile (the
 * composition root's `renderPreview` takes that branch first, before the sink branch, so
 * Analyze — a declared sink that also publishes channels — is a plot too). The plot is
 * plain DOM whose size is a property of the plot; the output resolution has nothing to say
 * about it. Following the project's aspect made a value node 148px tall in a 1280x720
 * document and 362px in a 720x1280 one, around a curve that stayed 78px either way — the
 * owner's "super tall and stretched, lots of empty space in them now" on E56, the first
 * portrait example (T1159). Latent since T344: nothing else shipped was portrait.
 *
 * It is a CONSTANT rather than the plot's measured content because a plot's own height is
 * runtime state — an unsampled Mouse renders the empty state, a sampled one renders three
 * readings — and this model must predict a node's box from the DOCUMENT alone, for the same
 * reason it does not model the diagnostic row. 16:9 is the shape the plot was designed
 * against and the value every shipped example already lays out with, so the fix moves no
 * landscape document by a pixel; `value-plot.tsx`'s own rule is the other half of the
 * argument — two plots must agree about what full height means, and an aspect that moved
 * with the project would make that a per-document answer.
 *
 * Equal to `DEFAULT_PREVIEW_ASPECT` today and NOT the same fact: that one means "no
 * document in hand", this one means "this body is not showing the project's output". The
 * CSS half is `.plotSlot` in `node-view.module.css`; `node-box.spec.ts` measures both.
 */
export const PLOT_PREVIEW_ASPECT = 16 / 9;

/** The ONE derivation (§V437) from settings to slot aspect — every surface asks this. */
export function previewAspectOf(settings: {
  readonly outputResolution: { readonly width: number; readonly height: number };
}): number {
  const { width, height } = settings.outputResolution;
  return width > 0 && height > 0 ? width / height : DEFAULT_PREVIEW_ASPECT;
}

/** `.preview` — the hairline BELOW the tile, outside the ratio since T540. */
const PREVIEW_BORDER = 1;

/** `.ports` — `padding: var(--space-2) 0`, top and bottom. */
const PORTS_PADDING = 4 * 2;

/** `.port` — a fixed `height: 14px`. */
const PORT_ROW_HEIGHT = 14;

/** `.column` — `gap: var(--space-1)` between rows in one column. */
const PORT_ROW_GAP = 2;

/** `.node` — a 1px border on every side, and `box-sizing: border-box` is global. */
const NODE_BORDER = 1;

/**
 * `.node[data-component]` — `border-top: 2px solid var(--component)` (T603's mark of a
 * linked instance) REPLACES the 1px top hairline, so an instance is one pixel taller than
 * the same ports on a plain node. T1515b: found the first time the measuring spec sized an
 * instance from its definition at all — 164 modelled, 165 rendered, on every one shipped.
 */
const COMPONENT_BORDER_TOP = 2;

/**
 * T1512b — THE `.controls` REGION: a widget's own control, or a Panel's live body.
 *
 * Read off `node-view.module.css` (`.controls`), `control-widget.module.css` (`.node`
 * size) and `panel-surface.module.css` (`.body`, `.stack`), and pinned like every other
 * number here by `node-box.spec.ts`, which measures E81's widgets and Panel. The text rows
 * inherit the node's `line-height: var(--lh-ui)` (1.35), so they are FRACTIONAL: 13.5 at
 * `--fs-micro`, 14.85 at `--fs-meta`. The browser sums them unrounded and `offsetHeight`
 * rounds the node once, so this model does the same (`nodeBox` rounds at the end).
 */
const LINE_HEIGHT = 1.35;
const MICRO_LINE = 10 * LINE_HEIGHT;
const META_LINE = 11 * LINE_HEIGHT;

/** `.controls` — `padding: var(--space-2) var(--space-3)` and a hairline below. */
const CONTROLS_PADDING = 4 * 2;
const CONTROLS_BORDER = 1;
/** The width a control gets: the node's content box less `.controls`' side padding. */
const CONTROLS_CONTENT_WIDTH = NODE_WIDTH - NODE_BORDER * 2 - 6 * 2;

/**
 * T1518b — the same content width for a node as drawn, resized or not: what the Panel's
 * canvas board scales its cells to, so the board's caption fit (`board-fit.ts`) sizes type
 * for the cell the browser will actually draw.
 */
export function controlsContentWidth(node: Pick<GraphNode, "size">): number {
  return (node.size?.width ?? NODE_WIDTH) - NODE_BORDER * 2 - 6 * 2;
}

/** `.widget` — `gap: var(--space-2)` between its caption row and its control. */
const WIDGET_GAP = 4;
/** `.track` — `height: var(--space-6)`. */
const TRACK_HEIGHT = 16;
/** `.toggle`/`.button` — `padding: var(--space-2) …` and a hairline all round. */
const PRESSABLE_CHROME = 4 * 2 + 1 * 2;
/** `.switch` — `height: var(--space-6)`, the tallest thing in a toggle. */
const SWITCH_HEIGHT = 16;

/**
 * One widget at the node size (`ControlWidget size="node"`), the same wherever it is drawn
 * on the canvas: in its own node, or stacked in a Panel's body — both are the `.controls`
 * content width wide.
 */
function widgetBodyHeight(type: string): number {
  switch (type) {
    case "slider":
      return MICRO_LINE + WIDGET_GAP + TRACK_HEIGHT;
    case "toggle":
      return PRESSABLE_CHROME + Math.max(MICRO_LINE, SWITCH_HEIGHT);
    case "button":
      return PRESSABLE_CHROME + MICRO_LINE;
    case "xyPad":
      // `.pad` is `aspect-ratio: 1` at the full width.
      return MICRO_LINE + WIDGET_GAP + CONTROLS_CONTENT_WIDTH;
    default:
      return 0;
  }
}

/** `.body` — `gap: var(--space-2)` between the title and each row. */
const PANEL_BODY_GAP = 4;
/** `.stack` — `gap: var(--space-3)` between widgets in one row. */
const PANEL_STACK_GAP = 6;
/** `.heading` — `margin-top: var(--space-3)`, one `--fs-micro` line. */
const PANEL_HEADING_HEIGHT = 6 + MICRO_LINE;
/**
 * `.hint` — `PANEL_EMPTY_HINT` wraps to TWO `--fs-micro` lines at this width (measured).
 * Measured rather than derived because a wrap is a fact about the font; the spec pins it.
 */
const PANEL_HINT_HEIGHT = 2 * MICRO_LINE;

function panelRowHeight(row: PanelSection): number {
  if (row.kind === "heading") return PANEL_HEADING_HEIGHT;
  // An override's `> note` is one `--fs-meta` line; a longer one wraps, which this does
  // not predict (the same reason the hint is measured) — the gutter covers it.
  if (row.kind !== "widgets") return META_LINE;
  const cells = row.cells.map((cell) => (cell.kind === "widget" ? widgetBodyHeight(cell.node.type) : META_LINE));
  return cells.reduce((sum, height) => sum + height, 0) + PANEL_STACK_GAP * Math.max(0, cells.length - 1);
}

/**
 * T1516b — a board Panel's body: the board scaled to the `.controls` content width with
 * square cells (`panel-board.module.css` `.canvas`, `aspect-ratio: columns / rows`), so its
 * height is that width × rows / columns — the canvas cell is `CONTROLS_CONTENT_WIDTH /
 * columns` and the board is `rows` of them. Fractional, like the text rows above.
 */
function panelBoardHeight(rows: number, columns: number): number {
  return (CONTROLS_CONTENT_WIDTH * rows) / columns;
}

/**
 * The `.controls` region's height for this node, or 0 when it draws none — which is every
 * node that is neither a widget nor a Panel. A Panel's body is its title and its board as
 * `panelBoard` derives it (T1516b) — or, laid out by the legacy override text, its rows as
 * `panelLayout` derives them — the SAME derivation the body renders from, so a widget wired
 * into a Panel makes the Panel taller here exactly as it does on the canvas.
 */
export function nodeControlsHeight(node: GraphNode, graph?: Pick<GraphDocument, "nodes" | "edges">): number {
  let content: number;
  if (CONTROL_WIDGET_TYPES.has(node.type)) {
    content = widgetBodyHeight(node.type);
  } else if (node.type === "panel") {
    const board = graph === undefined ? null : panelBoard(graph, node);
    const rows = graph === undefined || board !== null ? [] : panelLayout(graph, node).rows;
    const body =
      board !== null && board.items.length > 0
        ? [panelBoardHeight(board.rows, board.columns)]
        : rows.length === 0
          ? [PANEL_HINT_HEIGHT]
          : rows.map(panelRowHeight);
    content = META_LINE + body.reduce((sum, height) => sum + PANEL_BODY_GAP + height, 0);
  } else {
    return 0;
  }
  return CONTROLS_PADDING + content + CONTROLS_BORDER;
}

export interface NodeBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Does this node render a preview tile?
 *
 * Exactly what `node-view.tsx` renders, because both read the SAME list of previewable
 * port kinds (T532): a previewable output, a value node (its plot), or a declared SINK,
 * which consumes rather than produces and still owns a target (§V25).
 *
 * This model is what every shipped example's overlap gate is measured against, so a kind
 * that grows a preview here grows the node by ~100px — which is what happened the day
 * pointsets started previewing, and what would silently NOT have happened for geometry if
 * this had kept its own copy of the list (§V316, §V437).
 */
export function nodeHasPreview(node: GraphNode, definition: NodeDefinition | undefined): boolean {
  if (node.ui?.preview === false) return false;
  if (definition === undefined) return false;
  // T532: the ONE list, shared with the slot that renders it and the compiler that fills
  // it. This used to enumerate kinds itself and geometry was missing from every copy —
  // so a node that grew a preview would have kept its old modelled height and every
  // shipped example's overlap gate would have gone green over a layout that had moved.
  // T438 (§V316): channel publication is declared, never read off the category shelf.
  return (
    previewablePort(definition.outputs) !== undefined ||
    publishesValueChannels(definition) ||
    definition.sink === true
  );
}


/**
 * Port ROWS, which is the taller of the two columns — they sit side by side in a grid.
 *
 * Inputs fed ONLY by a source REFERENCE are filtered out of the rendered list (T457/§V387:
 * a socket the user cannot connect does not render; B233: one that also takes a wire
 * does), so counting the manifest's inputs would overstate the height of exactly the
 * nodes E25 is full of — `render`, `geometry`, `camera` — every one of which takes its
 * scene, material and lights by name.
 */
export function nodePortRows(
  node: GraphNode,
  definition: NodeDefinition | undefined,
  /**
   * T695: the document, where one is in hand. A variadic input renders one row per edge
   * landing on it PLUS a spare, so a node's height depends on how it is wired — the first
   * thing in this model that does. Omitting it models an UNWIRED node, which is correct
   * for a probe (`placeFree` sizing a node that does not exist yet) and an undercount for
   * anything else; `node-box.spec.ts` measures the real DOM and says so if a caller that
   * had a graph did not pass it.
   */
  graph?: Pick<GraphDocument, "edges">,
): number {
  if (definition === undefined) return 0;
  const visible = definition.inputs.filter((port) => !isNameOnlyInput(node.type, port.id));
  const inputs = visible.reduce(
    (rows, port) =>
      rows +
      // T1518b: a one-socket variadic input (the Panel's Controls) is one row however wired.
      (port.variadic === true && graph !== undefined && !isOneSocketInput(node.type, port.id)
        ? incomingEdgesInOrder(graph, node.id, port.id).length + 1
        : 1),
    0,
  );
  return Math.max(inputs, definition.outputs.length);
}

/** The box this node occupies, at its authored position. */
export function nodeBox(
  node: GraphNode,
  definition: NodeDefinition | undefined,
  /** From `previewAspectOf(settings)` wherever a document is in hand (T668). */
  previewAspect: number = DEFAULT_PREVIEW_ASPECT,
  /** T695 — see `nodePortRows`; T1512b — a Panel's body follows its wired members. Pass it wherever the graph is in hand. */
  graph?: Pick<GraphDocument, "nodes" | "edges">,
): NodeBox {
  // A node the user resized fills the box they dragged (T208/§V116) — the document says
  // so outright, and nothing derived can override a stated size.
  if (node.size !== undefined) {
    return { x: node.position.x, y: node.position.y, width: node.size.width, height: node.size.height };
  }

  const contentWidth = NODE_WIDTH - NODE_BORDER * 2;
  let height =
    // The same predicate `node-view.tsx` sets `data-component` on.
    (parseComponentNodeType(node.type) === null ? NODE_BORDER : COMPONENT_BORDER_TOP) + NODE_BORDER + TITLE_HEIGHT;
  if (nodeHasPreview(node, definition)) {
    // T1168: a plot's slot is a constant, checked FIRST — `publishesValueChannels` is the
    // same predicate, in the same order, that `renderPreview` and `node-view.tsx` use, so
    // a node that is both a sink and a value source (Analyze) is a plot in all three.
    const aspect = publishesValueChannels(definition) ? PLOT_PREVIEW_ASPECT : previewAspect;
    height += Math.floor(contentWidth / aspect) + PREVIEW_BORDER;
  }
  const rows = nodePortRows(node, definition, graph);
  height += nodeControlsHeight(node, graph);
  height += PORTS_PADDING + (rows === 0 ? 0 : rows * PORT_ROW_HEIGHT + (rows - 1) * PORT_ROW_GAP);

  // Only the `.controls` region is fractional; `offsetHeight` rounds the node once.
  return { x: node.position.x, y: node.position.y, width: NODE_WIDTH, height: Math.round(height) };
}

/** Do two boxes share any area? Touching edges do not count as overlapping. */
export function boxesOverlap(a: NodeBox, b: NodeBox): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/** Signed gap between two boxes on each axis. Negative means they interpenetrate. */
export function boxGap(a: NodeBox, b: NodeBox): { x: number; y: number } {
  return {
    x: Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width),
    y: Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height),
  };
}
