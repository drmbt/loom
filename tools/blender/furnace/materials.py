"""Principled-BSDF-only material library.

Every material: base colour factor x vertex colour `grime` (COLOR_0), metallic,
roughness, optional emission colour + strength. Hot materials carry the custom
property `loom_heat` (0..1) which loom bakes into the heat mask.
Colours are linear.
"""
import bpy

# name: (base rgb, metallic, roughness, emission rgb or None, emission strength, loom_heat or None)
LIB = {
    # structure / paint
    "steel_painted_yellow": ((0.56, 0.36, 0.035), 0.15, 0.55, None, 0, None),
    "steel_painted_grey":   ((0.16, 0.17, 0.17), 0.30, 0.62, None, 0, None),
    "steel_primer_red":     ((0.24, 0.055, 0.03), 0.15, 0.68, None, 0, None),
    "steel_painted_blue":   ((0.035, 0.08, 0.17), 0.25, 0.55, None, 0, None),
    "paint_black":          ((0.018, 0.018, 0.018), 0.10, 0.50, None, 0, None),
    "steel_dark":           ((0.07, 0.07, 0.072), 0.85, 0.52, None, 0, None),
    "steel_worn":           ((0.42, 0.40, 0.38), 0.95, 0.32, None, 0, None),
    "steel_galvanized":     ((0.38, 0.39, 0.39), 0.85, 0.42, None, 0, None),
    "grating":              ((0.20, 0.20, 0.19), 0.80, 0.58, None, 0, None),
    "rust":                 ((0.20, 0.075, 0.03), 0.35, 0.85, None, 0, None),
    "roof_sheet":           ((0.22, 0.23, 0.24), 0.65, 0.50, None, 0, None),
    "concrete":             ((0.30, 0.285, 0.27), 0.00, 0.90, None, 0, None),
    # furnace
    "steel_heat":           ((0.10, 0.085, 0.08), 0.80, 0.48, None, 0, None),
    "panel_cooled":         ((0.14, 0.15, 0.135), 0.60, 0.62, None, 0, None),
    "refractory":           ((0.50, 0.44, 0.37), 0.00, 0.88, None, 0, None),
    "refractory_hot":       ((0.45, 0.22, 0.10), 0.00, 0.80, (1.0, 0.32, 0.07), 3.0, 0.55),
    "graphite":             ((0.05, 0.05, 0.055), 0.35, 0.45, None, 0, None),
    "graphite_hot":         ((0.20, 0.07, 0.03), 0.20, 0.45, (1.0, 0.42, 0.12), 25.0, 0.85),
    "graphite_warm":        ((0.09, 0.06, 0.05), 0.30, 0.45, (1.0, 0.30, 0.08), 2.5, 0.35),
    "copper_busbar":        ((0.72, 0.38, 0.22), 1.00, 0.33, None, 0, None),
    "cable_rubber":         ((0.025, 0.025, 0.025), 0.00, 0.62, None, 0, None),
    "hose_red":             ((0.28, 0.035, 0.025), 0.00, 0.55, None, 0, None),
    "pipe_green":           ((0.06, 0.17, 0.08), 0.25, 0.55, None, 0, None),
    # hot process
    "molten_steel":         ((1.00, 0.55, 0.20), 0.00, 0.28, (1.0, 0.55, 0.18), 60.0, 1.0),
    "slag_hot":             ((0.28, 0.09, 0.03), 0.00, 0.70, (1.0, 0.28, 0.05), 14.0, 0.7),
    "slag_cold":            ((0.055, 0.05, 0.045), 0.10, 0.95, None, 0, None),
    "strand_hot":           ((0.35, 0.10, 0.03), 0.30, 0.55, (1.0, 0.33, 0.07), 10.0, 0.6),
    "scrap_mix":            ((0.11, 0.08, 0.06), 0.60, 0.78, None, 0, None),
    # misc
    "rubber_belt":          ((0.028, 0.028, 0.028), 0.00, 0.80, None, 0, None),
    "glass_pulpit":         ((0.015, 0.02, 0.025), 0.00, 0.06, None, 0, None),
    "lamp":                 ((1.0, 1.0, 1.0), 0.00, 0.30, (1.0, 0.86, 0.66), 40.0, None),
    "screen_glow":          ((0.05, 0.08, 0.1), 0.00, 0.20, (0.35, 0.65, 1.0), 4.0, None),
    "sky_opening":          ((0.6, 0.7, 0.8), 0.00, 0.50, (0.62, 0.72, 0.88), 3.0, None),
}


def build():
    mats = {}
    for name, (base, met, rough, ecol, estr, heat) in LIB.items():
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "grime"
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs[0].default_value = 1.0
        mix.inputs[6].default_value = (*base, 1.0)
        nt.links.new(attr.outputs[0], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        bsdf.inputs["Metallic"].default_value = met
        bsdf.inputs["Roughness"].default_value = rough
        if ecol is not None and estr > 0:
            bsdf.inputs["Emission Color"].default_value = (*ecol, 1.0)
            bsdf.inputs["Emission Strength"].default_value = estr
        if heat is not None:
            m["loom_heat"] = float(heat)
        m.diffuse_color = (*base, 1.0)
        mats[name] = m
    return mats
