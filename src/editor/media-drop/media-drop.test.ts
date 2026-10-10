import { describe, expect, it } from "vitest";
import type { GraphDocument } from "@domain/types/graph.ts";
import { conformsToKind, kindOfType } from "@domain/graph/node-kinds.ts";
import { parseFileReference } from "@domain/media/file-reference.ts";
import { containerVerdict, sampleEntryCodecs } from "./container-codec.ts";
import {
  captureDroppedFiles,
  classifyDroppedFile,
  mediaDropOperations,
  mediaNodeName,
  resolveDroppedMedia,
  type CapturedFile,
} from "./media-drop.ts";
import type { RetainedFileHandle } from "@ui/files/retained-files.ts";
import { movieWithCodec } from "./testing.ts";

const blob = (bytes: Uint8Array<ArrayBuffer>): Blob => new Blob([bytes]);

describe("container codec sniff (VN99)", () => {
  it("reads the sample entry wherever the moov sits", async () => {
    expect(await sampleEntryCodecs(blob(movieWithCodec("avc1")))).toEqual(["avc1"]);
    expect(await sampleEntryCodecs(blob(movieWithCodec("Hap1", { moovLast: true })))).toEqual(["Hap1"]);
  });

  it("refuses DXV, HAP and ProRes by name and lets H.264 through", async () => {
    expect(await containerVerdict(blob(movieWithCodec("avc1")))).toEqual({ playable: true });
    expect(await containerVerdict(blob(movieWithCodec("DXD3")))).toEqual({ playable: false, what: "DXV (Resolume) (DXD3)" });
    expect(await containerVerdict(blob(movieWithCodec("Hap1")))).toEqual({ playable: false, what: "HAP (Hap1)" });
    expect(await containerVerdict(blob(movieWithCodec("apch")))).toEqual({ playable: false, what: "Apple ProRes 422 HQ (apch)" });
  });

  it("refuses AVI by container, and takes a file it cannot parse as playable", async () => {
    const avi = new TextEncoder().encode("RIFF\0\0\0\0AVI LIST");
    expect(await containerVerdict(blob(avi))).toEqual({ playable: false, what: "an AVI container" });
    expect(await containerVerdict(blob(new TextEncoder().encode("\x1aE\xdf\xa3 webm-ish bytes")))).toEqual({ playable: true });
    // A box claiming more bytes than the file has stops the walk instead of reading past it.
    const broken = movieWithCodec("Hap1").slice(0, 40);
    expect(await containerVerdict(blob(broken))).toEqual({ playable: true });
  });
});

describe("classifying a dropped file", () => {
  it("prefers the MIME type and falls back to the extension", () => {
    expect(classifyDroppedFile("clip.mov", "")).toBe("video");
    expect(classifyDroppedFile("song.ogg", "")).toBe("audio");
    expect(classifyDroppedFile("theme.ogg", "video/ogg")).toBe("video");
    expect(classifyDroppedFile("still.png", "")).toBe("still");
    expect(classifyDroppedFile("Bloom.loom.json", "application/json")).toBe("component");
    expect(classifyDroppedFile("notes.txt", "text/plain")).toBe("other");
  });
});

