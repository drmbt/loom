"""The third-party car models the On Nothing scene uses (T1407b) and how each maps onto our
materials. Files live in the gitignored renders/on-nothing/assets/cars/ (see CREDITS.txt there:
all CC-BY-4.0, attribution lines verbatim). A material not named here falls back to the regex
classes in car_import.py, then to the car's paint.

`front`: which way the file's car faces; `length`: real length in metres (the import scales to
it); `decimate`: keep this share of the triangles (1 = all).
"""
import os

ASSETS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "renders", "on-nothing", "assets", "cars"))

MODELS = {
    "gls600": dict(
        path="maybach_gls600/Mersedes-Benz GLS.fbx", length=5.205, decimate=1.0,
        materials={
            "gls_paint": "PAINT", "gls_paint_two": "PAINT", "vehicle_paint1": "PAINT", "gls_kaki": "PAINT",
            "gls_black_chrome": "headlight_body", "black_chrome": "headlight_body", "amdb11_misc_chrome": "chrome",
            "gls_ras": "chrome", "gls_palitra": "chrome", "mirror": "chrome", "gls_rear": "chrome", "lsiggls": "chrome",
            "wheel_42a": "chrome", "wheel_42b": "chrome",
            "etk800": "tyre", "amdb11_caliper": "headlight_body", "amdb11_brake": "headlight_body",
            "gls_glass_1": "glass_car", "vehicle_vehglass": "glass_car",
            "gls_fara": "headlight", "gls_svet": "headlight", "gls_sigl": "drl", "gls_sigr": "drl",
            "lsiggls": "drl",  # the LED signature strips
            "gls_run": "taillight", "gls_stop": "taillight", "etk800_glass": "taillight",
            "Scene_-_Root": "plastic_black", "gls_grille": "plastic_black", "gls_din": "plastic_black",
            "gls_carbonn": "plastic_black", "gls_ras_on": "plastic_black",
        },
        # its projector modules are black chrome inside the lamp units: light them by position
        lamp_pods=dict(**{"from": ["headlight_body"]}, depth=0.45, z=(0.72, 1.0), x_min=0.55),
        drop=["gls_interior", "gls_interior1", "gls_torpedka1", "gls_leather", "gls_wood", "gls_seatbelt",
              "gls_dvd", "gls_gauges_screen", "gls_gps_screen", "gavril_v8", "gls_rgblentaa", "etk800_interior",
              "gls_amg_steer", "Interior", "etk800_lettering"],
    ),
    "maybach_s": dict(
        path="maybach_2022/scene.gltf", length=5.47, decimate=0.3, no_flip=True,
        materials={
            "Car_Paint_With_Flakes": "PAINT", "Car_Paint": "PAINT", "Car_paint": "PAINT",
            "Car_plastic_dark": "plastic_black", "Car_chrome": "chrome", "Glass": "glass_car",
            # "Material" is the red emissive: the TAIL lights. This file faces the right way as imported.
            "Material": "taillight", "Red_car_lights_glass": "taillight",
            "Material_2125663081": "headlight", "Material_2125663076": "headlight",  # the LED modules
            "Material_2125663085": "chrome", "Material_2125663092": "headlight_body", "Material_2125663093": "chrome",
        },
        drop_objects=["Object_6", "Object_7"],
        # its lamp internals are plain chrome / white metal: light them by where they are
        lamp_pods=dict(**{"from": ["chrome", "headlight_body"]}, depth=0.45, z=(0.55, 0.86), x_min=0.42),
    ),
    "escalade": dict(
        path="cadillac_escalade_2021.glb", length=5.38, decimate=0.6,
        materials={
            "Radiant_Silver_Metallic": "PAINT", "paint_Black": "plastic_black", "Paint_Black_Gloss": "paint_black",
            "Paint_Black_Gloss_003": "paint_black", "Chrome_Bright": "chrome", "Chrome_Bright_004": "chrome",
            "galvano_chrome": "chrome", "Paint_Galvano_Silver": "chrome", "Chrome_Dark": "headlight_body",
            "Tires": "tyre", "Rubber_Black": "tyre", "WHL_Dark_Android1_001": "headlight_body",
            "Windows_Glass_1": "glass_car", "Headlight_Glass": "glass_car", "Plastic_Black_Smooth": "plastic_black",
            "Misc_Blackout": "plastic_black", "Plastic_Smoked": "plastic_black", "lights": "headlight",
            "LED_Light_Pipe": "drl", "front_lamps_etched": "headlight_body", "headlight_metal": "headlight_body",
            "Tailights_Long": "taillight", "Brakelight_Glass": "taillight", "Glass_Amber": "drl", "mirrors": "chrome",
        },
        drop=["Misc_Interior", "wood", "FRONT_OLED_SCREEN", "BACK_SCREEN_MAIN_MENU", "Graphics_Blue", "Graphics_Grey",
              "Graphics_Yellow", "Fabric_Black_Speaker_Mesh"],
    ),
    "phantom": dict(
        path="_alternates/rolls_royce_phantom.glb", length=5.76, decimate=0.8,
        materials={
            "car_body_in": "PAINT", "car_glass": "glass_car", "front_lite_bulb": "headlight", "light": "headlight",
            "front_head_light_inc": "headlight", "frond_light_back": "headlight_body", "front_light_stand": "headlight_body",
            "tire": "tyre", "grill_and_beak": "chrome", "rr_front_logo": "chrome", "logo": "chrome",
            "front_glass_rim": "chrome", "back_glass_rim": "chrome", "mettal_in_w": "chrome", "mettal_in": "chrome",
            "front_and_back_rr_screw": "chrome", "car_bottom": "plastic_black", "brake_3": "headlight_body",
        },
        drop=["seat_white", "interior", "inside_button", "car_stering", "car_stearning", "back_speaker", "car_button_inside",
              "steering_box", "inside_board_white"],
    ),
    # T1441b: a LOW black sports SUV for the sneaker-on-bonnet shot (the Escalade's bonnet sits at
    # 1.4 m; this one's top runs 1.01 m at the nose to 1.13 m at the scuttle, 1.59 m roof, measured
    # through car_import with paint_black, 146k tris after the decimate). The SDC "Carbone" body is the paint; its orange accents go to black trim, so with
    # paint_black it reads all black. The file's "Material.00n" slots (tyres, discs, hubs) all fold
    # to one base name here, so they share the tyre's rubber.
    "urus": dict(
        path="lamborghini_urus_sdc.glb", length=5.112, decimate=0.4,
        materials={
            "Carbone": "PAINT", "Black_metal": "plastic_black", "Fond": "plastic_black", "BlackPaint": "plastic_black",
            "material_16": "plastic_black", "noir": "plastic_black", "Orange": "plastic_black", "GreyElements": "headlight_body",
            "Vitres": "glass_car", "Mirror": "chrome", "Chrome": "chrome", "visse": "chrome", "jente": "headlight_body",
            "aille": "headlight_body", "Material": "tyre", "Light": "headlight", "Default_Material": "headlight", "material": "drl",
            "BreakDiscs": "headlight_body", "BreakDiscs_1": "headlight_body", "Light_RED": "taillight", "LightsGlassBack": "taillight",
            "BreaksRedPaint": "taillight",
        },
    ),
    "rangerover": dict(
        path="_alternates/range_rover_sport_2018.glb", length=4.88, decimate=0.7,
        materials={
            "Car_Paint": "PAINT", "Plastic": "plastic_black", "Tyre": "tyre", "Black_Metal": "headlight_body",
            "Carbon": "plastic_black", "Metalic": "chrome", "Glass": "glass_car", "Trasnsparent_Glass": "glass_car",
            "Tail_Light": "taillight", "Reflectors": "headlight_body", "Head_Light": "headlight", "Mirror": "chrome",
            "Yellow_Glass": "drl", "Red_Metal": "taillight",
        },
    ),
}
