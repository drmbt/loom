import { effect } from "vgpu";
import type { Effect, Gpu, TargetSignature } from "vgpu";
import type { EffectPassDescriptor, PassDescriptor, ResourceDescriptor } from "../plan.ts";

/**
 * §T1507b — A BYPASSED LAYER'S EFFECTS, BUILT BEFORE IT IS SWITCHED ON.
 *
 * A Layer that is off is bypassed, and the compiler prunes what only it reads (§T1498b), so
 * switching it on is a structural recompile that builds every pass it brings back. Measured
 * on Dawn (Metal, E82 at 1280×720, output sink only; the fx layer brings four passes):
 *
 *   - `backend.compile` for the switch: 11.4 ms the first time, 9.2 ms every time after;
 *     a steady frame is ~2.3 ms. Pipelines and shader modules were 1.6 ms of the 11.4, and
 *     NONE of the 9.2: vgpu's per-device pipeline store and module cache already keep
 *     every pipeline ever built, keyed by bytes.
 *   - the rest is vgpu's JS-side WGSL REFLECTION (`reflectSource`, twice per new effect:
 *     once to look for a vertex entry, once in the draw it wraps): ~80% of the switch's
 *     main-thread time in a CPU profile, paid on every switch because a dropped pass's
 *     Effect goes with the program that dropped it.
 *
 * So what is held here is the whole Effect, not just its pipeline: built (reflected, bind
 * group layouts made, module fetched from vgpu's cache) off the frame path, with its
 * render pipeline requested through vgpu's ASYNC path (`Effect.compile(signature)` →
 * `createRenderPipelineAsync` into the same store `compileSync` reads), so a browser
 * compiles it off its GPU process's main thread. The structural compile that switches the
 * layer on then TAKES the Effect, binds its set bag, and `compileSync` finds the pipeline
 * already in the store: no module, no pipeline, no reflection on the switch.
 *
 * ## Invisible to rendering
 *
 * A held Effect has no bindings and no target: nothing is allocated for it, nothing
 * encodes it, nothing reads it back. An adopted one is the Effect the compile would have
 * built — the same WGSL bytes, the same options (`label` is the pass id, B229), and its set
 * bag is bound exactly as the constructor binds one (`set(bag)`).
 *
 * ## Errors stay the compile's to tell
 *
 * Each build runs inside its own device error scope. A shader the device rejects is not
 * held, and the reason the scope caught goes to `onBuildError`: vgpu now holds the invalid
 * module under those bytes, so the compile that later builds them is told nothing new
 * (T1523b(c) keeps the reason against the source for exactly that). A failed async pipeline
 * only rejects its promise — vgpu's store forgets it and the compile builds it again, in
 * scope, where it is reported as it always was.
 *
 * ## Bounded
 *
 * At most {@link MAX_WARM_EFFECTS}, in plan order; one build per macrotask, so frames run
 * between them; a newer `warm` call stops an older one.
 *
 * Effect passes only — the passes a texture look is made of. A `draw` (geometry, topology,
 * instances, blend, depth) or a `dispatch` could be held the same way with a wider key,
 * with one difference for kernels: vgpu's `compute()` creates its own module and pipeline
 * synchronously, outside the shared module cache and pipeline store, so a kernel's
 * pipeline would be compiled synchronously in the warm task and would not outlive the
 * program that drops it. Not built here; a look made of points or 3D still builds those
 * passes on the switch.
 */
export const MAX_WARM_EFFECTS = 32;

/** What the structural compile reads: the held Effect for one pass, handed over once. */
export interface WarmEffectSource {
  take(passId: string, shader: string): Effect | undefined;
}

export interface WarmEffects extends WarmEffectSource {
  /** The device the held Effects belong to; a compile on another one takes nothing. */
  readonly gpu: Gpu;
  /**
   * Holds an Effect for every effect pass of `passes` that is not `live`, up to the cap,
   * and drops every held one that is no longer wanted. Resolves when this call has built
   * what it will build (or a newer call took over); never rejects.
   */
  warm(
    passes: ReadonlyArray<PassDescriptor>,
    resources: ReadonlyArray<ResourceDescriptor>,
    hooks: WarmHooks,
  ): Promise<void>;
  /** The pass ids held now, in plan order. */
  passIds(): string[];
  clear(): void;
}

