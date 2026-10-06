/**
 * B263 CANARY — does this GPU still get the divide of a high half wrong, and is the shape of
 * the bug still the one the product warns about?
 *
 *   node tools/apple-gpu-divide-canary.mjs
 *
 * WHEN TO RUN IT: after a macOS, GPU driver, Dawn (the `vgpu` pin) or browser bump, and on
 * any new machine whose pictures disagree with the CPU's arithmetic. It is a tool, not a
 * gate: its answer is a fact about a driver, and a test suite must not go red because Apple
 * fixed something.
 *
 * WHAT IT DOES: runs every line of the measured table (`src/compiler/wgsl-high-half.cases.ts`,
 * the same list the compiler's warning is held to) in a compute shader on this machine's
 * device, on 512 values, and compares each with the same line on the CPU.
 *
 * WHAT ITS OUTPUT MEANS:
 *   "as recorded"            the line behaves here as it did when the table was measured.
 *   "NOW RIGHT (was wrong)"  this driver no longer has the bug for that line. If every wrong
 *                            line says so, B263 is fixed here: say so on the SPEC row, and the
 *                            compiler's warning (`compiler/wgsl-high-half-divide`) can be
 *                            retired once the browsers people use have the fix too.
 *   "NOW WRONG (was right)"  the bug's shape has GROWN: a line the product treats as safe is
 *                            wrong here. Add it to the table as "wrong", teach
 *                            `src/compiler/wgsl-high-half.ts` its text, and run the gates.
 * The last line is a one-sentence verdict. The exit code is 0 unless the script itself fails.
 *
 * The table is a .ts file with no imports; Node loads it as it is (type stripping).
 */
import { init } from "vgpu/node";

import { HIGH_HALF_CASES } from "../src/compiler/wgsl-high-half.cases.ts";

const N = 512;
const BU = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };

/** 512 values of x of every size: the edges first, then a generator's stream, a third of it shifted down. */
function inputs() {
  const xs = new Uint32Array(N);
  let seed = 12345;
  for (let index = 0; index < N; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    xs[index] = index < 8 ? [0, 1, 96, 97, 65535, 65536, 0x7fffffff, 0xffffffff][index] : index % 3 === 0 ? seed >>> (index % 29) : seed;
  }
  return xs;
}

async function main() {
  const gpu = await init({ label: "b263-canary" });
  const device = gpu.gpu;
  device.addEventListener?.("uncapturederror", (event) => {
    console.error("GPU ERROR:", event.error?.message);
    process.exit(1);
  });
  console.log(`adapter: ${gpu.adapter.name}`);
  console.log(`${HIGH_HALF_CASES.length} lines, ${N} values each; d is 97, read from a buffer\n`);

  const xs = inputs();
  const xBuffer = device.createBuffer({ size: xs.byteLength, usage: BU.STORAGE | BU.COPY_DST });
  device.queue.writeBuffer(xBuffer, 0, xs);
  const dBuffer = device.createBuffer({ size: 16, usage: BU.STORAGE | BU.COPY_DST });
  device.queue.writeBuffer(dBuffer, 0, new Uint32Array([97, 0, 0, 0]));

  const counts = { asRecorded: 0, nowRight: 0, nowWrong: 0, stillWrong: 0, recordedWrong: 0 };
  for (const entry of HIGH_HALF_CASES) {
    const out = device.createBuffer({ size: N * 4, usage: BU.STORAGE | BU.COPY_SRC });
    const code = `@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@group(0) @binding(1) var<storage, read> xs: array<u32>;
@group(0) @binding(2) var<storage, read> ds: array<u32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = xs[id.x];
  let d = ds[0];
  out[id.x] = (${entry.wgsl}) + (d - d);
}`;
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: out } }, { binding: 1, resource: { buffer: xBuffer } }, { binding: 2, resource: { buffer: dBuffer } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(N);
    pass.end();
    const copy = device.createBuffer({ size: N * 4, usage: BU.MAP_READ | BU.COPY_DST });
    encoder.copyBufferToBuffer(out, 0, copy, 0, N * 4);
    device.queue.submit([encoder.finish()]);
    await copy.mapAsync(1);
    const got = new Uint32Array(copy.getMappedRange().slice(0));
    copy.unmap();
    copy.destroy();
    out.destroy();

    let differing = 0;
    let first = "";
    for (let index = 0; index < N; index += 1) {
      const want = entry.cpu(xs[index]) >>> 0;
      if (got[index] !== want) {
        differing += 1;
        if (first === "") first = `x = ${xs[index]}: device ${got[index]}, CPU ${want}`;
      }
    }
    const here = differing === 0 ? "right" : "wrong";
    if (entry.measured === "wrong") counts.recordedWrong += 1;
    if (here === "wrong" && entry.measured === "wrong") counts.stillWrong += 1;
    const verdict = here === entry.measured ? "as recorded" : here === "right" ? "NOW RIGHT (was wrong)" : "NOW WRONG (was right)";
    if (here === entry.measured) counts.asRecorded += 1;
    else if (here === "right") counts.nowRight += 1;
    else counts.nowWrong += 1;
    console.log(`${here.padEnd(5)} ${String(differing).padStart(3)} of ${N}  ${verdict.padEnd(22)} ${entry.wgsl}${first === "" ? "" : `    first: ${first}`}`);
  }
  gpu.dispose();

  console.log("");
  if (counts.nowRight === 0 && counts.nowWrong === 0) {
    console.log(`VERDICT: the bug is here, and its shape is the recorded one (${counts.stillWrong} of ${counts.recordedWrong} wrong lines are wrong, every right line is right).`);
  } else if (counts.nowWrong > 0) {
    console.log(`VERDICT: THE SHAPE HAS GROWN. ${counts.nowWrong} line(s) the product treats as safe are wrong on this device. See the header.`);
  } else if (counts.stillWrong === 0) {
    console.log(`VERDICT: the bug is NOT on this device: all ${counts.recordedWrong} recorded wrong lines are right here.`);
  } else {
    console.log(`VERDICT: the bug is partly gone: ${counts.nowRight} of ${counts.recordedWrong} recorded wrong lines are right here, ${counts.stillWrong} are still wrong.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
