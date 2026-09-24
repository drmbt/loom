"""Plant layout, Blender coordinates (Z up, metres).

X runs along the hall (crane travel), Y across it, Z up.
The furnace sits at the origin; tapping (EBT) faces +X, slag door -X,
masts + transformer vault +Y, control pulpit -Y. Scrap bay at -X, ladle bay
and caster at +X.
"""
import math

# hall shell
HX0, HX1 = -60.0, 60.0          # hall length 120 m
HY = 17.0                        # half width -> 34 m span
BAY = 12.0                       # column pitch along X
COLS_X = [HX0 + BAY * k for k in range(int((HX1 - HX0) / BAY) + 1)]
RAIL_Z = 24.0                    # crane rail top
RAIL_Y = 15.6                    # crane rail centre line (+/-)
TRUSS_Z = 29.5                   # truss bottom chord
EAVE_Z = 30.0
RIDGE_Z = 34.0                   # truss top at ridge
MONITOR_Z = 37.2                 # roof monitor top

# furnace bay
DECK_Z = 6.2                     # operating floor top
SHELL_R = 3.9                    # outer shell radius
SHELL_BASE_Z = 8.0               # dish/cylinder joint
SHELL_TOP_Z = 12.4
ROOF_RING_Z = 12.4
BATH_Z = 8.9                     # molten bath surface
ARC_GAP = 0.55
PCD_R = 0.68                     # electrode pitch circle radius
ELEC_R = 0.305                   # 610 mm electrodes
ELEC_ANG = [math.radians(a) for a in (210.0, 90.0, 330.0)]   # electrode 1,2,3 (2 nearest masts)
ELEC_XY = [(PCD_R * math.cos(a), PCD_R * math.sin(a)) for a in ELEC_ANG]
MAST_XY = [(-2.5, 6.4), (0.0, 6.9), (2.5, 6.4)]
ARM_Z = 17.4                     # arm centreline
TIP_Z = BATH_Z + ARC_GAP
ROCKER_R = 5.2                   # rocker radius
ROCKER_RAIL_Z = 5.6              # rocker rails (on foundation piers) top
ROCKER_Y = 3.1                   # rockers at y = +/- ROCKER_Y
TILT_PIVOT = (0.0, 0.0, ROCKER_RAIL_Z + ROCKER_R)   # centre of rocker curvature (rolling tilt ~ rotation about Y here)
DISH_Z = 7.05                    # dish bottom
EBT_XY = (SHELL_R + 1.05, 0.0)
SLAG_DOOR_X = -SHELL_R
ROOF_SWING_PIVOT = (4.4, 5.9)   # vertical swing axis; roof lifts 0.5 m first
FOURTH_HOLE = (2.45 * math.cos(math.radians(205)), 2.45 * math.sin(math.radians(205)))
VAULT = (-7.0, 7.0, 11.2, HY - 0.3)     # x0, x1, y0, y1

# ladle / car
CAR_RAIL_Y = 0.0
CAR_GAUGE = 3.6
CAR_X = 16.0                     # rest position of the ladle car
CAR_RAILS_X = (1.0, 34.0)

# crane
CRANE_X = -10.5
TROLLEY_Y = -4.2
HOOK_Z = 21.0

# caster
CAST_X = 38.0                   # mould / tundish x
CAST_Y = -6.0
CAST_FLOOR_Z = 12.0
CAST_R = 9.5                     # strand bow radius
CAST_ARC_Z = 11.0                # strand leaves the mould vertically at this height
TURRET_XY = (38.0, -0.4)

# conveyor (alloy/scrap) from scrap bay up to bunker
CONV_A = (-46.0, -11.0, 1.6)
CONV_B = (-9.5, -11.0, 20.0)
BUNKER = (-6.2, -7.8)

FURNACE_C = (0.0, 0.0, 10.0)
