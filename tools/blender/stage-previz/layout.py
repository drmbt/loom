"""Every coordinate of the stage, in one place (metres, Blender Z up, audience at -Y).

REVISION 2 (2026-10-08, VN79): the tour's dimensioned front elevation and top plan. Heights
are the elevation's dimensions above the HOUSE DECK (which is 5'0" here and "may be different
in each venue"); plan positions are the plan's dimensions from the stage's downstage edge.
What the drawings do not dimension is read off them at their scale and says so where it is
set. The first export (2026-10-06, `public/media/stage-previz/stage.glb`) came from the
estimates this revision replaces; this one ships as `stage-r2.glb`.

Axes: X = stage width (+X is STAGE LEFT, the audience's right), Y = depth (+Y upstage),
Z = up. glTF / Loom space is (x, z, -y): Loom +Z points at the audience.
"""
import math

FT = 0.3048              # metres per foot: the venue numbers arrive in feet
IN = FT / 12


def ft(feet, inches=0.0):
    """Feet and inches, as the Vectorworks sheets dimension them, in metres."""
    return feet * FT + inches * IN


# ---- the house deck: 4' x 8' decks, 4' across the stage ----------------------------------
# The plan: 15 decks across (60', "30'-0"" each side of centre) and 5 rows of 8' deep (40'),
# its downstage edge the stage's. The grated stage deck on it is 48' across (STAGE_W).
DECK_PANEL = (4 * FT, 8 * FT)
DECK_COLS, DECK_ROWS = 15, 5
DECK_W = DECK_COLS * DECK_PANEL[0]   # 60'
DECK_D = DECK_ROWS * DECK_PANEL[1]   # 40'
DECK_Y0 = 5.0 - 32 * FT  # downstage edge (where the first export had it, so the cameras still frame it)
DECK_Y1 = DECK_Y0 + DECK_D           # upstage edge
DECK_H = ft(5)           # house deck top above the house floor (elevation: 5'0", "may be different in each venue")
STAGE_W = 48 * FT        # the grated stage deck, the strobe grid and the side projectors' deck edges
DECK_TOP_T = 0.08        # black top sheet thickness

# ---- the blowthrough decks (Vectorworks: Top Plan - Strobes, Front Elevation) -------------
# Shallow GRATED decks 1'6" over the house deck, strobes underneath: the stage's downstage
# 48' x 16' (its two downstage rows of decks) and the riser's top. Light blows up through them.
GRATE_H = ft(1, 6)
GRATE_TOP = DECK_H + GRATE_H         # the walking surface downstage, and where the side images land
DS_STRIP = (DECK_Y0, DECK_Y0 + 2 * DECK_PANEL[1])   # the grated stage deck: 16' deep, 48' wide (plan: 16'-0")

# ---- the upstage riser, with a stair at each end facing downstage ------------------------
# Eight decks across (32') and one deep (8'), directly upstage of the grated stage deck (the
# plan draws them abutting). Its top is a grated deck too, 7'7" over the house deck (front
# elevation), over a solid platform 1'6" below it where its strobes sit. Each stair is one deck
# wide, beside the riser's face, climbing UPSTAGE from the riser's front line, from the stage
# grate to the riser top.
RISER_X = 8 * DECK_PANEL[0] / 2      # half width of the face between the stairs (plan: 16'-0 1/8")
RISER_Y = (DS_STRIP[1], DS_STRIP[1] + DECK_PANEL[1])  # downstage face .. upstage face
RISER_TOP = DECK_H + ft(7, 7)        # its grated walking surface
RISER_DECK = RISER_TOP - GRATE_H     # the platform under the grate
RISER_H = RISER_TOP - DECK_H         # above the house deck
STAIR_W = DECK_PANEL[0]  # each stair, beside the riser
STAIR_STEPS = 8          # risers per stair, stage grate to riser top; the 8th is the landing
STAIR_GOING = 0.28

