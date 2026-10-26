import { open, stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

import type { LocalFilesPort } from "../agent/types.ts";
import { ltcLabAudioPath, ltcLabTourPathFor } from "../domain/import/ltc-lab/source.ts";

/**
 * VN100 — THE LOCAL HELPER'S FILE PORT, read-only and SCOPED to an ltc-lab show.
 *
 * Agent tools run against whatever this port reads, so it is not a disk reader. It reads
 * only these, by absolute path with no `..` segment, and refuses anything else, naming the
 * path:
 *  - a show package, a path ending `.ltcshow.tar`;
 *  - a project, a path ending `/project.json`; a tour, a path ending `/tour.json`, or the
 *    `tours/<slug>.json` that sits beside a project it has read (`ltcLabTourPathFor`);
 *  - a track's audio: `<audioDir>/<fileName>`, where `fileName` belongs to a track of a
 *    project.json this port has read whole and `audioDir` comes from a tour it has read.
 * So the audio scope grows only with what a show itself names. Widening the port (any
 * other file) is a separate decision (main, 2026-10-08).
 */
export function ltcLabLocalFiles(): LocalFilesPort {
  const tours = new Set<string>();
  const audioDirs = new Set<string>();
  const fileNames = new Set<string>();

  const audioAllowed = (path: string): boolean => {
    for (const dir of audioDirs) for (const name of fileNames) if (resolve(ltcLabAudioPath(dir, name)) === path) return true;
    return false;
  };

  const check = (path: string): string => {
    if (typeof path !== "string" || !isAbsolute(path) || path.split(/[\\/]/).includes("..") || normalize(path) !== path) {
      throw new Error(`"${path}" is refused: the local helper reads absolute paths only, with no "..", and only an ltc-lab show's files`);
    }
    if (path.endsWith(".ltcshow.tar") || path.endsWith("/project.json") || path.endsWith("/tour.json") || tours.has(path) || audioAllowed(path)) return path;
    throw new Error(
      `"${path}" is refused: the local helper reads only an ltc-lab show — a .ltcshow.tar, a project.json, its tour, or the audio a project it has read names`,
    );
  };

  /** A whole project or tour read: widen the scope to what it names. */
  const learn = (path: string, bytes: Uint8Array): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } catch {
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    const record = raw as Record<string, unknown>;
    if (path.endsWith("/project.json")) {
      const tour = ltcLabTourPathFor(path);
      if (tour !== null) tours.add(tour);
      if (Array.isArray(record["tracks"])) {
        for (const track of record["tracks"]) {
          const fileName = (track as Record<string, unknown> | null)?.["fileName"];
          if (typeof fileName === "string" && fileName !== "" && !fileName.split(/[\\/]/).includes("..")) fileNames.add(fileName);
        }
      }
    } else if (typeof record["audioDir"] === "string" && isAbsolute(record["audioDir"])) {
      audioDirs.add(record["audioDir"]);
    }
  };

  return {
    async size(path) {
      return (await stat(check(path))).size;
    },
    async read(path, offset, length) {
      const checked = check(path);
      const handle = await open(checked, "r");
      try {
        const buffer = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        const bytes = buffer.subarray(0, filled);
        const isJson = checked.endsWith(".json");
        if (isJson && offset === 0 && filled === (await handle.stat()).size) learn(checked, bytes);
        return bytes;
      } finally {
        await handle.close();
      }
    },
  };
}
