#!/usr/bin/env python3
"""
Procedural generator for a DJ table + controller OBJ + MTL.
Pure stdlib. Y-up, meters. Designed for Three.js import (matches gen_rooftop.py).

A simple DJ booth: a rectangular table on four legs, with a DJ controller
sitting on top. The controller has two jog wheels, a row of knobs and a
grid of colored performance pads so it reads clearly as a controller.
"""
import os, math

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "DJ_TABLE_OBJ")
os.makedirs(OUT, exist_ok=True)

# --------------------------------------------------------------------------
# Geometry buffer. Faces are grouped by material; vertices are global and
# 1-based in the emitted OBJ.
# --------------------------------------------------------------------------
verts = []                 # list of (x, y, z)
faces = []                 # list of (material, [v_idx, ...])

def v(x, y, z):
    verts.append((x, y, z))
    return len(verts)      # 1-based index

def box(cx, cy, cz, sx, sy, sz, mat):
    """Axis-aligned box centered at (cx,cy,cz) with full sizes (sx,sy,sz)."""
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    # 8 corners
    a = v(cx - hx, cy - hy, cz - hz)
    b = v(cx + hx, cy - hy, cz - hz)
    c = v(cx + hx, cy - hy, cz + hz)
    d = v(cx - hx, cy - hy, cz + hz)
    e = v(cx - hx, cy + hy, cz - hz)
    f = v(cx + hx, cy + hy, cz - hz)
    g = v(cx + hx, cy + hy, cz + hz)
    h = v(cx - hx, cy + hy, cz + hz)
    faces.append((mat, [a, b, c, d]))      # bottom
    faces.append((mat, [e, h, g, f]))      # top
    faces.append((mat, [a, e, f, b]))      # -z
    faces.append((mat, [d, c, g, h]))      # +z
    faces.append((mat, [a, d, h, e]))      # -x
    faces.append((mat, [b, f, g, c]))      # +x

def cylinder(cx, cy, cz, r, h, mat, seg=24):
    """Vertical cylinder, base at cy, height h, radius r."""
    top = []
    bot = []
    for i in range(seg):
        ang = 2 * math.pi * i / seg
        x = cx + r * math.cos(ang)
        z = cz + r * math.sin(ang)
        bot.append(v(x, cy, z))
        top.append(v(x, cy + h, z))
    # side quads
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((mat, [bot[i], bot[j], top[j], top[i]]))
    # top cap (fan)
    cen_t = v(cx, cy + h, cz)
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((mat, [cen_t, top[i], top[j]]))
    # bottom cap (fan)
    cen_b = v(cx, cy, cz)
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((mat, [cen_b, bot[j], bot[i]]))

# --------------------------------------------------------------------------
# Dimensions (meters). Origin at floor center; table front faces +Z.
# --------------------------------------------------------------------------
TABLE_W   = 1.40   # x
TABLE_D   = 0.70   # z
TOP_Y     = 0.92   # height of table surface
TOP_T     = 0.05   # tabletop thickness
LEG       = 0.06   # leg cross-section
LEG_INSET = 0.05

# ---- Tabletop ----
box(0, TOP_Y - TOP_T / 2, 0, TABLE_W, TOP_T, TABLE_D, "table_top")

# ---- Legs ----
leg_y = (TOP_Y - TOP_T) / 2
lx = TABLE_W / 2 - LEG / 2 - LEG_INSET
lz = TABLE_D / 2 - LEG / 2 - LEG_INSET
for sx in (-1, 1):
    for sz in (-1, 1):
        box(sx * lx, leg_y, sz * lz, LEG, TOP_Y - TOP_T, LEG, "table_leg")

# ---- Modesty / stretcher rail between legs (back) ----
box(0, 0.30, -lz, 2 * lx, 0.18, LEG, "table_leg")

# --------------------------------------------------------------------------
# Controller sitting on the tabletop.
# --------------------------------------------------------------------------
CTRL_W = 0.82
CTRL_D = 0.34
CTRL_T = 0.05
ctrl_base = TOP_Y                       # rests on the surface
ctrl_cy = ctrl_base + CTRL_T / 2
box(0, ctrl_cy, 0.02, CTRL_W, CTRL_T, CTRL_D, "ctrl_body")

surf_y = ctrl_base + CTRL_T             # top face of controller; mount parts here

