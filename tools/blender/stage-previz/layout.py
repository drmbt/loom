"""Every coordinate of the stage, in one place (metres, Blender Z up, audience at -Y).

ESTIMATES. These were read off the designer's ISO renders and the front elevation, not a
plot. Change the numbers here and rebuild; the Loom session re-reads the projector and
camera positions from the GLB, so nothing else needs editing.

Axes: X = stage width (+X is STAGE LEFT, the audience's right), Y = depth (+Y upstage),
Z = up. glTF / Loom space is (x, z, -y): Loom +Z points at the audience.
"""
import math

# ---- the deck ---------------------------------------------------------------------------
DECK_W = 16.0            # x -8 .. 8
DECK_D = 10.0            # y -5 .. 5
DECK_Y0 = -5.0           # downstage edge
DECK_H = 1.4             # deck top above the house floor
DECK_TOP_T = 0.08        # black top sheet thickness

# ---- the upstage riser, with side stairs -------------------------------------------------
RISER_X = 4.4            # half width
RISER_Y = (1.4, 3.6)     # downstage face .. upstage face
RISER_H = 1.6            # above the deck
STAIR_STEPS = 8          # risers per stair (RISER_H / STAIR_STEPS each)
STAIR_GOING = 0.28
STAIR_Y = (1.9, 3.3)     # stair width runs along y
RISER_LED_Z = (0.35, 0.8, 1.25)   # LED strips on the riser face, above the deck

# ---- upstage wall: curtain, and the LED batten grid in front of it ----------------------
CURTAIN_Y = 4.35         # the pipe line
CURTAIN_TOP = 9.3        # absolute z of the pipe
CURTAIN_X = 8.0          # half width along the pipe
CURTAIN_FLAT_X = 6.2     # half width of the flat projection canvas; beyond it the drape is tied back
CURTAIN_TIE = (7.7, 2.6) # where each tied-back end pools on the deck (|x|, y)
CURTAIN_PLEAT = (0.055, 0.42)     # amplitude, wavelength

GRID_Y = 4.0             # vertical members and LED battens, 35 cm in front of the curtain
GRID_X = (-5.25, -3.5, -1.75, 0.0, 1.75, 3.5, 5.25)
GRID_BATTEN_Z = (4.4, 5.6, 6.8, 8.0)
GRID_BATTEN_X = 5.45

# ---- midstage kabuki (sheer), downstage of the riser -------------------------------------
KABUKI_Y = 0.75
KABUKI_TOP = 9.3
KABUKI_X = 7.4
KABUKI_FLAT_X = 5.6
KABUKI_TIE = (7.6, -0.9)
KABUKI_PLEAT = (0.045, 0.36)

# ---- the flown frame: upstage truss + kabuki truss + two side trusses --------------------
TRUSS_Z = 9.6            # centre line
TRUSS_W = 0.4            # box truss section
TRUSS_X = 8.6
TRUSS_US_Y = 4.1
TRUSS_DS_Y = 0.55

# ---- projectors (lens position, aim point) -----------------------------------------------
PROJ_ASPECT = 16.0 / 9.0
# Side projectors hang under the downstage corners of the frame, angled down and inward,
# used as light: a volumetric cone through the haze onto the downstage deck.
PROJ_SIDE_LENS = (8.15, 0.15, 8.55)        # +x is stage left; stage right mirrors x
PROJ_SIDE_AIM = (3.6, -1.0, DECK_H)          # keeps the whole footprint on the deck (y -4.0 .. 1.4)
PROJ_SIDE_THROW = 1.8
# The downstage (IMAG) projector on a short FOH truss, far enough back to fill the canvas.
FOH_Y = -20.0
FOH_Z = 7.6              # truss centre line
FOH_HALF = 2.5
PROJ_DS_LENS = (0.0, FOH_Y + 0.25, FOH_Z - 0.62)

# ---- house -------------------------------------------------------------------------------
HOUSE = (-30.0, 12.0)    # floor y extent (x is +-25)
PEDESTALS_X = (-6.2, -2.2, 2.2, 6.2)
PEDESTAL_Y = -6.0
TRIPOD = (-6.6, -7.6)

# ---- talent stand-ins (two dancers downstage, a vocalist on the riser) -------------------
TALENT = ((-3.6, -2.0, DECK_H), (3.6, -2.0, DECK_H), (0.0, 2.5, DECK_H + RISER_H))


def canvas():
    """The flat part of the upstage curtain that the DS projector must fill (x0, x1, z0, z1)."""
    return (-CURTAIN_FLAT_X, CURTAIN_FLAT_X, DECK_H + RISER_H, CURTAIN_TOP)


def ds_aim():
    x0, x1, z0, z1 = canvas()
    return (0.0, CURTAIN_Y, 0.5 * (z0 + z1))


def ds_throw():
    """Throw ratio that makes the DS image exactly the canvas width."""
    lens, aim = PROJ_DS_LENS, ds_aim()
    distance = math.dist(lens, aim)
    x0, x1, _, _ = canvas()
    return distance / (x1 - x0)


def projectors():
    """(name, lens, aim, throw ratio) for the three projectors."""
    sx, sy, sz = PROJ_SIDE_LENS
    ax, ay, az = PROJ_SIDE_AIM
    return [
        ("SR", (-sx, sy, sz), (-ax, ay, az), PROJ_SIDE_THROW),
        ("SL", (sx, sy, sz), (ax, ay, az), PROJ_SIDE_THROW),
        ("DS", PROJ_DS_LENS, ds_aim(), ds_throw()),
    ]


# ---- previz cameras: (name, eye, target, lens mm on a 36 mm sensor) ----------------------
CAMERAS = [
    ("foh", (0.0, -15.0, 1.75), (0.0, 1.5, 4.9), 24.0),
    ("iso", (-17.0, -21.0, 12.5), (0.0, 0.5, 4.2), 30.0),
    ("wing", (-15.5, -7.5, 3.2), (1.5, -0.5, 4.6), 20.0),
    ("projector", (0.0, FOH_Y + 1.2, FOH_Z - 0.2), (0.0, CURTAIN_Y, 5.6), 32.0),
    ("wide", (6.0, -34.0, 6.0), (0.0, 0.0, 4.6), 30.0),
]
