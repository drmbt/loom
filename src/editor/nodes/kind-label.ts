import { roleOf } from "@domain/graph/node-kinds.ts";

/**
 * A NODE'S KIND STAYS LEGIBLE AT LOW ZOOM (T1597b).
 *
 * The owner: "it's pretty damn hard that we need to zoom in and figure out, ah okay, this
 * is this kind of operator". Measured: a node's header text is 11 px, so at 60 % it is
 * 6.6 px and at 35 % under 4. And E79 Crucible, 79 nodes, OPENS at 15 %, where a node is
 * 27 px wide and nothing on it can be read at all. Naming a node `kernel_joints` does not
 * help someone who cannot read the name.
 *
 * So below a zoom threshold every node carries one small label, its kind and then the
 * rest of its name, drawn at a size that does not shrink with the canvas.
 *
 * ## Where it stands: on the line under the header, growing up (B258)
 *
 * ONE RULE FOR EVERY NODE: the label never enters what the node shows. Below the header
 * is a value's readout, a plot, a picture, a Panel's controls; the label stands on the
 * line between the two and grows UPWARD. It takes the header band, whose name it
 * replaces, and what does not fit there goes out of the box, into the gutter above.
 *
 * The first version grew DOWN from the top edge, inside the node, and the owner saw both
 * halves of what that does: "value operators get covered by the label while previews
 * overlap the thing". A value node's readout is DOM right under the header, so the label
 * lay on it. A live preview is not in the node at all: one canvas over the whole pane
 * paints every tile (`.previewSurface`), above everything inside any node, so the tile
 * cut the label off, and at 15 % hid it completely under every live tile. Nothing drawn
 * in a node can be put on top of a tile, so "always on top" was never available: the
 * only place a label is neither covering nor covered is where there is no content.
 *
 * Room, in the node's own px: the header band is 23 above the hairline the label stands
 * on, and the layout rule keeps 36 clear above every node (§V389). That is 59 × zoom on
 * screen and the label is 13.2 px tall, so down to 22.4 % it reaches no other node in ANY
 * layout that passes the rule. The shipped ones have far more (the tightest stack in E79
 * has 86 px above a node, in E82 70) and nothing touches at 15 % either: measured, 0 of
 * 79 and 0 of 23. Below 22.4 %, in a layout packed to the minimum, the top of a label
 * reaches into the bottom of the node above: at 15 % by 29 of its px (4.4 on screen),
 * which is that node's port row and under 1 px of what is over it. The label is NOT
 * shrunk to prevent that. What would fit at 15 % is 7.4 px text, and under 7.7 px is the
 * size at which the header was judged unreadable and this label was built to replace it.
 *
 * ## One calm line, and no pile-up, by construction
 *
 * Sideways the label is clipped to its node's WIDTH, so it cannot run over a neighbour
 * beside it. Upward it has the room above: the same arithmetic keeps two labels apart
 * down to the same 22.4 %. No collision test, nothing to tune. As the node gets narrower
 * on screen the label shows less:
 *
 *     zoom >= 0.70          off    the header is readable; nothing is added
 *     0.45 <= zoom < 0.70   name   kernel_joints        kind, then the rest of the name
 *     0.09 <= zoom < 0.45   kind   kernel               the kind alone
 *     zoom <  0.09          none   a node is under 16 px wide: no word fits
 *
 * The role goes first because it is the longer part and the kind is the question that was
 * asked. In the `kind` tier a long kind is clipped at the node's edge (`geome`, `mater`):
 * the start of the word is what identifies it, and four or five letters of a kind is still
 * an answer where the alternative is a blank box.
 *
 * The kind comes from the node's TYPE, not from its name, so the label is right for every
 * node today, including the 3,297 shipped ones still named `dye1` or `lamp`.
 *
 * ## No layout cost
 *
 * The label is absolutely positioned and takes no part in the node's box, inside it or
 * above it. The node-box model, the layout gate (§V389) and every authored position are
 * unaffected.
 *
 * ## No React work while the canvas moves, and why the zoom is WRITTEN, not inherited
 *
 * A label that does not shrink has to be told the zoom. Three ways were measured in
 * Chromium on E79 (79 nodes, 1,802 elements under them), as the cost of ONE zoom change
 * with style and layout brought up to date:
 *
 *     a custom property on the nodes' common ancestor     4.23 ms
 *     the property written on each label                  0.35 ms
 *     (a property on a separate layer holding only labels 0.12 ms)
 *
 * The first is the obvious one and it is twelve times the second: a custom property is
 * inherited, so changing it on an ancestor makes the browser restyle every element under
 * every node, on every frame of a zoom, a quarter of the frame gone on this graph and all
 * of it on one four times the size. So the registry below writes the zoom on each label
 * element itself. A separate layer is cheaper still, but its labels would have to be
 * positioned from the canvas's node list (React work on every frame of a drag), would
 * paint above every node instead of with their own, and would not be culled with them.
 *
 * Nothing here renders. One subscription to the canvas's transform compares one number
 * per event, and a pan changes no number. Above the threshold no label is written to at
 * all: the tier is one attribute on the canvas root, written only when a threshold is
 * crossed, and the stylesheet does the rest.
 */