export interface WarmHooks {
  /** The installed program already has this pass with these bytes: nothing to hold. */
  readonly live: (passId: string, shader: string) => boolean;
  /** True while building now would be wrong (a frame is encoding, the device went away). */
  readonly blocked: () => boolean;
  /** The device rejected a build; `message` is what its scope caught. */
  readonly onBuildError: (shader: string, message: string) => void;
}

const keyOf = (passId: string, shader: string): string => `${passId}\u0000${shader}`;

/** One macrotask: the frame loop's callbacks run between two builds. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The signature `compileSync(target)` keys the pipeline on, for the targets whose
 * signature is the plain one: one colour attachment of the resource's format, no depth,
 * one sample. Depth or MSAA targets get none — their Effect is still held, and the compile
 * builds their pipeline as it always did.
 */
function signatureFor(resource: ResourceDescriptor | undefined): TargetSignature | undefined {
  if (resource === undefined) return undefined;
  if (resource.kind === "target") {
    if (resource.depth === true || resource.msaa === true) return undefined;
    return { colors: [resource.format as GPUTextureFormat] };
  }
  if (resource.kind === "pingPong" || resource.kind === "ring") {
    return { colors: [resource.format as GPUTextureFormat] };
  }
  return undefined;
}

export function createWarmEffects(gpu: Gpu): WarmEffects {
  const held = new Map<string, { readonly passId: string; readonly effect: Effect }>();
  let generation = 0;
  const raw = (gpu.device as { gpu?: GPUDevice }).gpu;

  return {
    gpu,
    take(passId, shader) {
      const key = keyOf(passId, shader);
      const entry = held.get(key);
      if (entry === undefined) return undefined;
      held.delete(key);
      return entry.effect;
    },
    passIds: () => [...held.values()].map((entry) => entry.passId),
    clear() {
      generation += 1;
      held.clear();
    },
    async warm(passes, resources, hooks) {
      const mine = (generation += 1);
      const byId = new Map(resources.map((resource) => [resource.id, resource]));
      const wanted: EffectPassDescriptor[] = [];
      const wantedKeys = new Set<string>();
      for (const pass of passes) {
        if (wanted.length >= MAX_WARM_EFFECTS) break;
        if (pass.kind !== "effect" || hooks.live(pass.id, pass.shader)) continue;
        const key = keyOf(pass.id, pass.shader);
        if (wantedKeys.has(key)) continue;
        wanted.push(pass);
        wantedKeys.add(key);
      }
      // Dropped at once, not after the builds: a layer that is gone takes its entries with it.
      for (const key of [...held.keys()]) {
        if (!wantedKeys.has(key)) held.delete(key);
      }
      for (const pass of wanted) {
        const key = keyOf(pass.id, pass.shader);
        if (held.has(key)) continue;
        await nextTask();
        if (mine !== generation) return;
        if (hooks.blocked()) return;
        if (hooks.live(pass.id, pass.shader)) continue;

        let built: Effect | undefined;
        const scoped = raw !== undefined && typeof raw.pushErrorScope === "function";
        if (scoped) raw.pushErrorScope("validation");
        try {
          built = effect(gpu, pass.shader, { label: pass.id });
        } catch {
          // A CPU-side refusal (vgpu's reflection): the compile meets it again and says so.
          built = undefined;
        }
        const verdict = scoped ? raw.popErrorScope() : Promise.resolve(null);
        const message = await verdict.then(
          (error) => error?.message,
          () => undefined,
        );
        if (message !== undefined) hooks.onBuildError(pass.shader, message);
        if (built === undefined || message !== undefined) continue;
        if (mine !== generation || hooks.blocked()) return;
        held.set(key, { passId: pass.id, effect: built });
        const signature = signatureFor(byId.get(pass.target));
        if (signature !== undefined) {
          // Into vgpu's store, where `compileSync` looks first. A rejection is forgotten by
          // the store; the compile then builds the pipeline in its own scope and reports it.
          void built.compile(signature).catch(() => undefined);
        }
      }
    },
  };
}
