import { scratchResourceId } from "../../compiler/resources.ts";
import { LIGHT_RECORD_BYTES, lightTableCellsAt } from "../shaders/scene-lights.wgsl.ts";

/**
 * T1589b — LIGHTS FROM A POINTSET, at the node seam
 * (docs/lights-from-pointset-design-2026-10-06.md, sections 3.9 and 13).
 *
 * Two buffers, and who owns each:
 *
 *  - THE LIGHT'S RECORDS (`scratch:<light>:lightRecords`): one record a point, resolved once
 *    a frame by the Light itself, so two Renders that list one Light resolve it once.
 *  - THE RENDER'S TABLE (`scratch:<render>:lightTable`): a header, then the records of every
 *    pointset Light it lists, one after the other, and behind them the grid's cells. A lit
 *    draw binds this one buffer and nothing else of the lights, whatever they are.
 *
 * The layout is the shader half's (`scene-lights.wgsl.ts`): a record is 64 bytes, a Light's
 * buffer keeps record after record and a table keeps row after row, and a table's header
 * says how many rows it has, how many words a cell has and where the cells start. Nothing of
 * it is a number in a shader's text.
 *
 * ## The capacity is the contract
 *
 * A table has as many rows as its Lights' pointsets have CAPACITY, live or not, and a cell
 * has one bit a row. So the one limit of the path is a number known at compile, and going
 * past it is a refusal by name there (`MAX_LIGHT_SLOTS`), never a light dropped on the GPU
 * where nothing could say so. A table compacted to its live lights would move that limit to
 * run time; it is not compacted.
 */

/** The most rows one Render's table holds: 32 words a cell. Raising it wants a two-level mask (T1624b). */
export const MAX_LIGHT_SLOTS = 1024;
/**
 * The most pointset Lights one Render lists: the gather pass binds its table and one record
 * buffer a Light, and a stage is guaranteed eight storage buffers (§V588). More wants a
 * second gather (T1628b).
 */
export const MAX_POINT_LIGHTS = 7;

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

/** The scratch keys of the two buffers. */
export const LIGHT_RECORDS_KEY = "lightRecords";
export const LIGHT_TABLE_KEY = "lightTable";

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

export interface LightTableStorage {
  readonly resourceId: string;
  readonly scratch: BufferScratch;
  /** Rows of the table. */
  readonly slots: number;
  /** How many cells the grid has. */
  readonly cells: number;
  /** Words a cell: one bit a row. */
  readonly words: number;
  /** Where the cells start, as a word index: what the header says. */
  readonly cellsAt: number;
}

/** A Render's table: its header, `slots` records, then `grid` cells of one bit a row. */
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