/** Below this the header's own 11 px text is under 7.7 px on screen, and the label takes over. */
export const KIND_LABEL_ZOOM = 0.7;
/** Below this `kind_role` no longer fits a typical node's width, and the role is dropped. */
export const KIND_LABEL_ROLE_ZOOM = 0.45;
/** Below this a 178 px node is under 16 px on screen: not even three letters fit. */
export const KIND_LABEL_NONE_ZOOM = 0.09;

/** The attribute on the canvas root the stylesheet reads: `name` or `kind`; absent otherwise. */
export const KIND_LABEL_TIER_ATTRIBUTE = "data-kind-labels";
/** The custom property a label is told the zoom through. */
export const KIND_LABEL_ZOOM_PROPERTY = "--kind-label-zoom";

export type KindLabelTier = "off" | "name" | "kind" | "none";

export function kindLabelTier(zoom: number): KindLabelTier {
  // `!(zoom < x)` so a zoom that is not a number reads as "off", never as "show everything".
  if (!(zoom < KIND_LABEL_ZOOM)) return "off";
  if (zoom >= KIND_LABEL_ROLE_ZOOM) return "name";
  return zoom >= KIND_LABEL_NONE_ZOOM ? "kind" : "none";
}

export interface KindLabelParts {
  /** The node's kind, from its type. Always shown while the label is. */
  readonly kind: string;
  /** What follows it: `_joints`, the `1` of an auto-name, the whole of a name without its kind, or nothing. */
  readonly rest: string;
  /** True when `rest` continues the kind (`kernel` + `_joints`); false when it is a separate word. */
  readonly joined: boolean;
}

/**
 * What the label says for a node of this kind with this name.
 *
 * A name that carries its kind is shown AS the name, split where the kind ends
 * (`kernel` + `_joints`, `blur` + `1`). A name that does not is shown after the kind, as
 * a word of its own (`feedback` then `dye1`): the kind is still the first thing read, and
 * the name is not altered or cut. An unnamed node is its kind alone.
 */
export function kindLabelParts(name: string | undefined, kind: string): KindLabelParts {
  if (name === undefined) return { kind, rest: "", joined: true };
  if (roleOf(name, kind) === null) return { kind, rest: name, joined: false };
  return { kind, rest: name.slice(kind.length), joined: true };
}

export interface KindLabelRegistry {
  /**
   * A label element joins the canvas; the function returned takes it out again.
   *
   * B258: the timing readout above a node joins too. The label now rises out of the top
   * of the node, which is where the readout stands, so it has to be told the same zoom to
   * move clear by the same amount (`node-timing-overlay.module.css`).
   */
  register(label: HTMLElement): () => void;
  /** The canvas root the tier attribute is written on, or `null` when the canvas is gone. */
  attach(root: HTMLElement | null): void;
  /** The canvas's zoom, as often as the canvas likes: only a CHANGE does any work. */
  apply(zoom: number): void;
}

/** One per canvas: two canvases on one document zoom separately (§V97). */
export function createKindLabelRegistry(): KindLabelRegistry {
  const labels = new Set<HTMLElement>();
  let root: HTMLElement | null = null;
  let zoom = Number.NaN;
  let tier: KindLabelTier = "off";

  const shown = (): boolean => tier === "name" || tier === "kind";
  const tell = (label: HTMLElement): void => label.style.setProperty(KIND_LABEL_ZOOM_PROPERTY, String(zoom));
  const writeTier = (): void => {
    if (root === null) return;
    if (shown()) root.setAttribute(KIND_LABEL_TIER_ATTRIBUTE, tier);
    else root.removeAttribute(KIND_LABEL_TIER_ATTRIBUTE);
  };

  return {
    register(label) {
      labels.add(label);
      // A node that mounts while the labels are showing (scrolled in, just added) must not
      // wait for the next zoom step to learn the size it is drawn at.
      if (shown()) tell(label);
      return () => {
        labels.delete(label);
      };
    },
    attach(next) {
      if (next === root) return;
      root?.removeAttribute(KIND_LABEL_TIER_ATTRIBUTE);
      root = next;
      writeTier();
    },
    apply(next) {
      // A pan, and every other canvas event that is not a zoom, ends here.
      if (next === zoom) return;
      zoom = next;
      const nextTier = kindLabelTier(zoom);
      if (nextTier !== tier) {
        tier = nextTier;
        writeTier();
      }
      if (shown()) for (const label of labels) tell(label);
    },
  };
}
