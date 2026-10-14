// VN118: manifest.json as PROTOCOL.md v1 defines it.
export interface ManifestInput {
  readonly id: string;
  readonly label: string;
  readonly mediaKey: string;
}

export interface ManifestParam {
  /** The Loom node name; the host writes the value to that node's value parameter. */
  readonly id: string;
  /** At most 31 bytes (AE param name limit). */
  readonly label: string;
  readonly type: "float" | "bool";
  readonly min?: number;
  readonly max?: number;
  readonly default: number | boolean;
  /** Not in PROTOCOL.md v1: the slider's step (0 = continuous). Additive; an effect may ignore it. */
  readonly step?: number;
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
