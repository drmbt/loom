/**
 * T1496b (§T1398b): preset banks — the data (`bank.ts`) and the Store / Recall commands.
 * T1497b: the morph record (`morph.ts`) and the per-revision index the resolver reads
 * (`morph-index.ts`).
 */
export {
  EMPTY_PRESET_BANK_JSON,
  MORPH_CURVES,
  PRESETS_NODE_TYPE,
  isPresetName,
  parsePresetBank,
  parsePresetTargets,
  serializePresetBank,
} from "./bank.ts";
export type { MorphCurve, MorphSpec, Preset, PresetBank, PresetBankParse, PresetTarget, PresetValues } from "./bank.ts";
export {
  EMPTY_MORPH_RECORDS_JSON,
  MAX_MORPH_RECORDS,
  easeMorph,
  morphProgress,
  morphRunning,
  nextMorphRecords,
  parseMorphRecords,
  sameStored,
  serializeMorphRecords,
} from "./morph.ts";
export type { MorphBookkeeping, MorphBookkeepingInput, MorphKeys, MorphRecord } from "./morph.ts";
export { NO_MORPHS, bankMorphRecords, buildMorphIndex, hasMorphRecords, morphableKey } from "./morph-index.ts";
export type { MorphIndexInput, PublishedOrigin, PublishedOrigins } from "./morph-index.ts";
export {
  PRESET_RECALL_COMMAND,
  PRESET_STORE_COMMAND,
  capturePresetValues,
  planPresetRecall,
  presetMorph,
  registerPresetCommands,
} from "./commands.ts";
export type {
  PresetCapture,
  PresetRecallInput,
  PresetRecallOutput,
  PresetRecallPlan,
  PresetRecallPlanOptions,
  PresetStoreInput,
  PresetStoreOutput,
} from "./commands.ts";