# ---- upstage wall: the scrim, flush against the riser's upstage face ----------------------
CURTAIN_Y = RISER_Y[1] + 0.12   # the pipe line: the riser's upstage face (plan: 24'-0"), the pleats clear of it
CURTAIN_TOP = DECK_H + ft(23, 1)  # the drape's top (elevation: 23'-1")
CURTAIN_X = 18 * FT      # half width along the pipe (elevation, at its scale: 36')
CURTAIN_FLAT_X = 15 * FT # the straight fall, the width of the pixel trusses behind it; beyond it each
                         # side is gathered out and down, round the stair, to pool in front of it
# Each side's swag, from the elevation and the plan at their scale: (|x|, feet from the stage's
# downstage edge, feet above the house deck). Out along the scrim's line past the stair's
# upstage end, down the stair's offstage side, gathered there (the elevation's gather, 20'-21'
# off centre, 11' up), and pooled round the stair's foot; a column's pool runs from POOL_NEAR
# (the swag's inner edge: in front of the stair) to POOL_FAR (the pipe's end: beside it).
CURTAIN_SWAG_OUT = (ft(22, 6), ft(23), ft(17))
CURTAIN_GATHER = (ft(21, 6), ft(18), ft(10))
CURTAIN_POOL_NEAR = (ft(19), ft(14))
CURTAIN_POOL_FAR = (ft(24, 6), ft(19))
CURTAIN_BUNCH = 0.32     # how far the gathered cloth heaps off its own line, metres
CURTAIN_PLEAT = (0.055, 0.42)     # amplitude, wavelength

GRID_Y = DECK_Y0 + ft(28, 1)    # the hung pixel-line trusses, 4' BEHIND the scrim (plan: 28'-1"), their bars
                         # toward the house: Loom draws the scrim additively, so their light shows through it

# ---- pixel lines: ACME Pixel Line IP x 63 (the fixture list), 7 rows of 9 one-metre bars ----
# Front elevation: three rows on a rack in front of the riser (Schedule 40 pipe on four 2' x 2'
# base plates, 2' between rows) and four on hung 12" box trusses (TC1212) behind the scrim. Row
# heights above the house deck, read off the elevation's dimensions (the truss rows' 3' pitch is
# an estimate below the dimensioned 17'11").
PIXEL_BAR_LEN = 1.0
PIXEL_BAR_SECTION = (0.08, 0.07)     # depth, height (estimate)
PIXELS_PER_BAR = 39      # ASSUMED from the 117-channel DMX footprint: 39 RGB pixels a bar
PIXEL_BARS_PER_ROW = 9
PIXEL_ROW_W = 30 * FT    # nine bars, end to end with a hair between them
PIXEL_RACK_Z = (ft(2, 11), ft(4, 11), ft(7, 0))
# The hung rows: the elevation dimensions one at 16'-11" and draws the four 3' apart, the top
# at 19'-11" (read at its scale; the extension line it hangs that dimension on is drawn off).
PIXEL_TRUSS_Z = (ft(10, 11), ft(13, 11), ft(16, 11), ft(19, 11))
PIXEL_RACK_Y = RISER_Y[0] - 0.18     # the rack's bar line, just in front of the riser face
PIXEL_RACK_POSTS = (-ft(13, 6), -ft(4), ft(4), ft(13, 6))
PIXEL_TRUSS = ft(1)      # TC1212 section

# ---- strobes: GLP JDC Burst 1 x 38, under the grated decks (Top Plan - Strobes) ------------
# Stage: six across from 2'0" in off stage right at 8'10", five deep from 2'10" in off the
# grate's upstage edge at 3'1" (the last 10" off its downstage edge). Riser: eight, 4' apart,
# centred, 4' in off its upstage edge. Each lies across the stage, face up.
STROBE_BODY = (0.52, 0.22, 0.14)     # estimate
STROBE_WINDOW = (0.46, 0.15)         # its light through the grating


def strobes():
    """[(id, (x, y), floor z, grate top z)] for all 38, stage first (downstage row first, SR to SL)."""
    out = []
    xs = [-STAGE_W / 2 + ft(2) + i * ft(8, 10) for i in range(6)]
    ys = [DS_STRIP[1] - (ft(2, 10) + j * ft(3, 1)) for j in range(5)]
    for j, y in enumerate(reversed(ys)):
        for i, x in enumerate(xs):
            out.append((f"S{len(out) + 1}", (x, y), DECK_H, GRATE_TOP))
    for i in range(8):
        out.append((f"R{i + 1}", (-ft(14) + i * ft(4), RISER_Y[1] - ft(4)), RISER_DECK, RISER_TOP))
    return out


