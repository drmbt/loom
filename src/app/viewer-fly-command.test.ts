import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import { FLY_AXES } from "@editor/viewer/orbit-gestures.ts";
import { NO_CAMERA_TO_FLY, registerViewerCommands } from "./viewer-commands.ts";
import type { ViewerHandlers } from "./viewer-commands.ts";

/**
 * §T1311b(b) — `viewer.fly` as the AGENT-FACING half of the gesture.
 *
 * The held key never reaches the bus (it is a gesture on the focused pane, integrated at
 * frame rate), so everything asserted here is about the OTHER caller: the command palette,
 * a rebound key with no auto-repeat, and an agent driving the viewer through the same door
 * a human uses. Its contract is its refusals — this project's shape is "refuse BY NAME"
 * (§T1111), and a fly that quietly did nothing when there was no camera, or that picked a
 * direction for a caller who named none (§V986), would be worse than one that is absent.
 */

const context = contextFor(alice);

function setup(handlers?: Partial<ViewerHandlers>) {
  const { bus } = createHarness();
  const holder = registerViewerCommands(bus);
  const flown: string[] = [];
  if (handlers !== undefined) {
    holder.current = {
      show: () => null,
      cameraHome: () => false,
      frameContent: async () => false,
      fly: (direction) => {
        flown.push(direction);
        return true;
      },
      editMapping: () => false,
      flyCamera: () => ({ flying: false, camera: null, refusal: NO_CAMERA_TO_FLY }),
      ...handlers,
    };
  }
  return { bus, flown };
}

describe("viewer.fly", () => {
  it("flies the direction it was given, and reports that it moved", async () => {
    const { bus, flown } = setup({});
    for (const direction of FLY_AXES) {
      const result = await bus.execute("viewer.fly", { direction }, context);
      expect(result.status).toBe("applied");
      expect(result.output).toEqual({ moved: true });
    }
    // Every direction the gesture knows is reachable from here — an agent is not offered a
    // narrower camera than a keyboard.
    expect(flown).toEqual([...FLY_AXES]);
  });

  it("refuses an unnamed or unknown direction BY NAME, rather than picking one", async () => {
    const { bus, flown } = setup({});
    const result = await bus.execute("viewer.fly", { direction: "northwest" }, context);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("viewer.flyDirection");
    // The refusal has to be usable: it names what was asked for AND what is accepted.
    expect(result.diagnostics?.[0]?.message).toContain("northwest");
    expect(result.diagnostics?.[0]?.suggestion).toContain("forward");
    expect(flown).toEqual([]);
  });

  it("refuses when no viewer is on screen, and moves nothing", async () => {
    const { bus, flown } = setup();
    const result = await bus.execute("viewer.fly", { direction: "forward" }, context);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("viewer.noOrbit");
    expect(result.output).toEqual({ moved: false });
    expect(flown).toEqual([]);
  });

  it("refuses when the viewer is showing something with no camera", async () => {
    // The pane answers false when the presented output declares neither a rig nor a view
    // camera — the same condition that greys the control out, reported with the same words.
    const { bus } = setup({ fly: () => false });
    const result = await bus.execute("viewer.fly", { direction: "forward" }, context);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("viewer.noOrbit");
  });

  it("moves nothing on a dry run", async () => {
    // A dry run is how a caller asks whether a command would be accepted; one that flew the
    // camera to answer would make "check first" the destructive path.
    const { bus, flown } = setup({});
    const result = await bus.execute("viewer.fly", { direction: "forward" }, { ...context, dryRun: true });
    expect(result.status).toBe("validated");
    expect(flown).toEqual([]);
  });
});

/**
 * §T970 — `viewer.flyCamera`: the lock, as the command `c`, the palette and an agent reach.
 * What the lock DOES is the pane's and is gated through the real app
 * (`src/tests/e2e/camera-fly.spec.ts`); this holds what the command says.
 */
describe("viewer.flyCamera", () => {
  it("arms the lock and names the camera it armed", async () => {
    const asked: Array<boolean | undefined> = [];
    const { bus } = setup({
      flyCamera: (on) => {
        asked.push(on);
        return { flying: on ?? true, camera: "camera_rig", refusal: null };
      },
    });
    const toggled = await bus.execute("viewer.flyCamera", {}, context);
    expect(toggled.status).toBe("applied");
    expect(toggled.output).toEqual({ flying: true, camera: "camera_rig" });
    const off = await bus.execute("viewer.flyCamera", { on: false }, context);
    expect(off.output).toEqual({ flying: false, camera: "camera_rig" });
    // Absent `on` is a toggle and reaches the pane as one; a stated one is passed as stated.
    expect(asked).toEqual([undefined, false]);
  });

  it("refuses by name when the picture has no camera to fly, and says the pane's own reason when it has one", async () => {
    const none = setup({});
    const refused = await none.bus.execute("viewer.flyCamera", {}, context);
    expect(refused.status).toBe("rejected");
    expect(refused.diagnostics?.[0]?.code).toBe("viewer.noCameraToFly");
    expect(refused.diagnostics?.[0]?.message).toBe(NO_CAMERA_TO_FLY);
    expect(refused.output).toEqual({ flying: false, camera: null });

    // A camera that IS there and cannot be flown: the driven sentence, not the generic one.
    const driven = setup({ flyCamera: () => ({ flying: false, camera: null, refusal: "Driven by expressions (Eye, Look At)." }) });
    const said = await driven.bus.execute("viewer.flyCamera", { on: true }, context);
    expect(said.status).toBe("rejected");
    expect(said.diagnostics?.[0]?.message).toBe("Driven by expressions (Eye, Look At).");
  });

  it("refuses with no viewer on screen, and a dry run arms nothing", async () => {
    const { bus } = setup();
    expect((await bus.execute("viewer.flyCamera", {}, context)).status).toBe("rejected");
    let armed = 0;
    const live = setup({
      flyCamera: () => {
        armed += 1;
        return { flying: true, camera: "camera_rig", refusal: null };
      },
    });
    const dry = await live.bus.execute("viewer.flyCamera", {}, { ...context, dryRun: true });
    expect(dry.status).toBe("validated");
    expect(armed).toBe(0);
  });
});
