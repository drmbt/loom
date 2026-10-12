import { effect, type Effect, type Frame, type Gpu, type Target } from "vgpu";
import type { DrawPassDescriptor, PassDescriptor, ResourceDescriptor, UniformValues } from "../plan.ts";
import { wgsl } from "../wgsl.ts";
import type { ResourceSet } from "./resources.ts";

const COPY_ATLAS = wgsl`@group(0) @binding(0) var atlas: texture_2d<f32>;
@fragment fn fs(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  return textureLoad(atlas, vec2i(pixel.xy), 0);
}`;

interface Group {
  readonly passes: readonly DrawPassDescriptor[];
  readonly source: string;
  readonly recipe: string;
  readonly dependencies: readonly PassDescriptor[] | undefined;
  readonly externals: readonly string[];
  readonly sourceTargets: readonly string[];
  readonly canonical?: Group;
  copy?: Effect;
  ready?: readonly unknown[] | undefined;
  latest?: object | undefined;
}

const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const valuesOf = (values: UniformValues | undefined) => JSON.stringify(values === undefined ? null : Object.keys(values).sort().map(key => [key, values[key]]));

/** Environment-only reuse; ordinary draws retain their existing execution and ownership. */
export function createEnvironmentPreparation(
  gpu: Gpu, passes: readonly PassDescriptor[], descriptors: readonly ResourceDescriptor[], initialResources: ResourceSet, retire: (copy: Effect) => void,
) {
  let resources = initialResources;
  const groups = new Map<string, Group>();
  const marked = passes.filter((pass): pass is DrawPassDescriptor => pass.kind === "draw" && pass.preparation !== undefined);
  if (marked.length === 0) return undefined;
  const kinds = new Map(descriptors.map(resource => [resource.id, resource.kind]));
  const writers = new Map<string, PassDescriptor[]>();
  for (const pass of passes) if ("target" in pass) writers.set(pass.target, [...(writers.get(pass.target) ?? []), pass]);
  const byOwner = new Map<string, DrawPassDescriptor[]>();
  for (const pass of marked) byOwner.set(pass.nodeId!, [...(byOwner.get(pass.nodeId!) ?? []), pass]);
  const recipe = (members: readonly DrawPassDescriptor[]): string => {
    const local = new Map(members.map((pass, index) => [pass.target, index]));
    return JSON.stringify(members.map(pass => [pass.shader, pass.topology, pass.vertexCount, pass.instances, pass.uniformBinding, pass.depthWrite, (pass.textures ?? []).map(binding => [binding.binding,
        local.has(binding.resourceId) ? local.get(binding.resourceId) : binding.resourceId, binding.sampled])]));
  };
  for (const [owner, members] of byOwner) {
    const source = members[0]!.preparation!.source;
    const local = new Set(members.map(pass => pass.target));
    if (members.some(pass => pass.preparation!.source !== source || pass.sharedBinding !== undefined ||
      (pass.buffers?.length ?? 0) !== 0 || pass.clear === false || pass.blend !== undefined || typeof pass.instances !== "number" ||
      kinds.get(pass.target) !== "target" || (writers.get(pass.target) ?? []).some(writer => !members.includes(writer as DrawPassDescriptor)))) {
      throw new Error(`Invalid environment preparation for ${owner}: expected pure, privately owned draw targets.`);
    }
    const dependencies: PassDescriptor[] = [], externals = new Set<string>(), sourceTargets = new Set<string>(), visited = new Set<string>();
    let reusable = true;
    const visit = (id: string) => {
      if (visited.has(id)) return; visited.add(id);
      if (kinds.get(id) === "externalTexture") { externals.add(id); return; }
      if (kinds.get(id) !== "target") { reusable = false; return; }
      sourceTargets.add(id);
      const producers = writers.get(id) ?? [];
      if (producers.length !== 1) { reusable = false; return; }
      const producer = producers[0]!;
      if ((producer.kind !== "effect" && producer.kind !== "draw") || producer.sharedBinding !== undefined ||
        /frameU|SharedFrame/.test(producer.shader) || producer.clear === false ||
        ("buffers" in producer && (producer.buffers?.length ?? 0) !== 0)) { reusable = false; return; }
      dependencies.push(producer);
      for (const binding of producer.textures ?? []) visit(binding.resourceId);
    };
    visit(source);
    for (const pass of members) for (const binding of pass.textures ?? []) {
      if (!local.has(binding.resourceId) && binding.resourceId !== source) reusable = false;
    }
    for (const id of local) {
      if (id !== members.at(-1)!.target && passes.some(pass => !members.includes(pass as DrawPassDescriptor) &&
        "textures" in pass && pass.textures?.some(binding => binding.resourceId === id))) reusable = false;
    }
    const group: Group = { passes: members, source, recipe: recipe(members), dependencies: reusable ? dependencies : undefined,
      externals: [...externals], sourceTargets: [...sourceTargets] };
    const existing = [...groups.values()].find(candidate => candidate.source === source && candidate.dependencies !== undefined &&
      group.dependencies !== undefined && candidate.recipe === group.recipe);
    if (existing !== undefined) Object.assign(group, { canonical: existing });
    groups.set(owner, group);
  }
  try {
    for (const [owner, group] of groups) {
      if (group.canonical === undefined) continue;
      const sourceTarget = resources.targets.get(group.canonical.passes.at(-1)!.target)!;
      const destination = resources.targets.get(group.passes.at(-1)!.target)!;
      group.copy = effect(gpu, COPY_ATLAS, { label: `${owner}:prepared environment copy`, set: { atlas: sourceTarget.color } });
      group.copy.compileSync(destination);
    }
  } catch (error) {
    for (const group of groups.values()) if (group.copy !== undefined) retire(group.copy);
    throw error;
  }
  const byPass = new Map([...groups.values()].flatMap(group => group.passes.map(pass => [pass.id, group] as const)));
  let epoch = 0;
  const available = new Map<Group, readonly unknown[]>();
  const pending = new WeakMap<Frame, Map<Group, { snapshot: readonly unknown[]; epoch: number; token: object }>>();
  const snapshot = (group: Group, uniforms: ReadonlyMap<string, UniformValues>): readonly unknown[] => [group.recipe,
    ...group.passes.flatMap(pass => { const target = resources.targets.get(pass.target)!; return [...target.size, target.format, valuesOf(uniforms.get(pass.id) ?? pass.uniforms)]; }),
    ...group.dependencies!.map(pass => valuesOf(uniforms.get(pass.id) ?? ("uniforms" in pass ? pass.uniforms : undefined))),
    ...group.sourceTargets.map(id => resources.targets.get(id)!.color.gpu),
    ...group.externals.flatMap(id => { const source = resources.externalTextures.get(id)!; return [source.texture.gpu, source.lastFrameId, source.lastSourceToken]; }),
  ];
  return {
    beginRender() { available.clear(); },
    invalidate() { epoch++; available.clear(); for (const group of groups.values()) group.ready = undefined; },
    copies() { return [...groups.values()].flatMap(group => group.copy === undefined ? [] : [group.copy]); },
    begin(frame: Frame, currentResources: ResourceSet, uniforms: ReadonlyMap<string, UniformValues>, skipped: ReadonlySet<string>, copy: (pass: DrawPassDescriptor, destination: Target, drawable: Effect) => void) {
      resources = currentResources;
      const decisions = new Map<Group, { mode: "reuse" | "copy" | "draw"; snapshot: readonly unknown[] | undefined }>();
      return {
        /** Called in original pass order, with preparation passes still present in the plan. */
        take(pass: DrawPassDescriptor): boolean {
          const group = byPass.get(pass.id);
          if (group === undefined) return false;
          let decision = decisions.get(group);
          if (decision === undefined) {
            const current = group.dependencies === undefined || group.passes.some(member => skipped.has(member.id)) || group.dependencies.some(dependency => skipped.has(dependency.id)) ? undefined : snapshot(group, uniforms);
            const outputs = group.passes.map(member => resources.targets.get(member.target)!.color.gpu);
            const ready = current === undefined ? undefined : [...current, ...outputs];
            const canonical = group.canonical;
            const shared = current !== undefined && canonical !== undefined && same(available.get(canonical), current);
            decision = { mode: ready !== undefined && same(group.ready, ready) ? "reuse" : shared ? "copy" : "draw", snapshot: ready };
            decisions.set(group, decision);
            if (decision.mode !== "reuse") { group.ready = undefined; group.latest = undefined; }
            if (decision.mode === "reuse") available.set(group, current!);
          }
          const last = group.passes.at(-1)!;
          if (decision.mode === "copy" && pass.id === last.id) {
            const canonicalTarget = resources.targets.get(group.canonical!.passes.at(-1)!.target)!;
            group.copy!.set({ atlas: canonicalTarget.color });
            copy(pass, resources.targets.get(last.target)!, group.copy!);
          }
          if (decision.mode !== "draw") return true;
          return false;
        },
        completed(pass: DrawPassDescriptor) {
          const group = byPass.get(pass.id);
          if (group === undefined || pass.id !== group.passes.at(-1)!.id) return;
          const decision = decisions.get(group);
          if (decision?.snapshot === undefined || decision.mode === "reuse") return;
          available.set(group, snapshot(group, uniforms));
          const staged = pending.get(frame) ?? new Map();
          const token = {}; group.latest = token;
          staged.set(group, { snapshot: decision.snapshot, epoch, token }); pending.set(frame, staged);
        },
      };
    },
    submitted(frame: Frame, failed: (error: unknown) => void) {
      const staged = pending.get(frame); pending.delete(frame);
      if (staged === undefined) return;
      const version = epoch;
      void frame.done.then(() => { if (version !== epoch) return; for (const [group, value] of staged) {
        if (value.epoch === epoch && group.latest === value.token) group.ready = value.snapshot;
      } }, error => { this.invalidate(); failed(error); });
    },
  };
}
