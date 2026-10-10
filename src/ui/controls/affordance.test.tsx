// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { NumberField } from "./number-field.tsx";
import type { EditPhase } from "./types.ts";

/**
 * T1033 — the interaction pass over the parameter kit, gated.
 *
 * Three owner reports, one file:
 *   1. "we never know if we can edit or not"        → three states must LOOK like three states
 *   2. "the double-click to reset is weird"         → gated in `controls.test.tsx`
 *   3. "grabbing the slider is awkward. it's a bit weak" → the press must survive being deliberate
 *
 * (3) is the one with a mechanism, and it is the first `describe` below.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

function Harness({ onEmit }: { onEmit: (value: number, phase: EditPhase) => void }) {
  const [value, setValue] = useState(0);
  return (
    <NumberField
      label="Radius"
      value={value}
      spec={{ step: 1 }}
      onChange={(next, phase) => {
        setValue(next);
        onEmit(next, phase);
      }}
    />
  );
}

const surfaceOf = (): HTMLElement =>
  screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;

/** Longer than `LADDER_HOLD_MS`, so the hold has definitely fired. */
async function holdPast(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
}

/**
 * THE DEFECT, MEASURED IN THE RUNNING APP before it was fixed: press a Level node's
 * Contrast field, wait 500 ms, drag 80 px, release — and the readout was still "1.00".
 * `onPointerDown`'s hold timer nulled `dragRef`, so every subsequent move landed on a dead
 * ref while a popout nobody asked for took the focus.
 *
 * That is the whole of "grabbing the slider is awkward", and it punished precisely the
 * user the fix is for: the one who presses, aims, and only then moves. A drag that begins
 * within 400 ms always worked, which is why nothing caught this — the gesture only fails
 * when it is performed deliberately.
 *
 * §V851 — the negative constant comes from RUNNING the defect, not from derivation: the
 * broken build emits NOTHING at all (`emitted` stays empty and the value stays at its
 * start), so an assertion on the moved value cannot be satisfied by the wrong answer.
 */
describe("T1033 — a press that pauses still drags", () => {
  it("keeps the gesture when the hold opens the ladder underneath it", async () => {
    const emitted: Array<[number, EditPhase]> = [];
    render(<Harness onEmit={(value, phase) => emitted.push([value, phase])} />);
    const surface = surfaceOf();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await holdPast();
    // The hold did its own job: the reach is on screen.
    expect(screen.getByRole("listbox", { name: "Radius drag magnitude" })).toBeDefined();

    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40 });

    // 40 px at 2 px per step, at the manifest's step of 1. The defect emitted [].
    expect(emitted.at(-1), "the paused press never became a drag").toEqual([20, "commit"]);
  });

  it("measures the drag from the ORIGINAL press, not from where the ladder closed", async () => {
    // If the gesture restarted at the move that dismissed the popout, its delta would be 0
    // and the value would not move — the same symptom as the defect, one layer subtler.
    // Absolute travel from the press is also what makes dragging out and back land where
    // it started, which is the property a restart would quietly cost.
    const emitted: number[] = [];
    render(<Harness onEmit={(value) => emitted.push(value)} />);
    const surface = surfaceOf();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 100 });
    await holdPast();
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 120 });
    expect(emitted.at(-1)).toBe(10);
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100 });
    expect(emitted.at(-1), "dragging back to the press point did not return the value").toBe(0);
  });

  it("gets the ladder out of the way once the press turns out to be a drag", async () => {
    render(<Harness onEmit={() => {}} />);
    const surface = surfaceOf();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await holdPast();
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40 });

    expect(
      screen.queryByRole("listbox", { name: "Radius drag magnitude" }),
      "a popout left open over the rows below is chrome the drag did not ask for",
    ).toBeNull();
  });

  it("still lets a STILL press keep the ladder — the case the fix could swallow", async () => {
    // Non-vacuity for all three above. Making the move win must not make the hold lose:
    // press, hold, release without travelling is the T228 gesture and it stays.
    const emitted: number[] = [];
    render(<Harness onEmit={(value) => emitted.push(value)} />);
    const surface = surfaceOf();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await holdPast();
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 0 });

    expect(screen.getByRole("listbox", { name: "Radius drag magnitude" })).toBeDefined();
    expect(emitted, "a still press wrote a value").toEqual([]);
    // And it did not fall through to click-to-type, which would blur the popout it opened.
    expect(screen.getByRole("spinbutton", { name: "Radius" }).getAttribute("readonly")).not.toBeNull();
  });
});

/**
 * The grab surface, as a STRUCTURE rather than as a rendered box.
 *
 * jsdom lays nothing out, so `getBoundingClientRect` here is 0×0 for every element and a
 * measured assertion would pass against a 1px target. What this environment can check
 * honestly is (a) which element the gesture is mounted on and (b) the declaration that
 * makes that element taller than the field it draws. Both are the change.
 */
describe("T1033 — the grab surface is the host, and it is taller than the field", () => {
  it("captures the pointer on the host, so the gesture's extent is the host's", () => {
    const captured: number[] = [];
    render(<Harness onEmit={() => {}} />);
    const field = surfaceOf();
    const host = field.parentElement as HTMLElement;
    host.setPointerCapture = (pointerId: number) => {
      captured.push(pointerId);
    };
    field.setPointerCapture = () => {
      throw new Error("the field must not capture: it is 4px shorter than the target");
    };

    fireEvent.pointerDown(field, { button: 0, pointerId: 7, clientX: 0 });
    expect(captured, "the press was captured by the painted field, not the grab band").toEqual([7]);
  });

  it("tells the cursor which of the three answers this field gives", () => {
    const { rerender } = render(
      <NumberField label="Radius" value={0} spec={{ step: 1 }} onChange={() => {}} />,
    );
    const host = () => surfaceOf().parentElement as HTMLElement;
    expect(host().getAttribute("data-grab")).toBe("drag");

    rerender(
      <NumberField label="Radius" value={0} spec={{ step: 1 }} drivenBy="Expression" onChange={() => {}} />,
    );
    // §V830: a driven field must not advertise a gesture it is about to refuse — including
    // on the 4px of grab band that is not the field itself.
    expect(host().getAttribute("data-grab")).toBe("none");

    rerender(<NumberField label="Radius" value={0} spec={{ step: 1 }} disabled onChange={() => {}} />);
    expect(host().getAttribute("data-grab")).toBe("none");
  });
});
