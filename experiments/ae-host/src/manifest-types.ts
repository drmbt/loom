// VN118: manifest.json as PROTOCOL.md v1 defines it (VN122: amended 2026-10-13 with popup
// params, `<node>.<parameter>` ids and input `defaultLayer`).
export interface ManifestInput {
  readonly id: string;
  readonly label: string;
  readonly mediaKey: string;
  /** The comp layer index the effect points this input at when it is applied (optional). */
  readonly defaultLayer?: number;
}

export interface ManifestPopupOption {
  readonly label: string;
  /** The number the effect sends when this option is chosen. */
  readonly value: number;
}

export interface ManifestParam {
  /**
   * A Loom node name (the host writes that node's value parameter: `value` on a slider, `on`
   * on a toggle), or `<node>.<parameter>` (the host writes that parameter; a component
   * instance's published parameter reaches the internal parameters it drives). The node part
   * matches a node's name, else its id.
   */
  readonly id: string;
  /** At most 31 bytes (AE param name limit). */
  readonly label: string;
  readonly type: "float" | "bool" | "popup";
  readonly min?: number;
  readonly max?: number;
  readonly default: number | boolean;
  /** Not in PROTOCOL.md v1: the slider's step (0 = continuous). Additive; an effect may ignore it. */
  readonly step?: number;
  /** `popup` only: the choices, in display order. */
  readonly options?: readonly ManifestPopupOption[];
  readonly group?: string;
  readonly hidden?: boolean;
}

export interface Manifest {
  readonly protocol: 1;
  readonly name: string;
  readonly project: string;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly defaultSize: readonly [number, number];
  readonly inputs: readonly ManifestInput[];
  readonly params: readonly ManifestParam[];
}

export const PROTOCOL_VERSION = 1;
