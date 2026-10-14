import { beforeEach, describe, expect, it, vi } from "vitest";

const prepared = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@vgpu/wgsl/prepare", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vgpu/wgsl/prepare")>();
  return {
    prepareShader: (source: string, path?: string) => {
      prepared.calls.push(source);
      return actual.prepareShader(source, path);
    },
  };
});

import { preparedShader } from "./prepared-shader.ts";

/** A valid fragment shader whose text is unique to `n`, so each is a distinct source. */
function shader(n: number): string {
  return `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(${n}.0); }\n`;
}

beforeEach(() => {
  prepared.calls.length = 0;
});

/**
 * T1705b: preparing a shader is the parse and reflection 0.5.0 ran inside every consumer's
 * constructor, about 2 ms for an 11 KB source. A compile builds one consumer per pass, and
 * passes of one node type emit the same WGSL, so a source is prepared once while it is kept.
 */
describe("preparedShader keeps one artifact per source (T1705b)", () => {
  it("prepares a source once for every consumer that builds it", () => {
    const first = preparedShader(shader(1), "blur1");
    const second = preparedShader(shader(1), "blur2");
    expect(prepared.calls.filter((source) => source === shader(1))).toHaveLength(1);
    // The same object: vgpu validates a frozen artifact once and reuses the snapshot per object.
    expect(second).toBe(first);
  });

  it("refuses a broken source to every caller, so each pass fails its own build", () => {
    const broken = "@fragment fn fs_main( -> @location(0) vec4f { return vec4f(1.0); }\n";
    expect(() => preparedShader(broken, "custom_a")).toThrow(/Unclosed \(/);
    // Were a refusal kept as an artifact, the second node would build and report nothing.
    expect(() => preparedShader(broken, "custom_b")).toThrow(/Unclosed \(/);
  });

  it("keeps a bounded number of sources and drops the least recently used first", () => {
    preparedShader(shader(1000), "old");
    preparedShader(shader(1001), "recent");
    for (let n = 2000; n < 2200; n += 1) {
      preparedShader(shader(n), `filler${n}`);
      // Kept in use while the others arrive, so it must survive the eviction.
      preparedShader(shader(1001), "recent");
    }
    prepared.calls.length = 0;
    preparedShader(shader(1001), "recent");
    preparedShader(shader(1000), "old");
    // Without a bound every edit of a Custom WGSL node would be kept for the session.
    expect(prepared.calls).toEqual([shader(1000)]);
  });
});
