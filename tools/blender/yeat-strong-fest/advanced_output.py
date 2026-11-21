"""YEAT STRONG FEST: the Resolume Arena Advanced Output preset that matches the pixel map.

    python3 tools/blender/yeat-strong-fest/advanced_output.py \
        --template "$HOME/Documents/Resolume Arena/Presets/Advanced Output/yeat-full-stage-central park.xml" \
        --out "$HOME/Documents/Resolume Arena/Presets/Advanced Output/yeat-strong-fest.xml"

One screen, `YEAT PIXEL MAP`, 3840 x 2160, published over Syphon. Arena names a Syphon server
after its SCREEN (it rewrote the device to the screen's name on load), so the screen carries the
name the Loom previz's Syphon In listens for. Give the screen a display output at the venue.

The composition IS the pixel map (3840 x 2160), and every slice is pixel-true: its input rect
equals its output rect, so content authored to the map (or the map's own test image played as a
clip) lands on each screen 1:1. Both read the composition (Input Source 0:1):

- `MAIN WALL`: 0,0 2520 x 1512.
- `IMAG`: 2524,0 672 x 1008. ONE region feeds both IMAG screens. Point its Input Source at the
  camera layer if IMAG is live (and move its input rect onto that layer's picture).

The DJ booth strips at y 1512 are left out on purpose.

The screen and slice XML is the template's first screen and slice, deep-copied, so every
parameter block Arena expects is there. Arena's `idHash` is the deviceId's bytes as a base-101
polynomial mod 2^64 (checked against every Display, Syphon and Virtual device in the presets
folder); uniqueIds are 13-digit millisecond stamps, as Arena mints them.
"""
import argparse
import copy
import os
import time
import xml.etree.ElementTree as ET

CANVAS = (3840, 2160)
SCREEN_NAME = "YEAT PIXEL MAP"
# name, rect (x, y, w, h) in the pixel map: the input rect and the output rect alike
SLICES = [
    ("MAIN WALL", (0, 0, 2520, 1512)),
    ("IMAG", (2524, 0, 672, 1008)),
]


def id_hash(device_id):
    h = 0
    for c in device_id.encode():
        h = (h * 101 + c) % 2**64
    return str(h)


def set_quad(el, x, y, w, h):
    for v in list(el):
        el.remove(v)
    for vx, vy in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)):
        ET.SubElement(el, "v", x=str(vx), y=str(vy))


def set_param(params, name, value):
    for p in params:
        if p.get("name") == name:
            p.set("value", value)
            return
    raise KeyError(name)


def build_slice(template, uid, name, rect):
    s = copy.deepcopy(template)
    s.set("uniqueId", str(uid))
    set_param(s.find("Params[@name='Common']"), "Name", name)
    set_param(s.find("Params[@name='Common']"), "Enabled", "1")
    s.find(".//ParamChoice[@name='Input Source']").set("value", "0:1")
    set_quad(s.find("InputRect"), *rect)
    set_quad(s.find("OutputRect"), *rect)
    warper = s.find("Warper")
    bez = warper.find("BezierWarper")
    cw, ch = int(bez.get("controlWidth")), int(bez.get("controlHeight"))
    verts = bez.find("vertices")
    for v in list(verts):
        verts.remove(v)
    x, y, w, h = rect
    for j in range(ch):
        for i in range(cw):
            ET.SubElement(verts, "v", x=f"{x + w * i / (cw - 1):g}", y=f"{y + h * j / (ch - 1):g}")
    set_quad(warper.find("Homography/src"), *rect)
    set_quad(warper.find("Homography/dst"), *rect)
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tree = ET.parse(args.template)
    root = tree.getroot()
    root.set("name", os.path.splitext(os.path.basename(args.out))[0])  # Arena keeps it equal to the file stem
    setup = root.find("ScreenSetup")
    setup.find("CurrentCompositionTextureSize").attrib.update(width=str(CANVAS[0]), height=str(CANVAS[1]))
    screens = setup.find("screens")
    screen = copy.deepcopy(screens.find("Screen"))
    for s in list(screens):
        screens.remove(s)

    uid = int(time.time() * 1000)
    screen.set("name", SCREEN_NAME)
    screen.set("uniqueId", str(uid))
    params = screen.find("Params[@name='Params']")
    set_param(params, "Name", SCREEN_NAME)
    set_param(params, "Enabled", "1")
    set_param(params, "Hidden", "0")
    for p in screen.find("Params[@name='Output']"):
        p.set("value", p.get("default"))

    layers = screen.find("layers")
    slice_template = layers.find("Slice")
    for s in list(layers):
        layers.remove(s)
    for k, (name, rect) in enumerate(SLICES):
        layers.append(build_slice(slice_template, uid + 1 + k, name, rect))

    device = screen.find("OutputDevice")
    for d in list(device):
        device.remove(d)
    device_id = "Syphon" + SCREEN_NAME
    syphon = ET.SubElement(device, "OutputDeviceSyphon", name=SCREEN_NAME, deviceId=device_id,
                           idHash=id_hash(device_id), width=str(CANVAS[0]), height=str(CANVAS[1]))
    syphon_params = ET.SubElement(syphon, "Params", name="Params")
    for axis, value in (("Width", CANVAS[0]), ("Height", CANVAS[1])):
        r = ET.SubElement(syphon_params, "ParamRange", name=axis, T="DOUBLE", default=str(value), value=str(value))
        ET.SubElement(r, "PhaseSourceStatic", name="PhaseSourceStatic")
        ET.SubElement(r, "BehaviourDouble", name="BehaviourDouble")
        for rn in ("defaultRange", "minMax", "startStop"):
            ET.SubElement(r, "ValueRange", name=rn, min="1", max="16384")
    screens.append(screen)

    ET.indent(tree, space="\t")
    tree.write(args.out, encoding="utf-8", xml_declaration=True)
    print(f"wrote {args.out}")


main()
