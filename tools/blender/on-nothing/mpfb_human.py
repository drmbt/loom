# Build a rigged, clothed MakeHuman (MPFB 2.0.17) adult male headless and save .blend + .glb.
# Run with BLENDER_USER_RESOURCES=renders/on-nothing/assets/blender-user (MPFB + CC0 system assets; see README.md).
# Usage: Blender --background --factory-startup --python tools/blender/on-nothing/mpfb_human.py -- <out_basename> <rig>
import sys, os, bpy, addon_utils

argv = sys.argv[sys.argv.index("--") + 1:]
out_base = argv[0]
rig = argv[1] if len(argv) > 1 else "game_engine"

import importlib
mod = None
for name in ("bl_ext.user_default.mpfb",):
    try:
        addon_utils.enable(name, default_set=True)
        mod = importlib.import_module(name)
    except Exception as e:
        print("enable failed", name, e)
HumanService = importlib.import_module("bl_ext.user_default.mpfb.services.humanservice").HumanService

# clear default scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

info = HumanService._create_default_human_info_dict()
info["name"] = "Human"
info["phenotype"].update({"gender": 1.0, "age": 0.5, "muscle": 0.55, "weight": 0.5,
                          "height": 0.55, "proportions": 0.5})
info["phenotype"]["race"] = {"asian": 0.2, "caucasian": 0.6, "african": 0.2}
info["rig"] = rig
info["eyes"] = "high-poly/high-poly.mhclo"
info["eyebrows"] = "eyebrow001/eyebrow001.mhclo"
info["eyelashes"] = "eyelashes01/eyelashes01.mhclo"
info["hair"] = "short02/short02.mhclo"
info["clothes"] = ["male_casualsuit06/male_casualsuit06.mhclo", "shoes02/shoes02.mhclo"]
info["skin_mhmat"] = "young_caucasian_male/young_caucasian_male.mhmat"
info["skin_material_type"] = "ENHANCED_SSS"
info["eyes_material_type"] = "MAKESKIN"
info["clothes_material_type"] = "MAKESKIN"

settings = HumanService.get_default_deserialization_settings()
settings["subdiv_levels"] = 0
basemesh = HumanService.deserialize_from_dict(info, settings)
print("BUILT", basemesh.name)

bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=out_base + ".blend", compress=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=out_base + ".glb", export_format="GLB", export_apply=True,
                          export_skins=True, export_animations=False, export_morph=False)
print("SAVED", out_base)
