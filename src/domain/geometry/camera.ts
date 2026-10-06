/**
 * Camera math (T295, §V198): column-major mat4, WGSL layout, WebGPU depth range.
 *
 * §V198 is the reason this file is mostly documentation: the composition order is
 * PUBLISHED and pinned by test, because "which order" is the most expensive thing in a
 * geometry system to get wrong and the cheapest to fix on day one. The order is:
 *
 *     clip = projection × view × world
 *
 * with matrices COLUMN-MAJOR (WGSL's layout: `m[c][r]`, columns contiguous), vectors
 * multiplied on the RIGHT (`clip = M * v`), a RIGHT-HANDED world (+x right, +y up, -z
 * forward — the camera looks down its own -z), and WebGPU's [0, 1] clip depth (NOT
 * GL's [-1, 1]; reusing a GL projection matrix halves your depth precision and shifts
 * the near plane, silently). `viewProjection` composes the two on the CPU once per
 * frame so shaders multiply one matrix, not two.
 */

/** 16 numbers, column-major. `m[column * 4 + row]`. */
export type Mat4 = Float32Array;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** `a × b` — apply `b` first, then `a`. Column-major, right-multiplied vectors. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function transformPoint(m: Mat4, point: readonly [number, number, number]): [number, number, number, number] {
  const [x, y, z] = point;
  const at = (index: number): number => m[index] ?? 0;
  return [
    at(0) * x + at(4) * y + at(8) * z + at(12),
    at(1) * x + at(5) * y + at(9) * z + at(13),
    at(2) * x + at(6) * y + at(10) * z + at(14),
    at(3) * x + at(7) * y + at(11) * z + at(15),
  ];
}

/**
 * Perspective projection, WebGPU depth range [0, 1], infinite-far-free classic form.
 * `fovY` in radians; `aspect` = width / height.
 */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

/** View matrix: the world as seen from `eye` looking at `center`, `up` roughly up. */
export function lookAt(
  eye: readonly [number, number, number],
  center: readonly [number, number, number],
  up: readonly [number, number, number] = [0, 1, 0],
): Mat4 {
  const sub = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  ];
  const normalize = (v: [number, number, number]): [number, number, number] => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
  const dot = (a: readonly number[], b: readonly number[]): number =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

  const forward = normalize(sub(eye, center)); // camera's +z (it LOOKS down -z)
  const right = normalize(cross(up, forward));
  const trueUp = cross(forward, right);

  const m = new Float32Array(16);
  m[0] = right[0]; m[1] = trueUp[0]; m[2] = forward[0];
  m[4] = right[1]; m[5] = trueUp[1]; m[6] = forward[1];
  m[8] = right[2]; m[9] = trueUp[2]; m[10] = forward[2];
  m[12] = -dot(right, eye);
  m[13] = -dot(trueUp, eye);
  m[14] = -dot(forward, eye);
  m[15] = 1;
  return m;
}

/** The one matrix a shader multiplies: `projection × view` (§V198's published order). */
export function viewProjection(
  eye: readonly [number, number, number],
  center: readonly [number, number, number],
  options: { fovY?: number; aspect?: number; near?: number; far?: number; up?: readonly [number, number, number] } = {},
): Mat4 {
  return multiply(
    perspective(options.fovY ?? Math.PI / 3, options.aspect ?? 1, options.near ?? 0.1, options.far ?? 100),
    lookAt(eye, center, options.up ?? [0, 1, 0]),
  );
}

/** Orthographic projection (T377): [0,1] depth, y up, matching `perspective`'s conventions. */
export function orthographic(height: number, aspect: number, near: number, far: number): Mat4 {
  const halfH = Math.max(height, 1e-6) / 2;
  const halfW = halfH * Math.max(aspect, 1e-6);
  const m = identity();
  m[0] = 1 / halfW;
  m[5] = 1 / halfH;
  m[10] = 1 / (near - far);
  m[14] = near / (near - far);
  return m;
}