describe("naming and laying out the nodes", () => {
  const graph = (labels: string[]): GraphDocument => ({
    revision: 0,
    edges: {},
    groups: {},
    nodes: Object.fromEntries(labels.map((label, index) => [`n${index}`, { id: `n${index}`, type: "x", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label }])),
  } as unknown as GraphDocument);

  it("names a node kind_role from its file, numbering a taken name", () => {
    const taken = new Set(["movie_intro"]);
    const first = mediaNodeName("Intro.mp4", "movieFileIn", taken);
    const second = mediaNodeName("Kick Loop (final).wav", "audioFileIn", taken);
    expect(first).toBe("movie_intro2");
    expect(second).toBe("audiofile_kick_loop_final");
    expect(conformsToKind(first!, kindOfType("movieFileIn"))).toBe(true);
    expect(conformsToKind(second!, kindOfType("audioFileIn"))).toBe(true);
    expect(mediaNodeName("....mp4", "movieFileIn", taken)).toBeUndefined();
  });

  it("lays the files side by side, locked to the timeline (a still has no transport)", () => {
    const operations = mediaDropOperations(graph(["movie_a"]), [
      { name: "a.mp4", kind: "video", reference: "blob:1#a.mp4", retained: false },
      { name: "b.png", kind: "still", reference: "blob:2#b.png", retained: false },
      { name: "c.wav", kind: "audio", reference: "blob:3#c.wav", retained: false },
    ], { x: 100, y: 50 });
    expect(operations).toEqual([
      { op: "addNode", ref: "$media0", type: "movieFileIn", position: { x: 100, y: 50 }, parameters: { file: "blob:1#a.mp4", playMode: "timeline" }, label: "movie_a2" },
      { op: "addNode", ref: "$media1", type: "movieFileIn", position: { x: 340, y: 50 }, parameters: { file: "blob:2#b.png" }, label: "movie_b" },
      { op: "addNode", ref: "$media2", type: "audioFileIn", position: { x: 580, y: 50 }, parameters: { file: "blob:3#c.wav", playMode: "timeline" }, label: "audiofile_c" },
    ]);
  });
});

describe("retaining a dropped file", () => {
  const handle = (name: string): RetainedFileHandle & { kind: "file" } => ({
    kind: "file",
    name,
    getFile: async () => new File([], name),
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
  });

  it("asks for the handle synchronously and retains it as the picker does", async () => {
    const remembered: Array<[string, string]> = [];
    let asked = 0;
    const file = new File([movieWithCodec("avc1")], "clip.mp4", { type: "video/mp4" });
    const captured = captureDroppedFiles({
      items: [{ kind: "file", getAsFile: () => file, getAsFileSystemHandle: () => { asked += 1; return Promise.resolve(handle("clip.mp4")); } }],
      files: [file],
    });
    // Asked during the call, not later: the browser empties the items when the event returns.
    expect(asked).toBe(1);
    const resolved = await resolveDroppedMedia(captured, {
      files: { remember: async (h, kind) => { remembered.push([h.name, kind]); return `loom-file:id1/${kind}#${h.name}`; } },
      createObjectURL: () => { throw new Error("no fallback expected"); },
    });
    expect(remembered).toEqual([["clip.mp4", "video"]]);
    expect(resolved.media).toEqual([{ name: "clip.mp4", kind: "video", reference: "loom-file:id1/video#clip.mp4", retained: true }]);
    expect(parseFileReference(resolved.media[0]!.reference)?.kind).toBe("video");
  });

  it("falls back to a session blob URL with the name in the fragment when there is no handle", async () => {
    const captured: CapturedFile[] = [{ file: new File(["RIFF"], "hit.wav", { type: "audio/wav" }), handle: Promise.resolve(null) }];
    const resolved = await resolveDroppedMedia(captured, { files: null, createObjectURL: () => "blob:session/1" });
    expect(resolved.media).toEqual([{ name: "hit.wav", kind: "audio", reference: "blob:session/1#hit.wav", retained: false }]);
  });

  it("refuses a HAP .mov naming the codec and 'transcode first', and an unknown file by name", async () => {
    const captured: CapturedFile[] = [
      { file: new File([movieWithCodec("Hap1")], "loop.mov"), handle: Promise.resolve(null) },
      { file: new File(["x"], "notes.txt", { type: "text/plain" }), handle: Promise.resolve(null) },
    ];
    const resolved = await resolveDroppedMedia(captured, { files: null, createObjectURL: () => "blob:x" });
    expect(resolved.media).toEqual([]);
    expect(resolved.refusals.map((each) => each.code)).toEqual(["media.drop.transcodeFirst", "media.drop.unsupported"]);
    expect(resolved.refusals[0]!.message).toContain("HAP (Hap1)");
    expect(resolved.refusals[0]!.message).toContain("Transcode it first");
  });
});
