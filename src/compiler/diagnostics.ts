import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { DiagnosticSeverity, RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import { leavesPlanUsable } from "../domain/diagnostics/classes.ts";

/**
 * Diagnostic codes emitted by the graph compiler (§I.diag, T30).
 *
 * Stable strings: the problems tab, the agent tools and the tests all key off them, so a
 * code is renamed only with the same care as a public API. Every compiler failure surfaces
 * as one of these rather than as a thrown error — a broken graph must still produce a
 * report the user can act on (§V9).
 */
export const CompilerDiagnosticCode = {
  unknownNodeType: "compiler/unknown-node-type",
  definitionVersion: "compiler/definition-version",
  edgeEndpointMissing: "compiler/edge-endpoint-missing",
  portMissing: "compiler/port-missing",
  portIncompatible: "compiler/port-incompatible",
  portOccupied: "compiler/port-occupied",
  inputMissing: "compiler/input-missing",
  cycle: "compiler/cycle",
  noActiveSinks: "compiler/no-active-sinks",
  sinkUnknown: "compiler/sink-unknown",
  resolutionInputMissing: "compiler/resolution-input-missing",
  resolutionCustom: "compiler/resolution-custom",
  resolutionClamped: "compiler/resolution-clamped",
  formatInputMissing: "compiler/format-input-missing",
  formatUnsupported: "compiler/format-unsupported",
  formatDepthOnColor: "compiler/format-depth-on-color",
  formatNoFallback: "compiler/format-no-fallback",
  colorSpaceMismatch: "compiler/color-space-mismatch",
  /** T375/B47: a sink target format the present blit cannot show as the graph made it. */
  sinkFormatUndisplayable: "compiler/sink-format-undisplayable",
  nodeNoPasses: "compiler/node-no-passes",
  nodeCompileFailed: "compiler/node-compile-failed",
  passInvalid: "compiler/pass-invalid",
  memoryBudget: "compiler/memory-budget",
  scratchInvalid: "compiler/scratch-invalid",
  resolutionParameter: "compiler/resolution-parameter",
  bindingUnfilterable: "compiler/binding-unfilterable",
  /** A pass binds more of something than the device allows (T328, B33, §V24). */
  bindingBudget: "compiler/binding-budget",
  /** Component flattening (T134, T135, §V82, §V83). */
  componentRecursion: "compiler/component-recursion",
  componentMissing: "compiler/component-missing",
  componentPortUnresolved: "compiler/component-port-unresolved",
  componentIdCollision: "compiler/component-id-collision",
  componentParameterConflict: "compiler/component-parameter-conflict",
  /** A passthrough (Null) chain that reaches no producer (T223, §V130). */
  passthroughUnconnected: "compiler/passthrough-unconnected",
  /** T356: bypass on a converter — no input matches the output's kind; muted instead. */
  bypassIncoherent: "compiler/bypass-incoherent",
  /** T350: a source reference naming no existing node (or one with no output). */
  sourceReferenceMissing: "compiler/source-reference-missing",
  /** T350: a source reference AND a wired input on the same loop — one truth. */
  sourceReferenceAmbiguous: "compiler/source-reference-ambiguous",
  /**
   * VN35: a BARE name (`op()` or a source reference) that reaches into a component instance
   * the referring node is not in. It binds, first-wins, as it always has; the path that
   * names the intended copy is the fix (proposal 01 §2.2).
   */
  referenceCrossScope: "compiler/reference-cross-scope",
  /**
   * VN36: a `parent()` read with no component to reach: on a root node, past the outermost
   * component, or naming an instance with no name. The parameter keeps its static (§V108).
   */
  parentReferenceNoParent: "compiler/parent-reference-no-parent",
  /** VN36: a `parent()` read of a key the component's page does not publish (§V81). */
  parentReferenceUnknownKey: "compiler/parent-reference-unknown-key",
  /**
   * T546: more than one renderer frames itself with this camera, so "what the renderer
   * sees" has no single answer and the preview shows the stock reference scene. INFO, not
   * a warning: sharing one camera between renderers is a normal thing to do, and the only
   * consequence is which picture the camera's own preview can show.
   */
  cameraPreviewAmbiguous: "compiler/camera-preview-ambiguous",
  /**
   * T387: substeps were asked for and are NOT being run, with the reason and the parameter
   * named (§V288). A silently-ignored substep count is the worst version of this — the
   * picture is plausible and the simulation is fifty times slower than the number says.
   */
  substepsRefused: "compiler/substeps-refused",
  /**
   * B263: a pass's WGSL divides the high half of a 32-bit value by a constant, which Apple
   * GPUs get wrong. A WARNING on the author's node and line: the code is valid and is right
   * elsewhere, so nothing is refused and nothing is rewritten (`wgsl-high-half.ts`).
   */
  wgslHighHalfDivide: "compiler/wgsl-high-half-divide",
} as const;

export type CompilerDiagnosticCodeValue =
  (typeof CompilerDiagnosticCode)[keyof typeof CompilerDiagnosticCode];

export interface DiagnosticDetails {
  nodeId?: NodeId;
  portId?: PortId;
  suggestion?: string;
}

export function compilerDiagnostic(
  severity: DiagnosticSeverity,
  code: CompilerDiagnosticCodeValue,
  message: string,
  details: DiagnosticDetails = {},
): RuntimeDiagnostic {
  return {
    severity,
    code,
    message,
    ...(details.nodeId === undefined ? {} : { nodeId: details.nodeId }),
    ...(details.portId === undefined ? {} : { portId: details.portId }),
    ...(details.suggestion === undefined ? {} : { suggestion: details.suggestion }),
  };
}

/**
 * A compilation is usable only when nothing failed outright; warnings are reported, not fatal.
 *
 * §T1641b: nor is an error the class table marks `local` (`leavesPlanUsable`). Such a
 * finding is a stored thing that can never take effect (an expression calling a function the
 * grammar lacks, §B262): it is inert, its stated fallback is in effect, and every pass is
 * whole. It is an ERROR wherever it is read, and the picture keeps rendering: the frame loop
 * installs only a plan that is `ok`, so without this a document that rendered yesterday with
 * a warning would open black the day the report got louder.
 */
export function hasError(diagnostics: ReadonlyArray<RuntimeDiagnostic>): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error" && !leavesPlanUsable(diagnostic.code));
}