/**
 * T706/T704 — the ONE guarded, rolled up-vector (§V437). The camera's view and the
 * projector's throw share it: the degenerate-pole guard swaps to [0,0,1] exactly as the
 * shadow path does, and `roll` banks the result around the view axis (Rodrigues).
 *
 * THE SIGN (T1433b, flipped by the owner's ruling with schema 5): `roll` is RIGHT-HANDED about
 * the camera's own +z — the axis pointing back out of the lens at whoever stands behind it —
 * as in Blender and three.js. A positive roll turns the camera COUNTER-CLOCKWISE as seen from
 * behind it (its up swings toward its left), so the PICTURE turns CLOCKWISE: at +90 the
 * world's up lands on the screen's right. The Rodrigues turn below is about the FORWARD axis,
 * hence the negated angle. Documents saved before schema 5 turned the other way; the 4 → 5
 * migration negates their stored rolls. `camera.test.ts` pins the sign. Every WGSL copy of the
 * rolled basis in the projects (`rolledRight`) and the CRT Tube's camera repeat it.
 */
export function guardedRolledUp(
  eye: readonly [number, number, number],
  lookAt3: readonly [number, number, number],
  rollDeg: number,
): [number, number, number] {
  const view3 = ((): [number, number, number] => {
    const dx = lookAt3[0] - eye[0];
    const dy = lookAt3[1] - eye[1];
    const dz = lookAt3[2] - eye[2];
    const length = Math.hypot(dx, dy, dz) || 1;
    return [dx / length, dy / length, dz / length];
  })();
  let up: [number, number, number] = Math.abs(view3[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  if (rollDeg !== 0) {
    // Right-handed about +z (back) is left-handed about the forward axis `k`.
    const theta = (-rollDeg * Math.PI) / 180;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    const k = view3;
    const kCrossUp: [number, number, number] = [
      k[1] * up[2] - k[2] * up[1],
      k[2] * up[0] - k[0] * up[2],
      k[0] * up[1] - k[1] * up[0],
    ];
    const kDotUp = k[0] * up[0] + k[1] * up[1] + k[2] * up[2];
    up = [
      up[0] * c + kCrossUp[0] * sn + k[0] * kDotUp * (1 - c),
      up[1] * c + kCrossUp[1] * sn + k[1] * kDotUp * (1 - c),
      up[2] * c + kCrossUp[2] * sn + k[2] * kDotUp * (1 - c),
    ];
  }
  return up;
}

/**
 * T1421b — the camera's frame in world space, exactly as the render's view builds it (`lookAt`
 * with the guarded, rolled up): `forward` the way it looks, `right`, and the true `up`.
 */
export function cameraBasis(
  eye: readonly [number, number, number],
  lookAt3: readonly [number, number, number],
  rollDeg: number,
): { forward: [number, number, number]; right: [number, number, number]; up: [number, number, number] } {
  const up = guardedRolledUp(eye, lookAt3, rollDeg);
  const unit = (v: [number, number, number]): [number, number, number] => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
  const forward = unit([lookAt3[0] - eye[0], lookAt3[1] - eye[1], lookAt3[2] - eye[2]]);
  const right = unit(cross(forward, up));
  return { forward, right, up: cross(right, forward) };
}

/**
 * §T1656b — A CAMERA'S PARENT FRAME: where its Eye and Look At are measured FROM.
 *
 * The owner's camera follows a robot travelling 3 to 8 m a second, by six expressions on Eye
 * and Look At. A view flown by hand could only be kept by replacing those expressions with
 * numbers, and the camera would stop following (§T970). The reference tools all answer the
 * same way: the thing that moves is a PARENT, and the camera's own transform is an offset
 * in it (TouchDesigner's Parent Transform Source, Notch's parent node, Blender's parenting;
 * `docs/camera-fly-design-2026-10-06.md` has the sentences).
 *
 * Here the parent is two vectors on the camera, both ordinary drivable parameters:
 *
 *  - ORIGIN: where the frame is. World Eye = Origin + frame · Eye; the same for Look At.
 *  - HEADING: which way the frame faces. ONLY ITS HORIZONTAL PART IS READ: the frame turns
 *    about the world's up axis and never tilts. A camera that follows a subject up a ramp
 *    rises with it (Origin) and does not pitch with it, so the horizon of a flown view stays
 *    where the pilot left it, and the gizmo's orbit, truck and fly mean the same thing in the
 *    frame as in the world (a turn about the axis all three already use).
 *
 * The frame's FORWARD is its local −z, the way a camera looks: the default camera (Eye
 * 0, 0.5, 3, Look At the origin) under a subject's position and heading sits three behind
 * and half above it, looking where it goes. No heading (zero, or straight up or down) is no
 * turn: only the position is inherited.
 *
 * ## §T1671b — LEVEL, or AIMED
 *
 * That is the LEVEL frame, and it is the default. A directed shot wants the other reading
 * of the same vector: Heading is where the camera LOOKS, climbing and diving included, so
 * that "d along the shot" is Look At 0, 0, −d as a plain number (the owner's rig is a table
 * of 25 directed shots; on a level frame the aim's height and distance had to stay in Look
 * At as expressions, and two of the six channels a flight writes were driven). That is the
 * AIMED frame: its forward IS Heading, read whole, and its up is the world's up made
 * perpendicular to it.
 *
 * THE POLE, STATED. A Heading within about 2.6° of straight up or down has no such up. The
 * frame then takes world +z as its up reference: `guardedRolledUp`'s rule and threshold
 * below, the one the camera's own view has for a view that steep, so the frame's axes and
 * the picture's agree there too. Nothing is NaN, and nothing is remembered from the frame
 * before: the axes are a function of this Heading alone.
 */
export type CameraFrameMode = "level" | "aimed";

export interface CameraFrame {
  readonly origin: readonly [number, number, number];
  /** The frame's +x, in the world. Unit; horizontal away from the pole. */
  readonly right: readonly [number, number, number];
  /** The frame's +y, in the world. Unit. The world's own up in a LEVEL frame. */
  readonly up: readonly [number, number, number];
  /** The frame's +z, in the world: the opposite of its heading. Unit; horizontal when LEVEL. */
  readonly back: readonly [number, number, number];
}

const WORLD_UP = [0, 1, 0] as const;

export function cameraFrame(
  origin: readonly [number, number, number],
  heading: readonly [number, number, number],
  mode: CameraFrameMode = "level",
): CameraFrame {
  if (mode === "aimed") {
    const length = Math.hypot(heading[0], heading[1], heading[2]);
    // A Heading of no length is no heading, as it is when level.
    if (!(length > 1e-6)) return { origin, right: [1, 0, 0], up: WORLD_UP, back: [0, 0, 1] };
    const forward = [heading[0] / length, heading[1] / length, heading[2] / length] as const;
    const reference = Math.abs(forward[1]) > 0.999 ? ([0, 0, 1] as const) : WORLD_UP;
    // right = forward × reference, made unit; up = right × forward.
    const rx = forward[1] * reference[2] - forward[2] * reference[1];
    const ry = forward[2] * reference[0] - forward[0] * reference[2];
    const rz = forward[0] * reference[1] - forward[1] * reference[0];
    const span = Math.hypot(rx, ry, rz);
    const right = [rx / span, ry / span, rz / span] as const;
    const up = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ] as const;
    return { origin, right, up, back: [-forward[0], -forward[1], -forward[2]] };
  }
  const span = Math.hypot(heading[0], heading[2]);
  if (!(span > 1e-6)) return { origin, right: [1, 0, 0], up: WORLD_UP, back: [0, 0, 1] };
  const back = [-heading[0] / span, 0, -heading[2] / span] as const;
  // right = up × back, with up the world's y.
  return { origin, right: [back[2], 0, -back[0]], up: WORLD_UP, back };
}

/**
 * §T1671b: the WORLD's up, in the frame's own coordinates. A gesture on a pose stored in a
 * frame (an orbit, a truck, a flight) keeps its world meaning, a turntable about the
 * world's vertical, by being told which way that is where the pose's numbers live. It is
 * 0, 1, 0 itself in every level frame.
 */
export function worldUpInCameraFrame(frame: CameraFrame): readonly [number, number, number] {
  if (frame.up === WORLD_UP) return WORLD_UP;
  return [frame.right[1], frame.up[1], frame.back[1]];
}

/**
 * A point of the frame, in the world.
 *
 * ⚑ THE UNTOUCHED FRAME RETURNS THE POINT ITSELF, float for float: every camera saved
 * before Origin and Heading existed has neither, and what it draws must not move by a bit.
 * `x * 1 + z * 0 + 0` is exact for finite numbers and still not the same claim.
 */
export function inCameraFrame(
  frame: CameraFrame,
  point: readonly [number, number, number],
): readonly [number, number, number] {
  const { origin, right, up, back } = frame;
  if (origin[0] === 0 && origin[1] === 0 && origin[2] === 0 && right[0] === 1 && back[2] === 1 && up[1] === 1) return point;
  // A LEVEL frame, by the arithmetic it has always had: its up is the world's, exactly.
  if (up === WORLD_UP) {
    return [
      origin[0] + right[0] * point[0] + back[0] * point[2],
      origin[1] + point[1],
      origin[2] + right[2] * point[0] + back[2] * point[2],
    ];
  }
  return [
    origin[0] + right[0] * point[0] + up[0] * point[1] + back[0] * point[2],
    origin[1] + right[1] * point[0] + up[1] * point[1] + back[1] * point[2],
    origin[2] + right[2] * point[0] + up[2] * point[1] + back[2] * point[2],
  ];
}

/** The optics a venue spec lists (T704). All of it is geometry — no light math here. */
export interface ProjectorLens {
  /** Throw distance ÷ image width — the number printed on the lens. */
  readonly throwRatio: number;
  /** The projector's NATIVE aspect (width/height of the image it throws). */
  readonly aspect: number;
  /** Lens shift, as fractions of image width/height. Off-axis, not a re-aim. */
  readonly shiftX: number;
  readonly shiftY: number;
  /** Keystone, degrees. Applied as the trapezoid it actually is (w-row shear). */
  readonly keystoneH: number;
  readonly keystoneV: number;
}

/**
 * The projector frustum's near and far planes, from the throw distance (|eye − lookAt|):
 * near at 2% of it, far at 8×. One function, because the lit read linearises the depth
 * map with the same two numbers the matrix was built from (VNB11).
 */
export function projectorDepthRange(pose: {
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
}): { readonly near: number; readonly far: number } {
  const distance = Math.max(
    0.05,
    Math.hypot(
      pose.lookAt[0] - pose.eye[0],
      pose.lookAt[1] - pose.eye[1],
      pose.lookAt[2] - pose.eye[2],
    ),
  );
  return { near: Math.max(0.01, distance * 0.02), far: distance * 8 };
}

/**
 * T704 — the projector's viewProjection: what the venue's lens sheet says, as a matrix.
 *
 * fovX comes from the throw ratio (tan(fovX/2) = 0.5/throw); fovY from the native
 * aspect. Near/far derive from the throw DISTANCE (|eye − lookAt|) so the frustum
 * brackets the surface being hit without another parameter to explain: near at 2% of
 * the distance, far at 8×. Lens shift is a true off-axis offset (the image moves, the
 * body does not re-aim) — implemented on the projection's z-column so it survives the
 * perspective divide as a constant NDC offset. Keystone is the trapezoid a tilted
 * screen produces: a shear INTO THE W ROW, so one side of the image genuinely scales
 * against the other rather than merely sliding.
 */
export function projectorMatrix(
  pose: {
    readonly eye: readonly [number, number, number];
    readonly lookAt: readonly [number, number, number];
    readonly roll?: number;
  },
  lens: ProjectorLens,
): Mat4 {
  const { near, far } = projectorDepthRange(pose);
  const tanHalfX = 0.5 / Math.max(lens.throwRatio, 0.05);
  const tanHalfY = tanHalfX / Math.max(lens.aspect, 0.05);

  const projection = identity();
  projection[0] = 1 / tanHalfX;
  projection[5] = 1 / tanHalfY;
  projection[10] = far / (near - far);
  projection[11] = -1;
  projection[14] = (near * far) / (near - far);
  projection[15] = 0;
  // Off-axis shift: x_ndc = (m0·x + m8·z)/(−z) = m0·x/(−z) − m8, so writing +2·shift
  // slides the IMAGE by `shift` image-widths — positive = up/right in the world, the
  // venue convention — without re-aiming the axis (the optical-axis point then lands
  // at −2·shift ndc, because the frustum moved and the axis did not).
  projection[8] = 2 * lens.shiftX;
  projection[9] = 2 * lens.shiftY;
  // Keystone: shear x (and y) into the w row — after the divide, one side of the image
  // is nearer in projector terms than the other, which is exactly the trapezoid.
  const kH = Math.tan((lens.keystoneH * Math.PI) / 180);
  const kV = Math.tan((lens.keystoneV * Math.PI) / 180);
  if (kH !== 0 || kV !== 0) {
    projection[3] = kH * (projection[0] ?? 0);
    projection[7] = kV * (projection[5] ?? 0);
    // VNB10: the depth row takes the SAME shear, so depth stays the usual perspective depth
    // of the sheared w (z_ndc = −m10 + m14 / w). Without it the w-row shear divided an
    // unsheared z: on the image's narrow side z_ndc passed 1 within a metre of the lens, the
    // depth range test dropped that half of the image from the lit draw and its depth sweep,
    // and the beam a matching volumetric drew there landed on nothing.
    projection[2] = -(projection[10] ?? 0) * (projection[3] ?? 0);
    projection[6] = -(projection[10] ?? 0) * (projection[7] ?? 0);
  }

  const up = guardedRolledUp(pose.eye, pose.lookAt, pose.roll ?? 0);
  const view = lookAt(
    [pose.eye[0], pose.eye[1], pose.eye[2]],
    [pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]],
    up,
  );
  return multiply(projection, view);
}