# ---- Two jog wheels (left/right decks) ----
JOG_R = 0.10
JOG_H = 0.012
for sx in (-1, 1):
    cx = sx * 0.27
    cylinder(cx, surf_y, 0.0, JOG_R, JOG_H, "jog_metal")
    # small center hub
    cylinder(cx, surf_y + JOG_H, 0.0, 0.025, 0.006, "knob_dark")

# ---- Center mixer: vertical channel faders + crossfader ----
for i, off in enumerate((-0.05, 0.05)):
    box(off, surf_y + 0.004, -0.06, 0.012, 0.008, 0.10, "fader")
# crossfader (horizontal)
box(0, surf_y + 0.004, 0.08, 0.10, 0.008, 0.012, "fader")

# ---- Row of knobs across the mixer section ----
for i in range(5):
    kx = -0.08 + i * 0.04
    cylinder(kx, surf_y, 0.10, 0.012, 0.018, "knob_dark")

# --------------------------------------------------------------------------
# Colored performance pads — 2 banks (one per deck), 4x2 each.
# These are the "few colored buttons" that identify it as a controller.
# --------------------------------------------------------------------------
PAD = 0.032
GAP = 0.012
PAD_H = 0.010
pad_colors = ["pad_red", "pad_green", "pad_blue", "pad_yellow"]

def pad_bank(origin_x, origin_z):
    for row in range(2):
        for col in range(4):
            px = origin_x + col * (PAD + GAP)
            pz = origin_z + row * (PAD + GAP)
            mat = pad_colors[col]
            box(px, surf_y + PAD_H / 2, pz, PAD, PAD_H, PAD, mat)

bank_w = 4 * PAD + 3 * GAP
pad_bank(-0.27 - bank_w / 2 + PAD / 2 + 0.20, -0.10)   # left bank
pad_bank(0.27 - bank_w / 2 + PAD / 2 - 0.20, -0.10)    # right bank

# --------------------------------------------------------------------------
# Write OBJ + MTL
# --------------------------------------------------------------------------
def write_obj(path):
    with open(path, "w") as fp:
        fp.write("# DJ table with controller — generated by gen_dj_table.py\n")
        fp.write("mtllib dj_table.mtl\n")
        fp.write("o dj_table\n")
        for (x, y, z) in verts:
            fp.write(f"v {x:.5f} {y:.5f} {z:.5f}\n")
        cur = None
        for (mat, idx) in faces:
            if mat != cur:
                fp.write(f"usemtl {mat}\n")
                cur = mat
            fp.write("f " + " ".join(str(i) for i in idx) + "\n")

# Solid-color materials (Kd). illum 2 with a little specular.
MATERIALS = {
    # name:        (Kd r,g,b,         Ks,    Ns)
    "table_top":   ((0.18, 0.12, 0.08), 0.10, 24),   # dark wood
    "table_leg":   ((0.10, 0.10, 0.11), 0.20, 40),   # dark metal
    "ctrl_body":   ((0.06, 0.06, 0.07), 0.15, 30),   # black plastic
    "jog_metal":   ((0.55, 0.56, 0.58), 0.55, 120),  # brushed metal
    "knob_dark":   ((0.12, 0.12, 0.13), 0.25, 50),
    "fader":       ((0.75, 0.75, 0.78), 0.40, 90),
    "pad_red":     ((0.90, 0.12, 0.12), 0.30, 60),
    "pad_green":   ((0.12, 0.80, 0.20), 0.30, 60),
    "pad_blue":    ((0.12, 0.35, 0.95), 0.30, 60),
    "pad_yellow":  ((0.95, 0.80, 0.10), 0.30, 60),
}

def write_mtl(path):
    with open(path, "w") as fp:
        fp.write("# DJ table materials\n")
        for name, (kd, ks, ns) in MATERIALS.items():
            r, g, b = kd
            fp.write(f"\nnewmtl {name}\n")
            fp.write(f"\tNs {ns}\n")
            fp.write("\td 1\n")
            fp.write("\tillum 2\n")
            fp.write(f"\tKa {r:.3f} {g:.3f} {b:.3f}\n")
            fp.write(f"\tKd {r:.3f} {g:.3f} {b:.3f}\n")
            fp.write(f"\tKs {ks:.3f} {ks:.3f} {ks:.3f}\n")

write_obj(os.path.join(OUT, "dj_table.obj"))
write_mtl(os.path.join(OUT, "dj_table.mtl"))
print(f"Wrote {len(verts)} verts, {len(faces)} faces to {OUT}/dj_table.obj")
