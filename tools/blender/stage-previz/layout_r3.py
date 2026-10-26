"""Layout REVISION 3 (2026-10-13, VN131): revision 2's stage with every fixture in the show at
its PATCHED position, read from the MA3 show's fixture export
(`projects/stage-previz/ma3/fixtures-r3.csv`).

Everything revision 2 sets (`layout.py`) is kept and re-exported from here; this module adds
the fixtures and the house trusses the hanging ones are on. Same frame: metres, Blender Z up,
+X stage left, audience at -Y, X = 0 the stage centre, Z = 0 the house floor.

The CSV gives each fixture's position and its local basis u, v, w (MVR convention). A fixture's
beam leaves along -w (GDTF: the beam is local -Z, identity = hanging, pointing down).
"""
import csv
import os

from layout import *  # noqa: F401,F403  (revision 2: every dimension not restated here)
from layout import DECK_H, DS_STRIP, GRATE_TOP, GRID_Y, PIXEL_BAR_SECTION, PIXEL_RACK_Y, PIXEL_RACK_Z, PIXEL_ROW_W, \
    PIXEL_TRUSS, PIXEL_TRUSS_Z, RISER_TOP, RISER_X, RISER_Y, STAGE_W, TRUSS_W

REVISION = 3
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES_CSV = os.path.normpath(os.path.join(HERE, "..", "..", "..", "projects", "stage-previz", "ma3", "fixtures-r3.csv"))

# ---- fixture bodies (estimates from the spec sheets, metres) -------------------------------
PIXEL_BAR_BODY = (1.0, 0.09, 0.09)        # Acme Pixel Line IP 1000 mm: along u, v, w
BURST_BODY = (0.42, 0.17, 0.15)           # GLP JDC Burst 1: along u, v, w (w = its height, beam up)
COLOR_STROBE_BODY = (0.6, 0.2, 0.15)      # Robe ColorStrobe: along u, v, w (w = its depth, toward the beam)
MOVER_HEAD = 0.35                         # a moving head's head, diameter and length
MOVER_YOKE = 0.42                         # across the yoke, outside the arms
GRATE_T = 0.03                            # the grated tops' thickness (build.py's grated_top)

# ---- the house trusses -------------------------------------------------------------------
HOUSE_TRUSS_W = TRUSS_W                   # 12" box, like the frame
HOUSE_TRUSS_OVERHANG = 0.6                # past the outermost fixture each end
HOUSE_TRUSS_ABOVE = 0.3                   # centre line above the hanging fixtures' z
HOUSE_TRUSS_MIN_HALF = 1.0                # a truss for one fixture is still 2 m
HOUSE_TRUSS_CLUSTER = 0.6                 # fixtures whose y differ by less hang from one truss


def _vec(text):
    return tuple(float(c) for c in text.split())


def fixtures():
    """[dict] one per CSV row: fid, layer, kind, type, p (x, y, z), u, v, w, note."""
    out = []
    with open(FIXTURES_CSV, newline="") as fh:
        for r in csv.DictReader(fh):
            out.append({
                "fid": r["fid"], "layer": r["layer"], "kind": r["kind"], "type": r["type"],
                "p": (float(r["x_m"]), float(r["y_m"]), float(r["z_m"])),
                "u": _vec(r["u"]), "v": _vec(r["v"]), "w": _vec(r["w"]), "note": r["note"],
            })
    return out


def of_kind(kind):
    return [f for f in fixtures() if f["kind"] == kind]


def grate_over(x, y, z):
    """The grated top (its top z) a floor fixture at (x, y, z) sits under, or None."""
    if abs(x) <= STAGE_W / 2 and DS_STRIP[0] <= y <= DS_STRIP[1] and z < GRATE_TOP - GRATE_T:
        return GRATE_TOP
    if abs(x) <= RISER_X and RISER_Y[0] <= y <= RISER_Y[1] and z < RISER_TOP - GRATE_T:
        return RISER_TOP
    return None


def house_trusses():
    """[(name, x0, x1, y, z, fids)]: one 12" box truss per row of hanging fixtures (movers and
    ColorStrobes), clustered by y. It spans the row's x range plus HOUSE_TRUSS_OVERHANG each end
    (at least 2 m), centred in y between the row's outermost hang points (the spot and wash
    rows hang off either bottom chord), its centre line HOUSE_TRUSS_ABOVE over the movers' z."""
    hung = sorted((f for f in fixtures() if f["kind"] in ("mover", "strobe")), key=lambda f: f["p"][1])
    rows, row = [], []
    for f in hung:
        if row and f["p"][1] - row[-1]["p"][1] > HOUSE_TRUSS_CLUSTER:
            rows.append(row)
            row = []
        row.append(f)
    if row:
        rows.append(row)
    out = []
    for row in rows:
        movers = [f for f in row if f["kind"] == "mover"] or row
        xs = [f["p"][0] for f in row]
        ys = [f["p"][1] for f in movers]
        zs = sorted(f["p"][2] for f in movers)
        y = 0.5 * (min(ys) + max(ys))
        z = zs[len(zs) // 2] + HOUSE_TRUSS_ABOVE
        cx = 0.5 * (min(xs) + max(xs))
        half = max(0.5 * (max(xs) - min(xs)) + HOUSE_TRUSS_OVERHANG, HOUSE_TRUSS_MIN_HALF)
        name = "foh" if y < DS_STRIP[0] - 4.0 else f"y{y:+.2f}"
        out.append((name, cx - half, cx + half, y, z, [f["fid"] for f in row]))
    return out


def pixel_lines_r2():
    """The revision 2 bar lines the CSV's bars should sit on: [(label, y, z)] (bar centre line)."""
    lines = [(f"truss {z / FT:.2f}'", GRID_Y - PIXEL_TRUSS / 2 - PIXEL_BAR_SECTION[0] / 2, DECK_H + z) for z in PIXEL_TRUSS_Z]  # noqa: F405
    lines += [(f"rack {z / FT:.2f}'", PIXEL_RACK_Y, DECK_H + z) for z in PIXEL_RACK_Z]  # noqa: F405
    return lines


def pixel_bar_misfits(limit=0.15):
    """[(fid, p, nearest line, distance)] for bars further than `limit` from every r2 bar line
    (in y, z) or outside its row's x span."""
    out = []
    for f in of_kind("pixelbar"):
        x, y, z = f["p"]
        best = min(((lab, ((y - ly) ** 2 + (z - lz) ** 2) ** 0.5) for lab, ly, lz in pixel_lines_r2()), key=lambda t: t[1])
        if best[1] > limit or abs(x) > PIXEL_ROW_W / 2 + 0.2:
            out.append((f["fid"], f["p"], best[0], best[1]))
    return out