/**
 * T457: one camera VALUE to one matrix, composed where the aspect is known (§V198).
 * Every consumer of a camera payload — Render, renderSurface, renderInstances — goes
 * through this, so a camera node means the same picture wherever it is named (V387).
 */
export function cameraPayloadMatrix(
  camera: {
    readonly eye: readonly [number, number, number];
    readonly lookAt: readonly [number, number, number];
    readonly fovDeg: number;
    readonly near: number;
    readonly far: number;
    readonly ortho: boolean;
    readonly orthoHeight: number;
    /** Degrees of bank around the view axis (T706). Absent = 0, the old behaviour. */
    readonly roll?: number;
  },
  aspect: number,
): Mat4 {
  /*
   * T706 — the missing third guard, and the roll that finally reaches the node.
   *
   * Of the three lookAt call sites this was the only one that took the default up with
   * NO degenerate-basis guard (directionalShadowMatrix swaps at |d.y| > 0.999,
   * scene.ts's environment basis at 0.99) — so a camera aimed straight down or up fed
   * cross([0,1,0],[0,1,0]) = 0 into the view basis and rendered a collapsed frame.
   * The guard picks [0,0,1] exactly as the shadow path does.
   *
   * `roll` banks the guarded up around the view axis (Rodrigues), so aim stays the
   * look-at vector's job and orientation is complete: eye + lookAt + roll is a full
   * rotation representation, which is what the positioning gizmo (T692) writes into.
   */
  const up = guardedRolledUp(camera.eye, camera.lookAt, camera.roll ?? 0);
  const view = lookAt(
    [camera.eye[0], camera.eye[1], camera.eye[2]],
    [camera.lookAt[0], camera.lookAt[1], camera.lookAt[2]],
    up,
  );
  const projection = camera.ortho
    ? orthographic(camera.orthoHeight, aspect, camera.near, camera.far)
    : perspective((camera.fovDeg * Math.PI) / 180, aspect, camera.near, camera.far);
  return multiply(projection, view);
}

