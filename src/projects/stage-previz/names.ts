import type { ProjectDocument } from "../../domain/types/graph.ts";
import { rewriteNodeNameReferences } from "../../domain/graph/names.ts";

/**
 * T1593b, for the stage previz: every node is named `kind_role` (`slider_dsThrow`,
 * `render_stage`, `projector_DS`).
 *
 * The session is built with short working names (`dsThrow`, `stage`, `projDS`), which is what
 * the builders and the rig's string templates spell. `conformNames` renames them at the end of
 * the build, through the product's own rename (`rewriteNodeNameReferences`, §V128), so every
 * stored reference (expressions, a Render's scenes and projectors, a geometry's material, the
 * preset targets, the board, the cue list) moves with its node. A name already conforming is
 * left alone, so running it over a session that was renamed before is a no-op.
 *
 * The table is the rename upstream's sweep tool decided for the shipped sessions
 * (`src/examples/rename/`): its rules, plus judgements for the thin stage positions (DS, SL,
 * SR, FX). A node added to the build without a line here keeps its working name, and the
 * node-names gate fails on it: that is the prompt to add the line.
 */
export const STAGE_NAMES: Readonly<Record<string, string>> = {
  "atmosphere": "wgsl_atmosphere",
  "beamDS": "wgsl_beamDS",
  "beamSL": "wgsl_beamSL",
  "beamSR": "wgsl_beamSR",
  "beams": "slider_beams",
  "blank": "solid_blank",
  "deckTone": "slider_deckTone",
  "desk": "panel_desk",
  "drapeDepth": "render_drapeDepth",
  "dsKeyH": "slider_dsKeyH",
  "dsKeyV": "slider_dsKeyV",
  "dsOffset": "slider_dsOffset",
  "dsThrow": "slider_dsThrow",
  "dsTilt": "slider_dsTilt",
  "feedDS": "switch_feedDS",
  "feedFX": "switch_feedFX",
  "feedSL": "switch_feedSL",
  "feedSR": "switch_feedSR",
  "flipSL": "flip_SL",
  "fog": "slider_fog",
  "fxMap": "movie_fxMap",
  "geoCurtain": "geometry_curtain",
  "geoCurtainDepth": "geometry_curtainDepth",
  "geoDeck": "geometry_deck",
  "geoGrid": "geometry_grid",
  "geoKabuki": "geometry_kabuki",
  "geoKabukiDepth": "geometry_kabukiDepth",
  "geoLed": "geometry_led",
  "geoRig": "geometry_rig",
  "geoStage": "geometry_stage",
  "geoStrobe": "geometry_strobe",
  "geoTalent": "geometry_talent",
  "haze": "slider_haze",
  "hazeRender": "hazerender1",
  "index": "slider_index",
  "kabuki": "slider_kabuki",
  "kabukiFly": "kernel_kabukiFly",
  "leds": "slider_leds",
  "matDeck": "material_deck",
  "matDepth": "material_depth",
  "matDrape": "material_drape",
  "matLed": "material_led",
  "matStrobe": "material_strobe",
  "matSurface": "material_surface",
  "meshCurtain": "mesh_curtain",
  "meshDeck": "mesh_deck",
  "meshGrid": "mesh_grid",
  "meshKabuki": "mesh_kabuki",
  "meshLed": "mesh_led",
  "meshRig": "mesh_rig",
  "meshStage": "mesh_stage",
  "meshStrobe": "mesh_strobe",
  "meshTalent": "mesh_talent",
  "noteFX": "note_FX",
  "noteFeeds": "note_feeds",
  "orbit": "slider_orbit",
  "out": "output1",
  "projDS": "projector_DS",
  "projSL": "projector_SL",
  "projSR": "projector_SR",
  "projectorRig": "projectorrig1",
  "rigMotion": "kernel_rigMotion",
  "scrim": "slider_scrim",
  "shadowCamDS": "camera_shadowCamDS",
  "shadowCamSL": "camera_shadowCamSL",
  "shadowCamSR": "camera_shadowCamSR",
  "shadowDS": "render_shadowDS",
  "shadowSL": "render_shadowSL",
  "shadowSR": "render_shadowSR",
  "shot": "slider_shot",
  "sideKeyH": "slider_sideKeyH",
  "sideKeyV": "slider_sideKeyV",
  "sideRoll": "slider_sideRoll",
  "sideThrow": "slider_sideThrow",
  "sideTilt": "slider_sideTilt",
  "source": "slider_source",
  "stage": "render_stage",
  "stageCamera": "stagecamera1",
  "stageFeeds": "stagefeeds1",
  "stageSet": "stageset1",
  "strobes": "slider_strobes",
  "syphonDS": "syphonin_DS",
  "syphonDS1": "syphonin_FX",
  "syphonFX": "syphonin_FX",
  "syphonSL": "syphonin_SL",
  "syphonSR": "syphonin_SR",
  "talent": "toggle_talent",
  "talentShow": "kernel_talentShow",
  "testBeams": "wgsl_testBeams",
  "testFX": "wgsl_testFX",
  "testGrid": "wgsl_testGrid",
  "testVideo": "movie_testVideo",
  "view": "camera_view",
  "work": "slider_work",
  "workKey": "light_workKey",
  "workLights": "worklights1",
  "workRim": "light_workRim",
  "zoom": "slider_zoom",
};

const WORKING_NAMES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(STAGE_NAMES).map(([working, conformed]) => [conformed, working]));

/** The session with its conformed names. */
export function conformNames(document: ProjectDocument): ProjectDocument {
  return renamed(document, STAGE_NAMES);
}

/**
 * The session with its working names: what the rig's builders and lookups spell. `applyRig`
 * works in these and conforms at the end, so a session saved after the rename upgrades like
 * one saved before it.
 */
export function workingNames(document: ProjectDocument): ProjectDocument {
  return renamed(document, WORKING_NAMES);
}

function renamed(document: ProjectDocument, table: Readonly<Record<string, string>>): ProjectDocument {
  const graph = structuredClone(document.graph);
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const next = node.label === undefined ? undefined : table[node.label];
    if (next === undefined || node.label === undefined) continue;
    rewriteNodeNameReferences(graph, node.label, next);
    graph.nodes[nodeId] = { ...graph.nodes[nodeId]!, label: next };
  }
  return { ...document, graph };
}