def pixel_bars():
    """[(id, row, x0, x1, z, y)] for all 63 bars, top row first (truss rows, then the rack)."""
    out = []
    rows = [(z, GRID_Y - PIXEL_TRUSS / 2 - PIXEL_BAR_SECTION[0] / 2) for z in sorted(PIXEL_TRUSS_Z, reverse=True)]
    rows += [(z, PIXEL_RACK_Y) for z in sorted(PIXEL_RACK_Z, reverse=True)]
    pitch = PIXEL_ROW_W / PIXEL_BARS_PER_ROW
    for r, (z, y) in enumerate(rows):
        for b in range(PIXEL_BARS_PER_ROW):
            x0 = -PIXEL_ROW_W / 2 + b * pitch + (pitch - PIXEL_BAR_LEN) / 2
            out.append((f"P{r + 1}.{b + 1}", r, x0, x0 + PIXEL_BAR_LEN, DECK_H + z, y))
    return out


# ---- the FX feed: ONE 1920 x 1080 Syphon/Spout stream for all the pixel lines and strobes ---
# Top half: the pixel lines as seen from the house — across the stage 30' over 1920 px (64 px/ft),
# height mapped linearly with a foot of margin, so each row samples one texel row. Bottom half:
# the strobes in plan — across the stage 48' over 1920 px (40 px/ft), downstage edge at the
# bottom, the riser's back edge at the top (24' over 540 px). Every pixel and strobe reads ONE
# texel; `fx-pixel-map.*` beside the session lists them.
FX_SIZE = (1920, 1080)
# The template draws each zone a pixel bigger on every side than the texel it is sampled at
# (a bar row is three rows tall), so a feed that arrives a pixel off still lands.
FX_ZONE_PAD = 1
FX_TOP_Z = (min(PIXEL_RACK_Z) - FT, max(PIXEL_TRUSS_Z) + FT)   # the top half's height range, above the house deck


