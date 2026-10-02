import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { isLayerBlend, layerShader } from "../shaders/layer.wgsl.ts";
import type { LayerBlend } from "../shaders/layer.wgsl.ts";

/**
 * Layer — one picture on the performance stack (T1498b, §T1398b; the owner's rulings 9–11).
 *
 * The stack reads bottom to top through `below`: input → layer → layer → FX → mapping →
 * Window Out. Each layer puts one PICTURE on the stack — a look, usually a component
 * instance, or any node — by wire or by NAME, and fades it with `opacity`.
 *
 * ## Off is bypass, and bypass costs nothing
 *
 * `below` is the FIRST input, so the node's bypass flag (`bypassPassthroughPorts`) wires the
 * stack straight through. The picture's input is then read by nothing, so the compiler
 * prunes the picture's whole chain: a layer switched off emits no pass, and neither does
 * the look it names. That is why this is a new node and not Over (the design's §7.5): the
 * composite family puts its FRONT first, so bypassing an Over would pass the picture and
 * drop the stack. On/off is structural — it recompiles the region — so an expression
 * cannot drive it (§T1014); commands, Panels and presets set it.
 *
 * The preset seam (§T1496b, the design's §4.4 step 5): a preset's `on` map is applied as
 * `setNodeUi { bypassed: !on }` on this node inside the recall's one patch, so a layer's
 * on/off is undone with the rest of the recall. Nothing here reads presets.
 *
 * ## Fade is opacity
 *
 * A uniform, so it follows an expression, a widget or a beat every frame. At 0 the stack
 * shows through unchanged in every blend (the mix in `layer.wgsl.ts`), but the picture
 * still cooks; switching the layer off is what makes it free.
 *
 * ## The picture by name
 *
 * `picture` is a source reference like Window Out's Source (§T1391b, T350): the compiler
 * synthesizes the edge a wire would have made, so a named picture and a wired one compile
 * to the same plan, and ONLY the named node cooks — changing the name from one look to
 * another is one parameter write that moves which chain the plan reaches.
 *
 * ## The picture by wire, and both at once (B233)
 *
 * `wire: true`: the input takes a wire in the app as well (a socket, `connect` allowed) —
 * it carries a texture, and the name is the convenience. With both a wire and a name THE
 * WIRE WINS and the name is dormant: it cooks nothing and draws no line, and disconnecting
 * the wire returns the layer to the look it names. The rule is stated once, in
 * `domain/graph/source-references.ts`.
 */
export const layerNode: NodeDefinition = {
  type: "layer",
  version: 1,
  title: "Layer",
  category: "composite",
  description:
    "Puts a picture on the stack below it, by wire or by name, faded by Opacity. Bypass switches the layer off: the stack passes through and the picture stops rendering.",
  tags: ["layer", "look", "stack", "perform", "fade", "opacity", "blend", "mix"],
  inputs: [
    {
      id: "below",
      label: "Below",
      type: RGBA_TEXTURE,
      description: "The stack under this layer. First, so bypassing the layer passes it through. Resolution and format come from here.",
    },
    {
      id: "picture",
      label: "Picture",
      type: RGBA_TEXTURE,
      description: "What this layer shows: a look, or any node. Wire it, or name it in Picture. A wire wins over the name.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  sourceReferences: [{ parameter: "picture", input: "picture", wire: true }],
  parameters: {
    picture: {
      type: "string",
      label: "Picture (a look, or any node)",
      default: "",
      description:
        "A node to show, by name, when nothing is wired into Picture. A wire wins over the name. Only the node shown renders.",
    },
    opacity: {
      type: "number",
      label: "Opacity",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      description: "The layer's fade. At 0 the stack below shows unchanged; the picture still renders until the layer is bypassed.",
    },
    blend: {
      type: "enum",
      label: "Blend",
      default: "over",
      options: [
        { value: "over", label: "Over" },
        { value: "add", label: "Add" },
        { value: "screen", label: "Screen" },
        { value: "multiply", label: "Multiply" },
        { value: "replace", label: "Replace (wet/dry)" },
      ],
      // §V141: selects the shader, so it recompiles rather than branching per pixel.
      compileTime: true,
      description:
        "How the picture meets the stack: the same maths as the Composite node. Replace shows the picture itself, so Opacity becomes the wet/dry of an effect layer.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "below" },
  formatPolicy: { kind: "inherit", input: "below" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const below = inputs["below"];
    const picture = inputs["picture"];
    if (target === undefined || below === undefined || picture === undefined) {
      const what =
        target === undefined
          ? 'output port "out"'
          : below === undefined
            ? 'input port "below"'
            : 'input port "picture"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const blend: LayerBlend = isLayerBlend(parameters["blend"]) ? parameters["blend"] : "over";
    const pass: EffectPassDescriptor = {
      kind: "effect",
      // The blend is the structure (§V5); opacity is the uniform that moves.
      id: `${nodeId}:layer:${blend}`,
      shader: layerShader(blend),
      target,
      textures: [
        { binding: "belowTexture", resourceId: below.resource },
        { binding: "pictureTexture", resourceId: picture.resource },
      ],
      samplers: [{ binding: "inputSampler", resourceId: below.sampler }],
      uniformBinding: "params",
      uniforms: { opacity: readNumber(parameters, "opacity", 1) },
      nodeId,
      label: `Layer (${blend})`,
    };
    return { passes: [pass] };
  },
};
