/**
 * T1588b — an OBJECT'S transform, composed on the CPU (docs/mesh-instancing-design-2026-10-05.md, D5/D6).
 *
 * The one statement of order every pass draws by:
 *
 *     Object = T(translate) · T(pivot) · R(rotate) · S(scale) · T(−pivot)
 *
 * so a point p lands at `translate + pivot + R · (S ∘ (p − pivot))`: scale, then turn, then
 * translate, the pivot being the fixed point of the scale and the turn. That is the Transform
 * node's own arithmetic (`pointTransformWgsl`) and the order TouchDesigner lists first
 * (`T * R * S * Position`).
 *
 * THE TURN CONVENTION, stated once: Rotate is Euler DEGREES applied X then Y then Z
 * (`R = Rz · Ry · Rx`), each a RIGHT-HANDED turn about its axis — a positive turn about +Z
 * carries +X toward +Y, about +X carries +Y toward +Z, about +Y carries +Z toward +X. A unit
 * quaternion turns the same way (`scene-orient.gpu.test.ts` pins it), so a kernel that builds
 * a frame on the GPU and this matrix agree.
 *
 * Matrices are column-major (`m[column * 4 + row]`), vectors multiplied on the right, as
 * `camera.ts` documents. Composed in double precision and handed out as plain numbers: with
 * every value neutral the result is the identity EXACTLY, which is what keeps every picture
 * drawn before this existed bit for bit.
 */

export interface ObjectTransform {
  readonly translate: readonly [number, number, number];
  /** Euler degrees, applied X then Y then Z. */
  readonly rotate: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly pivot: readonly [number, number, number];
}

/** 16 numbers, column-major: the identity. A fresh array each call. */
export function identityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

const DEGREES_TO_RADIANS = Math.PI / 180;

/** `R = Rz · Ry · Rx` as three columns — the same nine terms `pointTransformWgsl` writes. */
function rotationColumns(degrees: readonly [number, number, number]): [number[], number[], number[]] {
  const [cx, cy, cz] = degrees.map((angle) => Math.cos(angle * DEGREES_TO_RADIANS)) as [number, number, number];
  const [sx, sy, sz] = degrees.map((angle) => Math.sin(angle * DEGREES_TO_RADIANS)) as [number, number, number];
  return [
    [cy * cz, cy * sz, -sy],
    [sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy],
    [cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy],
  ];
}

/** The object matrix for one transform (the docblock's formula). */
export function objectMatrix(transform: ObjectTransform): number[] {
  const columns = rotationColumns(transform.rotate);
  const [px, py, pz] = transform.pivot;
  const out = identityMatrix();
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      out[column * 4 + row] = ((columns[column] as number[])[row] as number) * (transform.scale[column] as number);
    }
  }
  /* The translation column: translate + pivot − (R·S)·pivot. */
  for (let row = 0; row < 3; row += 1) {
    const turned = (out[row] as number) * px + (out[4 + row] as number) * py + (out[8 + row] as number) * pz;
    out[12 + row] = (transform.translate[row] as number) + (transform.pivot[row] as number) - turned;
  }
  // −0 → 0: a negative zero is harmless in the arithmetic and noise in a uniform dump.
  return out.map((value) => value + 0);
}

/** True when the matrix is the identity exactly. */
export function isIdentityMatrix(matrix: ArrayLike<number>): boolean {
  const identity = identityMatrix();
  for (let index = 0; index < 16; index += 1) {
    if ((matrix[index] ?? 0) !== identity[index]) return false;
  }
  return true;
}

/**
 * What turns a NORMAL when `matrix` turns a position: the DIRECTION of the inverse transpose
 * of its upper 3×3. Built as the cofactor (columns c1×c2, c2×c0, c0×c1 — the inverse
 * transpose times the determinant, so nothing is divided and a scale of zero on one axis
 * still has an answer), times the determinant's sign (a mirrored object keeps its normals on
 * the side of the surface they were authored on), over its largest column length (a normal
 * is a direction: an object scaled to a thousandth must not hand the fragment stage a normal
 * a millionth long, which its zero-length guard would replace). The identity maps to the
 * identity exactly.
 *
 * Returned as a mat4 (the last row and column the identity's) because that is the one matrix
 * shape every uniform writer here already carries.
 */
export function normalMatrix(matrix: ArrayLike<number>): number[] {
  const at = (column: number, row: number): number => matrix[column * 4 + row] ?? 0;
  const column = (index: number): [number, number, number] => [at(index, 0), at(index, 1), at(index, 2)];
  const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number),
    (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number),
    (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number),
  ];
  const [c0, c1, c2] = [column(0), column(1), column(2)];
  const cofactor = [cross(c1, c2), cross(c2, c0), cross(c0, c1)];
  const determinant = c0[0] * cofactor[0]![0] + c0[1] * cofactor[0]![1] + c0[2] * cofactor[0]![2];
  const longest = Math.max(...cofactor.map((values) => Math.hypot(values[0], values[1], values[2])));
  const factor = (determinant < 0 ? -1 : 1) / (longest > 0 ? longest : 1);
  const out = identityMatrix();
  cofactor.forEach((values, index) => {
    for (let row = 0; row < 3; row += 1) out[index * 4 + row] = (values[row] as number) * factor + 0;
  });
  return out;
}
