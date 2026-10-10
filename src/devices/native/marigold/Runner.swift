// One static, main-owned Marigold V2 job. The desktop executor verifies every
// model artifact, bounds its input, owns these paths and waits for process exit.
import Dispatch
import Darwin
import Foundation
import MLX
import MLXMarigoldV2

private struct RunnerFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

private let memoryActiveLimit = 24 * 1024 * 1024 * 1024
private let memoryPeakLimit = 26 * 1024 * 1024 * 1024

// MLX's memoryLimit schedules/reclaims buffers; it is not a hard allocation cap.
// Create the handler outside MainActor so its utility-queue callback stays valid.
private nonisolated func memoryWatchdog() -> DispatchSourceTimer {
    let watchdog = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    watchdog.schedule(deadline: .now(), repeating: .milliseconds(100))
    watchdog.setEventHandler {
        let active = MLX.Memory.activeMemory, peak = MLX.Memory.peakMemory
        if active > memoryActiveLimit || peak > memoryPeakLimit {
            let message = Data(("Marigold preparation memory limit exceeded: activeBytes=\(active), activeLimitBytes=\(memoryActiveLimit), peakBytes=\(peak), peakLimitBytes=\(memoryPeakLimit). Choose a smaller native inference size; no size was substituted.\n").utf8.prefix(4096))
            do { try FileHandle.standardError.write(contentsOf: message) }
            catch { Darwin._exit(1) }
            // Skip MLX global teardown while synchronous Metal work is still live.
            Darwin._exit(1)
        }
    }
    watchdog.resume()
    return watchdog
}

private struct Request: Decodable {
    let version: Int
    let width: Int
    let height: Int
    let inputSide: Int
    let seed: UInt32

    func validate() throws {
        guard version == 1, [512, 768, 1024, 1280, 1536].contains(inputSide),
              width >= 16, height >= 16, width <= 1536, height <= 1536,
              width % 16 == 0, height % 16 == 0, max(width, height) == inputSide else {
            throw RunnerFailure("Invalid Marigold preparation dimensions or request version")
        }
    }
}

private struct Arguments {
    let assets: URL
    let request: URL
    let input: URL
    let output: URL

    init(_ arguments: [String]) throws {
        let flags = ["--assets", "--request", "--input", "--output"]
        guard arguments.count == 8 else {
            throw RunnerFailure("Expected --assets, --request, --input and --output")
        }
        var values: [String: URL] = [:]
        for index in stride(from: 0, to: arguments.count, by: 2) {
            let flag = arguments[index]
            let path = arguments[index + 1]
            guard flags.contains(flag), values[flag] == nil, path.hasPrefix("/") else {
                throw RunnerFailure("Invalid or duplicate Marigold worker argument")
            }
            values[flag] = URL(fileURLWithPath: path)
        }
        guard let assets = values["--assets"], let request = values["--request"],
              let input = values["--input"], let output = values["--output"],
              Set([request.path, input.path, output.path]).count == 3 else {
            throw RunnerFailure("Marigold worker paths must be distinct and main-owned")
        }
        self.assets = assets
        self.request = request
        self.input = input
        self.output = output
    }
}

private func emit(_ object: [String: Any]) {
    do {
        var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard data.count < 64 * 1024 else { throw RunnerFailure("Native protocol message exceeded its bound") }
        data.append(0x0a)
        try FileHandle.standardOutput.write(contentsOf: data)
    } catch {
        fail(error)
    }
}

private func progress(_ phase: String, _ message: String) {
    emit(["kind": "progress", "phase": phase, "message": message])
}

private func fail(_ error: Error) -> Never {
    let message = Data(("Marigold preparation failed: \(error)\n").utf8.prefix(4096))
    // A broken stderr is terminal too. Avoid a second protocol or success result.
    do { try FileHandle.standardError.write(contentsOf: message) }
    catch { exit(1) }
    exit(1)
}

private func regularFileBytes(_ path: URL, maximum: Int) throws -> Data {
    let values = try path.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true,
          let size = values.fileSize, size >= 0, size <= maximum else {
        throw RunnerFailure("Native request file is not a bounded regular file")
    }
    let data = try Data(contentsOf: path)
    guard data.count == size else { throw RunnerFailure("Native request file changed during reading") }
    return data
}

private func elapsedMilliseconds(since start: ContinuousClock.Instant) -> Double {
    let duration = start.duration(to: ContinuousClock.now)
    return Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) * 1e-15
}

