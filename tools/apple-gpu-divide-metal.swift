// B263 — the divide of a high half, in PURE METAL: no Dawn, no Tint, no browser.
//
//   xcrun swift tools/apple-gpu-divide-metal.swift
//
// WHEN TO RUN IT: to show that the wrong value is Apple's and not WebGPU's (this is the
// reproduction to attach to an Apple feedback report), and after a macOS update to see
// whether it is fixed. `tools/apple-gpu-divide-canary.mjs` asks the same question through
// Dawn, over the whole table the product's warning is held to.
//
// WHAT IT DOES: compiles one Metal compute kernel per line below, each computing ONE
// expression of a u32 read from a buffer, runs it on the default device and prints the GPU's
// values over the CPU's.
//
// WHAT ITS OUTPUT MEANS: a line marked WRONG is one Apple's Metal stack miscompiles on this
// machine. On an M3 Max, macOS 26.3.1 (2026-10-06):
//   (x >> 16) % 97                      WRONG  (x = 96 gives 15872; the answer is 0)
//   (x >> 16) / 97                      right  (the front end folds it into one 32-bit divide)
//   the same two as Tint writes them    WRONG  (the quotient too: x = 96 gives 512)
//   (x >> 17) % 97, (x >> 16) / 64, x % 97   right
// "As Tint writes it" is the zero-divisor guard WebGPU requires round every integer divide,
// which is how a WGSL `/` or `%` reaches Metal. Every line right means the bug is gone here.
import Metal

let helpers = """
uint tint_div(uint a, uint b) { return (a / select(b, 1u, (b == 0u))); }
uint tint_mod(uint a, uint b) { return (a - ((a / select(b, 1u, (b == 0u))) * select(b, 1u, (b == 0u)))); }
"""
let kernels: [(name: String, body: String, cpu: (UInt32) -> UInt32)] = [
  ("(x >> 16) % 97", "(x >> 16u) % 97u", { ($0 >> 16) % 97 }),
  ("(x >> 16) / 97", "(x >> 16u) / 97u", { ($0 >> 16) / 97 }),
  ("(x >> 16) % 97, as Tint writes it", "tint_mod((x >> (16u & 31u)), 97u)", { ($0 >> 16) % 97 }),
  ("(x >> 16) / 97, as Tint writes it", "tint_div((x >> (16u & 31u)), 97u)", { ($0 >> 16) / 97 }),
  ("(x >> 16) / 3, as Tint writes it", "tint_div((x >> (16u & 31u)), 3u)", { ($0 >> 16) / 3 }),
  ("(x >> 17) % 97, as Tint writes it", "tint_mod((x >> (17u & 31u)), 97u)", { ($0 >> 17) % 97 }),
  ("(x >> 16) / 64, as Tint writes it", "tint_div((x >> (16u & 31u)), 64u)", { ($0 >> 16) / 64 }),
  ("x % 97", "x % 97u", { $0 % 97 }),
]
let source = "#include <metal_stdlib>\nusing namespace metal;\n" + helpers + "\n" + kernels.enumerated().map { index, kernel in
  """
  kernel void k\(index)(device uint* out [[buffer(0)]], const device uint* in [[buffer(1)]], uint3 id [[thread_position_in_grid]]) {
    uint x = in[id.x];
    out[id.x] = \(kernel.body);
  }
  """
}.joined(separator: "\n")

let device = MTLCreateSystemDefaultDevice()!
print("device: \(device.name)")
let library = try! device.makeLibrary(source: source, options: nil)
// 0, a value whose high half is 0, 1, exactly 97, an ordinary one, the top bit alone, all ones, and the consumer's.
let xs: [UInt32] = [0, 96, 65536, 0x0061_0000, 0x1234_5678, 0x8000_0000, 0xFFFF_FFFF, 2_352_562_176]
let input = device.makeBuffer(bytes: xs, length: xs.count * 4, options: .storageModeShared)!
let queue = device.makeCommandQueue()!
let column = { (text: String) in text.padding(toLength: 8, withPad: " ", startingAt: 0) }
print(column("x:") + xs.map { String(format: "%11u", $0) }.joined())
var wrongLines = 0
for (index, kernel) in kernels.enumerated() {
  let pipeline = try! device.makeComputePipelineState(function: library.makeFunction(name: "k\(index)")!)
  let output = device.makeBuffer(length: xs.count * 4, options: .storageModeShared)!
  let commands = queue.makeCommandBuffer()!
  let encoder = commands.makeComputeCommandEncoder()!
  encoder.setComputePipelineState(pipeline)
  encoder.setBuffer(output, offset: 0, index: 0)
  encoder.setBuffer(input, offset: 0, index: 1)
  encoder.dispatchThreadgroups(MTLSize(width: xs.count, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 1, height: 1, depth: 1))
  encoder.endEncoding()
  commands.commit()
  commands.waitUntilCompleted()
  let out = output.contents().bindMemory(to: UInt32.self, capacity: xs.count)
  let wrong = xs.indices.filter { out[$0] != kernel.cpu(xs[$0]) }.count
  if wrong > 0 { wrongLines += 1 }
  print("\(kernel.name):  \(wrong == 0 ? "right" : "WRONG on \(wrong) of \(xs.count)")")
  print(column("  GPU:") + xs.indices.map { String(format: "%11u", out[$0]) }.joined())
  print(column("  CPU:") + xs.map { String(format: "%11u", kernel.cpu($0)) }.joined())
}
print(wrongLines == 0 ? "\nVERDICT: every line is right: the bug is not on this machine." : "\nVERDICT: \(wrongLines) of \(kernels.count) lines are wrong in pure Metal on this machine.")
