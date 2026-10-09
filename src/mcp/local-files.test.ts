import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ltcLabLocalFiles } from "./local-files.ts";

/**
 * VN100 — the helper's file port reads an ltc-lab show and NOTHING ELSE (main's scope,
 * 2026-10-08): an arbitrary path is refused by name, and a track's audio is readable only
 * once a project it read names it and a tour it read places it.
 */

const root = mkdtempSync(join(tmpdir(), "vn100-local-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const audioDir = join(root, "audio");
mkdirSync(join(root, "data", "show"), { recursive: true });
mkdirSync(join(root, "tours"), { recursive: true });
mkdirSync(audioDir, { recursive: true });
const projectPath = join(root, "data", "show", "project.json");
const tourPath = join(root, "tours", "show.json");
writeFileSync(projectPath, JSON.stringify({ fps: 30, tracks: [{ id: "a", fileName: "a.wav" }] }));
writeFileSync(tourPath, JSON.stringify({ name: "Show", audioDir }));
writeFileSync(join(audioDir, "a.wav"), "RIFFa");
writeFileSync(join(audioDir, "secret.wav"), "RIFFs");
writeFileSync(join(root, "notes.txt"), "private");

const whole = async (port: ReturnType<typeof ltcLabLocalFiles>, path: string): Promise<string> =>
  new TextDecoder().decode(await port.read(path, 0, await port.size(path)));

describe("ltcLabLocalFiles (VN100)", () => {
  it("refuses an arbitrary path, naming it", async () => {
    const port = ltcLabLocalFiles();
    await expect(port.size("/etc/passwd")).rejects.toThrow('"/etc/passwd" is refused');
    await expect(port.read("/etc/passwd", 0, 10)).rejects.toThrow('"/etc/passwd" is refused');
    await expect(port.read(join(root, "notes.txt"), 0, 10)).rejects.toThrow("is refused");
  });

  it("refuses a relative path and one that climbs out with ..", async () => {
    const port = ltcLabLocalFiles();
    await expect(port.size("data/show/project.json")).rejects.toThrow("absolute paths only");
    await expect(port.size(`${root}/data/show/../show/project.json`)).rejects.toThrow("absolute paths only");
  });

  it("reads the audio a read project names, from the read tour's audioDir, and no other file there", async () => {
    const port = ltcLabLocalFiles();
    const audio = join(audioDir, "a.wav");
    await expect(port.size(audio)).rejects.toThrow("is refused");
    expect(await whole(port, projectPath)).toContain('"a.wav"');
    await expect(port.size(tourPath)).resolves.toBeGreaterThan(0); // beside the project, now in scope
    expect(await whole(port, tourPath)).toContain("audioDir");
    expect(await whole(port, audio)).toBe("RIFFa");
    await expect(port.size(join(audioDir, "secret.wav"))).rejects.toThrow("is refused");
  });

  it("reads a byte range of a show package", async () => {
    const tar = join(root, "show.ltcshow.tar");
    writeFileSync(tar, "0123456789");
    const port = ltcLabLocalFiles();
    expect(new TextDecoder().decode(await port.read(tar, 3, 4))).toBe("3456");
    expect(await port.size(tar)).toBe(10);
  });
});