private func execute(_ arguments: Arguments) throws {
    let requestBytes = try regularFileBytes(arguments.request, maximum: 4096)
    let expectedKeys: Set<String> = ["version", "width", "height", "inputSide", "seed"]
    guard let object = try JSONSerialization.jsonObject(with: requestBytes) as? [String: Any],
          Set(object.keys) == expectedKeys else {
        throw RunnerFailure("Native preparation request has unexpected fields")
    }
    let request = try JSONDecoder().decode(Request.self, from: requestBytes)
    try request.validate()
    let rgba = try regularFileBytes(arguments.input, maximum: 1536 * 1536 * 4)
    guard rgba.count == request.width * request.height * 4 else {
        throw RunnerFailure("Native preparation RGBA length does not match the requested dimensions")
    }
    var pixels = [Float](repeating: 0, count: request.width * request.height * 3)
    for pixel in 0 ..< request.width * request.height {
        pixels[pixel * 3] = Float(rgba[pixel * 4])
        pixels[pixel * 3 + 1] = Float(rgba[pixel * 4 + 1])
        pixels[pixel * 3 + 2] = Float(rgba[pixel * 4 + 2])
    }
    let image = FloatImage(width: request.width, height: request.height, channels: 3, pixels: pixels)
    // A killed Electron process cannot await IPC retirement. Watch its identity
    // independently of synchronous Metal work and terminate this owned worker.
    let parent = getppid()
    guard parent > 1 else { throw RunnerFailure("Native preparation has no living owner") }
    let watchdog = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    watchdog.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
    watchdog.setEventHandler { if getppid() != parent { Darwin._exit(1) } }
    watchdog.resume()
    defer { watchdog.cancel() }
    let start = ContinuousClock.now
    MLX.Memory.cacheLimit = 512 * 1024 * 1024
    MLX.Memory.memoryLimit = memoryActiveLimit
    let memoryGuard = memoryWatchdog()
    defer { memoryGuard.cancel() }
    let assets = MarigoldAssetPaths(root: arguments.assets)
    let config = MarigoldSessionConfig(assets: assets, checkpoint: .depthLogStage2,
        seed: UInt64(request.seed), loraMode: .runtime)
    let session = try MarigoldSession.loadQuantized(config, shards: assets.transformerShards(),
        normOutBias: assets.root.appending(path: "auxiliary/norm_out_bias.safetensors"),
        progress: { message in progress("preparing", message) })
    let prediction = session.predict(image, size: (request.width, request.height),
        progress: { message in progress("processing", message) })
    guard prediction.width == request.width, prediction.height == request.height, prediction.channels == 1,
          prediction.values.count == request.width * request.height,
          prediction.values.allSatisfy({ $0.isFinite }) else {
        throw RunnerFailure("Marigold returned invalid dimensions or nonfinite depth samples")
    }
    let millis = elapsedMilliseconds(since: start)
    let peakBytes = MLX.Memory.peakMemory
    guard millis.isFinite, millis >= 0, peakBytes >= 0 else {
        throw RunnerFailure("Marigold returned invalid performance measurements")
    }
    guard MLX.Memory.activeMemory <= memoryActiveLimit, peakBytes <= memoryPeakLimit else {
        throw RunnerFailure("Marigold exceeded the 24 GiB active/26 GiB peak preparation budget; choose a smaller native inference size")
    }
    progress("finishing", "Saving the native float32 depth prediction…")
    // Explicit little-endian float32: no PNG, quantization, normalization or
    // result path provided by a model. The executor owns this exact output path.
    let words = prediction.values.map { $0.bitPattern.littleEndian }
    let bytes = words.withUnsafeBytes { Data($0) }
    try bytes.write(to: arguments.output, options: [.withoutOverwriting])
    session.releaseCachedBuffers()
    emit(["kind": "result", "width": request.width, "height": request.height,
          "semantics": "relative-log", "measurement": ["backend": "mlx", "millis": millis, "peakBytes": peakBytes]])
}

@main
private enum LoomMarigoldRunner {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--probe"] {
            // Do not inspect MLX.Memory, load weights or construct a GPU model.
            emit(["protocol": 1, "runtime": "mlx-swift", "quantization": "mixed-q4-q8-group64",
                  "inputSides": [512, 768, 1024, 1280, 1536]])
            return
        }
        do { try execute(Arguments(arguments)) }
        catch { fail(error) }
    }
}
