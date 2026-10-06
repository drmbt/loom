import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DocumentRefused } from "../../compiler/document-findings.ts";
import { STAGE_GLB_PATH, STAGE_SESSION_PATH, builtSession, upgradedSession } from "./session.ts";

/**
 * Stage previz — the committed sessions against the committed GLB, through what build.ts and
 * upgrade.ts themselves write (session.ts).
 *
 * The base session is GENERATED, so it is held to its source byte for byte, as the examples
 * are (`src/examples/sync.test.ts`). After a change to the source or a new export, regenerate
 * it with the command in build.ts's header. `-7` and `-8` are sessions saved from the app.
 */
const glb = new Uint8Array(readFileSync(STAGE_GLB_PATH));
const session = (name: string): string => readFileSync(`projects/stage-previz/${name}`, "utf8");

describe("stage previz: the committed sessions", () => {
  it("the base session is what the source builds from the committed GLB, byte for byte", () => {
    expect(readFileSync(STAGE_SESSION_PATH, "utf8")).toBe(builtSession(glb));
  });

  it.each(["stage-previz.loom.json", "stage-previz-7.loom.json"])("%s is up to date: an upgrade writes it back unchanged", (name) => {
    expect(upgradedSession(session(name), glb)).toBe(session(name));
  });

  it("an upgrade of the -8 session is refused, by name, and writes nothing", () => {
    // Its rig lives inside six components, which applyRig does not reach: what it would write
    // names nodes the root graph no longer has, and the checked save refuses that.
    expect(() => upgradedSession(session("stage-previz-8.loom.json"), glb)).toThrow(DocumentRefused);
  });
});
