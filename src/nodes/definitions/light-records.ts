import { scratchResourceId } from "../../compiler/resources.ts";
import { LIGHT_RECORD_BYTES, lightTableCellsAt } from "../shaders/scene-lights.wgsl.ts";

/**
 * T1589b, T1623b — A RENDER'S LIGHT TABLE, at the node seam
 * (docs/lights-from-pointset-design-2026-10-06.md, sections 3.9, 13 and 15).
 *
 * Three buffers, and who owns each:
 *
 *  - THE LIGHT'S RECORDS (`scratch:<light>:lightRecords`): one record a point, resolved once
 *    a frame by the Light itself, so two Renders that list one Light resolve it once.
 *  - THE RENDER'S TABLE (`scratch:<render>:lightTable`): a header, then the records of its
 *    named Lights that do not cast and of every pointset Light it lists, and behind them the
 *    grid's cells. A lit draw binds this one buffer and nothing else of those lights.
 *  - THE RENDER'S NAMED ROWS (`scratch:<render>:lightNamed`): see `NAMED_LIGHT_STEP`.
 *
 * The layout is the shader half's (`scene-lights.wgsl.ts`): a record is 64 bytes, a Light's
 * buffer keeps record after record and a table keeps row after row, and a table's header
 * says how many rows it has, how many words a cell has and where the cells start. Nothing of
 * it is a number in a shader's text.
 *
 * ## The capacity is the contract
 *
 * A table has as many rows as its Lights' pointsets have CAPACITY, live or not, and the
 * steps its named Lights take, and a cell has one bit a row. So the one limit of the path is
 * a number known at compile, and going
 * past it is a refusal by name there (`MAX_LIGHT_SLOTS`), never a light dropped on the GPU
 * where nothing could say so. A table compacted to its live lights would move that limit to
 * run time; it is not compacted.
 */

/** The most rows one Render's table holds: 32 words a cell. Raising it wants a two-level mask (T1624b). */
export const MAX_LIGHT_SLOTS = 1024;
/**
 * T1623b — THE NAMED LIGHTS' ROWS. A Render's Lights in Single mode that do not cast are
 * rows of its table too, written by the CPU as values (the buffer-values seam) into ONE
 * buffer of the Render's own, laid out as a Light's records are and gathered like any set.
 *
 * Its capacity grows in STEPS, so that adding a Light, removing one or changing one is a
 * write and never a rebuild: nothing a lit draw binds changes shape inside a step. The step
 * is one word of a cell's mask.
 */
export const NAMED_LIGHT_STEP = 32;
/** Rows the named Lights' buffer has room for: the step that holds `count`, and never none. */
export const namedLightCapacity = (count: number): number => Math.max(1, Math.ceil(count / NAMED_LIGHT_STEP)) * NAMED_LIGHT_STEP;

/**
 * THE GRID — constants of the generator, not knobs (§V90: neither is a look decision). About
 * 144 tiles on screen, as near square as the picture's aspect allows, by 24 slices in depth.
 * Measured on Dawn in a tunnel of 1,024 lights: 32 × 18 × 32 cells drew no faster than
 * 16 × 9 × 24, so a finer grid buys nothing a document would feel.
 */
export const LIGHT_GRID_TILES = 144;
export const LIGHT_GRID_SLICES = 24;

/** Tiles across, tiles down and slices for a picture of this size: 16 × 9 × 24 at 16:9, 12 × 12 × 24 square. */
export function lightGridDimensions(resolution: readonly [number, number]): readonly [number, number, number] {
  const aspect = Math.max(resolution[0], 1) / Math.max(resolution[1], 1);
  const across = Math.max(1, Math.min(LIGHT_GRID_TILES, Math.round(Math.sqrt(LIGHT_GRID_TILES * aspect))));
  const down = Math.max(1, Math.round(LIGHT_GRID_TILES / across));
  return [across, down, LIGHT_GRID_SLICES];
}

/** The scratch keys of the three buffers. */
export const LIGHT_RECORDS_KEY = "lightRecords";
export const LIGHT_TABLE_KEY = "lightTable";
export const LIGHT_NAMED_KEY = "lightNamed";

const RECORD_WORDS = LIGHT_RECORD_BYTES / 4;

type BufferScratch = { readonly kind: "buffer"; readonly key: string; readonly stride: number; readonly capacity: number };

export interface LightRecordStorage {
  readonly resourceId: string;
  /** A plain buffer of u32 words: written by the Light's resolve pass, read by each Render's gather. */
  readonly scratch: BufferScratch;
}

/** A Light's own records: one a point of its pointset. */
export function lightRecordStorage(nodeId: string, capacity: number): LightRecordStorage {
  return {
    resourceId: scratchResourceId(nodeId, LIGHT_RECORDS_KEY),
    scratch: { kind: "buffer", key: LIGHT_RECORDS_KEY, stride: 4, capacity: capacity * RECORD_WORDS },
  };
}

/** A Render's named Lights: `capacity` records, record after record, written as values. */
export function lightNamedStorage(nodeId: string, capacity: number): LightRecordStorage {
  return {
    resourceId: scratchResourceId(nodeId, LIGHT_NAMED_KEY),
    scratch: { kind: "buffer", key: LIGHT_NAMED_KEY, stride: 4, capacity: capacity * RECORD_WORDS },
  };
}
/** Words a record: what one row of the named Lights' `write` pass is. */
export const LIGHT_RECORD_WORDS = RECORD_WORDS;

export interface LightTableStorage {
  readonly resourceId: string;
  readonly scratch: BufferScratch;
  /** Rows the table has room for. */
  readonly slots: number;
  /** How many cells the grid has. */
  readonly cells: number;
  /** Words a cell: one bit a row. */
  readonly words: number;
  /** Where the cells start, as a word index: what the header says. */
  readonly cellsAt: number;
}

/** A Render's table: its header, room for `slots` records, then `grid` cells of one bit a row. */
export function lightTableStorage(nodeId: string, slots: number, grid: readonly [number, number, number]): LightTableStorage {
  const words = Math.ceil(slots / 32);
  const cells = grid[0] * grid[1] * grid[2];
  const cellsAt = lightTableCellsAt(slots);
  /* A whole number of four-word elements: the lit draw reads the table by them, and a last
     element cut short would be out of its reach. */
  const capacity = Math.ceil((cellsAt + cells * words) / 4) * 4;
  return {
    resourceId: scratchResourceId(nodeId, LIGHT_TABLE_KEY),
    scratch: { kind: "buffer", key: LIGHT_TABLE_KEY, stride: 4, capacity },
    slots,
    cells,
    words,
    cellsAt,
  };
}
