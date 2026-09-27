"""Material library for the On Nothing scene (T1400b). Principled-BSDF factors only, as the furnace.

The GLB carries no textures and no material id per vertex, so each material's `loom_heat` extra
carries its CLASS CODE instead (class / 64): loom's surface shader reads it back from
`surface.z` and draws the class (clear-coat paint, chrome, damp concrete, skin, cloth). Nothing
here is hot; the name `loom_heat` is only the decoder's channel.

Colours are linear.
"""
import bpy

# name: (base rgb, metallic, roughness, emission rgb or None, emission strength, class code)
LIB = {
    # warehouse
    "concrete":       ((0.11, 0.108, 0.104), 0.0, 0.45, None, 0, 1),
    "brick_dark":     ((0.05, 0.035, 0.028), 0.0, 0.9, None, 0, 2),
    "steel_truss":    ((0.06, 0.06, 0.062), 0.7, 0.55, None, 0, 3),
    "roof_sheet":     ((0.04, 0.04, 0.042), 0.5, 0.6, None, 0, 3),
    "tube_led":       ((1.0, 1.0, 1.0), 0.0, 0.3, (0.92, 0.96, 1.0), 60.0, 4),
    "tube_cap":       ((0.02, 0.02, 0.02), 0.2, 0.5, None, 0, 5),
    # cars
    "paint_white":    ((0.72, 0.72, 0.71), 0.0, 0.18, None, 0, 10),
    "paint_silver":   ((0.55, 0.56, 0.57), 0.85, 0.28, None, 0, 11),
    "paint_matte":    ((0.12, 0.122, 0.126), 0.35, 0.5, None, 0, 12),
    "paint_black":    ((0.012, 0.012, 0.013), 0.0, 0.14, None, 0, 13),
    "chrome":         ((0.95, 0.95, 0.95), 1.0, 0.06, None, 0, 14),
    "glass_car":      ((0.008, 0.009, 0.01), 0.0, 0.03, None, 0, 15),
    "lamp_glass":     ((1.0, 1.0, 1.0), 0.0, 0.02, None, 0, 21),
    "plastic_black":  ((0.02, 0.02, 0.021), 0.0, 0.55, None, 0, 16),
    "tyre":           ((0.018, 0.018, 0.018), 0.0, 0.75, None, 0, 17),
    "headlight":      ((1.0, 1.0, 1.0), 0.0, 0.1, (0.95, 0.97, 1.0), 400.0, 18),
    "drl":            ((1.0, 1.0, 1.0), 0.0, 0.1, (0.9, 0.95, 1.0), 120.0, 18),
    "headlight_body": ((0.3, 0.31, 0.32), 1.0, 0.12, None, 0, 19),
    "taillight":      ((0.2, 0.01, 0.01), 0.0, 0.1, (1.0, 0.02, 0.01), 8.0, 20),
    # figure
    "skin":           ((0.32, 0.22, 0.17), 0.0, 0.48, None, 0, 30),
    "cloth_black":    ((0.018, 0.018, 0.019), 0.0, 0.85, None, 0, 31),
    "denim_black":    ((0.022, 0.022, 0.024), 0.0, 0.8, None, 0, 32),
    "shoe_black":     ((0.015, 0.015, 0.016), 0.0, 0.4, None, 0, 33),
    "lens_black":     ((0.004, 0.004, 0.005), 0.0, 0.04, None, 0, 34),
    "jewel":          ((0.97, 0.97, 0.98), 1.0, 0.03, None, 0, 35),
    # cyc
    "cyc_white":      ((0.82, 0.82, 0.82), 0.0, 0.92, None, 0, 40),
}


def build():
    mats = {}
    for name, (base, met, rough, ecol, estr, code) in LIB.items():
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*base, 1.0)
        bsdf.inputs["Metallic"].default_value = met
        bsdf.inputs["Roughness"].default_value = rough
        if ecol is not None and estr > 0:
            bsdf.inputs["Emission Color"].default_value = (*ecol, 1.0)
            bsdf.inputs["Emission Strength"].default_value = estr
        m["loom_heat"] = code / 64.0
        m.diffuse_color = (*base, 1.0)
        mats[name] = m
    return mats