/**
 * T481: the CASTING matrix for a directional light — an orthographic camera looking
 * along the light's travel, framed by an EXPLICIT half-extent around an explicit CENTRE
 * (V426: payloads carry no scene bounds, so a derived box would crop shadows
 * plausibly-wrong; T1405b: the centre is the light's Shadow Centre, the origin by default).
 * Coverage is at least `extent` on BOTH map axes whatever the map's aspect; a direction
 * parallel to world-up swaps the up vector rather than degenerating.
 */
export function directionalShadowMatrix(
  direction: readonly [number, number, number],
  extent: number,
  aspect: number,
  center: readonly [number, number, number] = [0, 0, 0],
): Mat4 {
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const d: [number, number, number] = [direction[0] / length, direction[1] / length, direction[2] / length];
  const eye: [number, number, number] = [center[0] - d[0] * extent, center[1] - d[1] * extent, center[2] - d[2] * extent];
  const up: [number, number, number] = Math.abs(d[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const safeAspect = Math.max(aspect, 1e-6);
  const height = 2 * extent * Math.max(1, 1 / safeAspect);
  const view = lookAt(eye, [center[0], center[1], center[2]], up);
  const projection = orthographic(height, safeAspect, 0.01, 3 * extent);
  return multiply(projection, view);
}

/**
 * T1362b — the six 90° frusta of a point light's cube shadow, in atlas face order
 * +X, −X, +Y, −Y, +Z, −Z. The lit pass picks a face by the dominant axis of light→fragment
 * and projects with the same matrix, so the two sides cannot disagree about which texel a
 * direction lands on. Near is a fixed fraction of the range: a caster closer than that to
 * the light is inside the lamp.
 */
/** The cube's faces, in atlas order. One table for the matrices and for `pointShadowFaceReaches`. */
const POINT_SHADOW_FACES: ReadonlyArray<{ readonly axis: readonly [number, number, number]; readonly up: readonly [number, number, number] }> = [
  { axis: [1, 0, 0], up: [0, 1, 0] },
  { axis: [-1, 0, 0], up: [0, 1, 0] },
  { axis: [0, 1, 0], up: [0, 0, -1] },
  { axis: [0, -1, 0], up: [0, 0, 1] },
  { axis: [0, 0, 1], up: [0, 1, 0] },
  { axis: [0, 0, -1], up: [0, 1, 0] },
];

/**
 * T1598b — whether face `face` of a point light's cube sweep can hold ANY of a sphere.
 *
 * False only when the sphere's draw into that face is provably empty, so a caller may
 * leave the draw out without changing a picture:
 *
 *  - OUT OF RANGE: every point of it is further than `range` from the light. The sweep
 *    stores distance ÷ range and a receiver beyond the range is unshadowed by rule, so a
 *    caster out there can only shadow what is never shadowed.
 *  - OUT OF THE FACE: it lies wholly behind one of the four side planes of the face's 90°
 *    pyramid. The sweep discards every fragment outside its face (`cubeShadowVariant`).
 *
 * Conservative: a sphere that touches the volume, or is near one of the pyramid's edges
 * without entering it, answers true. `range` is clamped as the matrices clamp it.
 */
export function pointShadowFaceReaches(
  position: readonly [number, number, number],
  range: number,
  face: number,
  sphere: { readonly center: readonly [number, number, number]; readonly radius: number },
): boolean {
  const axis = POINT_SHADOW_FACES[face]?.axis;
  if (axis === undefined) return true;
  const d = [sphere.center[0] - position[0], sphere.center[1] - position[1], sphere.center[2] - position[2]] as const;
  if (Math.hypot(d[0], d[1], d[2]) - sphere.radius > Math.max(0.1, range)) return false;
  // The face's axis is a world axis, so "along" is one component and the side planes pair
  // it with each of the other two: inside means along ≥ |other|, and a plane's unit normal
  // is (axis ∓ other) / √2, which is where the √2 comes from.
  const which = axis[0] !== 0 ? 0 : axis[1] !== 0 ? 1 : 2;
  const along = d[which] * (axis[which] as number);
  const aside = Math.max(Math.abs(d[(which + 1) % 3] as number), Math.abs(d[(which + 2) % 3] as number));
  return along + sphere.radius * Math.SQRT2 >= aside;
}

export function pointShadowFaceMatrices(position: readonly [number, number, number], range: number): Mat4[] {
  const far = Math.max(0.1, range);
  const near = Math.max(0.01, far * 0.002);
  const projection = perspective(Math.PI / 2, 1, near, far);
  const faces = POINT_SHADOW_FACES;
  return faces.map(({ axis, up }) =>
    multiply(
      projection,
      lookAt(position, [position[0] + axis[0], position[1] + axis[1], position[2] + axis[2]], up),
    ),
  );
}