def fx_texel_bar(x, z):
    """The top-half texel (column, row) that the pixel at (x, z) shows."""
    w, h = FX_SIZE
    col = (x + PIXEL_ROW_W / 2) / PIXEL_ROW_W * w
    row = (FX_TOP_Z[1] - (z - DECK_H)) / (FX_TOP_Z[1] - FX_TOP_Z[0]) * (h / 2)
    return min(max(int(col), 0), w - 1), min(max(int(row), 0), h // 2 - 1)


def fx_texel_strobe(x, y):
    """The bottom-half texel (column, row) that the strobe at plan position (x, y) shows."""
    w, h = FX_SIZE
    col = (x + STAGE_W / 2) / STAGE_W * w
    depth = (y - DECK_Y0) / (RISER_Y[1] - DECK_Y0)
    row = h - depth * (h / 2)
    return min(max(int(col), 0), w - 1), min(max(int(row), h // 2), h - 1)

# ---- midstage kabuki (sheer), downstage of the riser and its pixel-line rack ---------------
# Not on the revision 2 plot; kept, on its own pipe, flown out in every preset.
KABUKI_Y = RISER_Y[0] - 0.55
KABUKI_TOP = CURTAIN_TOP
KABUKI_X = 7.0
KABUKI_FLAT_X = 5.5
KABUKI_TIE = (6.9, -0.9)
KABUKI_PLEAT = (0.045, 0.36)

# ---- the flown frame: two 50' trusses across the stage ------------------------------------
# The plan: the scrim's truss over the scrim, and a front truss 8' from the downstage edge that
# carries the side projectors. Both at the elevation's trim: 22'-7" to the bottom chord.
TRUSS_W = FT             # TC1212 12" box truss (the fixture list)
TRUSS_Z = DECK_H + ft(22, 7) + TRUSS_W / 2   # centre line
TRUSS_X = 25 * FT        # half length
TRUSS_US_Y = CURTAIN_Y + TRUSS_W / 2 + 0.03  # the scrim hangs off its downstage face
TRUSS_DS_Y = DECK_Y0 + ft(8)                 # the front truss

# ---- projectors (lens position, aim point) -----------------------------------------------
# Barco UDX-4K40: native 3840 x 2400, 16:10.
PROJ_ASPECT = 16.0 / 10.0
# Side projectors hang from the front truss toward its ends (plan: over the middle of the
# downstage strip, 19' off centre; elevation: lens 20'-5" above the house deck, at its scale),
# angled down and inward, used as light: a volumetric cone through the haze onto the downstage deck.
# They are rolled 90° (portrait; Loom's Side roll fader): rolled, an image's LONG side lies in
# the projector's tilt plane, so each pans straight across the stage. The beams CROSS: each
# image's far edge lands on the opposite deck edge, and its depth on the deck is the downstage
# strip's (the two downstage deck rows, 16'); where its near edge falls follows, and so does the
# overlap in the middle. A footprint centres on its projector's depth, the middle of that strip.
PROJ_SIDE_LENS = (ft(19), TRUSS_DS_Y, DECK_H + ft(20, 5))   # +x is stage left; SR mirrors x


def side_rig():
    """(aim, throw ratio, tilt°, keystone H°, near edge) of a side projector whose portrait
    image is keystoned square, as deep as the downstage strip, its far edge on the far deck edge.

    A tilted projector throws a trapezoid: the far side of the image lands wider than the
    near. Keystone H (Loom's model shears the image's long axis into the clip w — the
    trapezoid a tilted screen makes) by atan(tan(half-width) / tan(tilt)) puts the vanishing
    point of the image's long edges on the floor's horizon, so they land PARALLEL: the image
    is an undistorted rectangle, every pixel the same size on the deck. Squared up, its depth
    on the deck is 2·drop·tan(half-height) / sin(tilt), which fixes the lens for each tilt;
    the tilt is the one whose keystoned far edge then lands on the far deck edge. The near
    edge is where it falls, returned as its distance from the centre line on the projector's
    own side (so the overlap in the middle is twice it).
    """
    lx, ly, lz = PROJ_SIDE_LENS
    drop = lz - GRATE_TOP                              # the images land on the grated stage deck
    depth = DS_STRIP[1] - DS_STRIP[0]
    far = math.atan2(drop, lx + STAGE_W / 2)           # down to the opposite deck edge

    def lens(tilt):                                    # tan(half the long side) for the depth
        return depth * PROJ_ASPECT * math.sin(tilt) / (2 * drop)

    def miss(tilt):                                    # far edge short (+) or past (−) the deck edge
        t, h = math.tan(tilt), lens(tilt)
        return math.tan(tilt - far) - h * t / (t + h)

    lo, hi = far + 1e-6, math.radians(89.0)
    for _ in range(200):
        mid = (lo + hi) / 2
        if (miss(lo) > 0) == (miss(mid) > 0):
            lo = mid
        else:
            hi = mid
    tilt = (lo + hi) / 2
    t, h = math.tan(tilt), lens(tilt)
    near = tilt + math.atan(h * t / (t - h))
    keystone = math.degrees(math.atan(h / t))
    return (lx - drop / t, ly, GRATE_TOP), 0.5 / h, math.degrees(tilt), keystone, lx - drop / math.tan(near)


PROJ_SIDE_AIM, PROJ_SIDE_THROW, _, PROJ_SIDE_KEYSTONE, PROJ_SIDE_NEAR = side_rig()
# The downstage (IMAG) projector hangs from its own 8' truss (plan: 6'-4" downstage of the
# stage's edge, 4'-0" each side of centre) at the frame's trim, on a drop: its lens 19'-8"
# above the house deck (elevation, at its scale). It hangs from a clamp under the truss and
# tilts about that clamp, so its lens sits DS_LENS_FORWARD ahead of and DS_LENS_DROP below
# the clamp. Loom moves the truss in z and tilts the body; these are the rest values.
DS_TRUSS_HALF = 4 * FT   # an 8' truss, across the stage
DS_TRUSS_Y = DECK_Y0 - ft(6, 4)
DS_THROW_RATIO = 0.74
DS_LENS_FORWARD = 0.12 + 0.75 / 2   # the fixture body's half length plus its lens barrel
DS_CLAMP = (0.0, DS_TRUSS_Y, TRUSS_Z - TRUSS_W / 2 - 0.12)
DS_LENS_DROP = DS_CLAMP[2] - (DECK_H + ft(19, 8))   # clamp to lens, at zero tilt

# ---- house -------------------------------------------------------------------------------
HOUSE = (-30.0, 12.0)    # floor y extent (x is +-25)
PEDESTALS_X = (-ft(16), -ft(5, 6), ft(5, 6), ft(16))   # plan: on the floor, 1' off the downstage edge
PEDESTAL_Y = DECK_Y0 - ft(1)
PEDESTAL_TOP = DECK_H - ft(0, 6)
TRIPOD = (-ft(23, 6), DECK_Y0 - ft(2, 7))

# ---- talent stand-ins (two dancers downstage, a vocalist on the riser) -------------------
TALENT = ((-3.6, -2.0, GRATE_TOP), (3.6, -2.0, GRATE_TOP), (0.0, (RISER_Y[0] + RISER_Y[1]) / 2, RISER_TOP))


def canvas():
    """The flat part of the scrim that the DS projector must fill (x0, x1, z0, z1)."""
    return (-CURTAIN_FLAT_X, CURTAIN_FLAT_X, RISER_TOP, CURTAIN_TOP)


def ds_lens(tilt_deg):
    """The DS lens once the body is tilted down by tilt_deg about its clamp (Blender axes)."""
    t = math.radians(tilt_deg)
    cx, cy, cz = DS_CLAMP
    return (cx, cy + DS_LENS_FORWARD * math.cos(t) - DS_LENS_DROP * math.sin(t),
            cz - DS_LENS_FORWARD * math.sin(t) - DS_LENS_DROP * math.cos(t))


def ds_rest_tilt():
    """The tilt (degrees down) that puts the DS optical axis on the canvas centre."""
    _, _, z0, z1 = canvas()
    centre = 0.5 * (z0 + z1)
    tilt = 0.0
    for _ in range(40):  # the lens moves as the body tilts, so settle it
        _, ly, lz = ds_lens(tilt)
        tilt = math.degrees(math.atan2(lz - centre, CURTAIN_Y - ly))
    return tilt


def ds_aim():
    """Where the DS optical axis meets the scrim plane at the rest tilt."""
    t = math.radians(ds_rest_tilt())
    lx, ly, lz = ds_lens(ds_rest_tilt())
    return (lx, CURTAIN_Y, lz - math.tan(t) * (CURTAIN_Y - ly))


def projectors():
    """(name, lens, aim, throw ratio, keystone H°) for the three projectors. The side keystone
    is a magnitude: Loom gives each side its own sign (the mirror of a keystone is its negative)."""
    sx, sy, sz = PROJ_SIDE_LENS
    ax, ay, az = PROJ_SIDE_AIM
    return [
        ("SR", (-sx, sy, sz), (-ax, ay, az), PROJ_SIDE_THROW, PROJ_SIDE_KEYSTONE),
        ("SL", (sx, sy, sz), (ax, ay, az), PROJ_SIDE_THROW, PROJ_SIDE_KEYSTONE),
        ("DS", ds_lens(ds_rest_tilt()), ds_aim(), DS_THROW_RATIO, 0.0),
    ]


# ---- previz cameras: (name, eye, target, lens mm on a 36 mm sensor) ----------------------
CAMERAS = [
    ("foh", (0.0, -15.0, 1.75), (0.0, 1.5, 4.9), 24.0),
    ("iso", (-17.0, -21.0, 12.5), (0.0, 0.5, 4.2), 30.0),
    ("wing", (-15.5, -7.5, 3.2), (1.5, -0.5, 4.6), 20.0),
    ("projector", (0.0, DS_CLAMP[1] - 1.0, DS_CLAMP[2] - 0.9), (0.0, CURTAIN_Y, 6.0), 24.0),
    ("wide", (6.0, -34.0, 6.0), (0.0, 0.0, 4.6), 30.0),
]
