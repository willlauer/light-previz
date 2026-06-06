#!/usr/bin/env python3
"""
Procedural generator for a rooftop-restaurant OBJ + MTL + textures.
Pure stdlib (no PIL/numpy). Y-up, meters. Designed for Three.js import.

Footprint 20 x 14 m (= 280 m^2). Seats 100 guests (25 tables x 4) plus a bar,
a stair/elevator core, pergola, planters and a glass perimeter railing.
"""
import os, math, zlib, struct

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ROOFTOP_RESTAURANT_OBJ")
os.makedirs(OUT, exist_ok=True)

# --------------------------------------------------------------------------
# PNG writer (8-bit RGB)
# --------------------------------------------------------------------------
def write_png(path, w, h, pix):
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))
    raw = bytearray()
    stride = w * 3
    for y in range(h):
        raw.append(0)                       # filter type 0
        raw += pix[y * stride:(y + 1) * stride]
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))

# --------------------------------------------------------------------------
# value-noise / fbm
# --------------------------------------------------------------------------
def _hash(x, y, seed):
    n = (x * 374761393 + y * 668265263 + seed * 1013904223) & 0xffffffff
    n = (n ^ (n >> 13)) * 1274126177 & 0xffffffff
    n ^= n >> 16
    return (n & 0xffffff) / 0xffffff

def _smooth(t):
    return t * t * (3 - 2 * t)

def vnoise(x, y, seed):
    xi, yi = math.floor(x), math.floor(y)
    xf, yf = x - xi, y - yi
    a = _hash(xi, yi, seed);     b = _hash(xi + 1, yi, seed)
    c = _hash(xi, yi + 1, seed); d = _hash(xi + 1, yi + 1, seed)
    u, v = _smooth(xf), _smooth(yf)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v

def fbm(x, y, seed, octaves=4):
    val, amp, freq, norm = 0.0, 0.5, 1.0, 0.0
    for i in range(octaves):
        val += amp * vnoise(x * freq, y * freq, seed + i * 97)
        norm += amp
        amp *= 0.5; freq *= 2.0
    return val / norm

def clamp8(v):
    return 0 if v < 0 else (255 if v > 255 else int(v))

def gen_texture(name, size, fn):
    """fn(u, v) -> (r, g, b) floats 0..255, u/v in 0..1"""
    pix = bytearray(size * size * 3)
    inv = 1.0 / size
    i = 0
    for y in range(size):
        v = y * inv
        for x in range(size):
            r, g, b = fn(x * inv, v)
            pix[i] = clamp8(r); pix[i + 1] = clamp8(g); pix[i + 2] = clamp8(b)
            i += 3
    path = os.path.join(OUT, name)
    write_png(path, size, size, pix)
    return path

def mix(a, b, t):
    return a + (b - a) * t

# --------------------------------------------------------------------------
# texture definitions
# --------------------------------------------------------------------------
def tex_deck(u, v):                          # warm wood decking, planks along U
    planks = 7.0
    p = v * planks
    seam = abs((p - math.floor(p)) - 0.5)            # 0 at seam centre region
    board = math.floor(p)
    tint = (_hash(board, 3, 11) - 0.5) * 26          # per-board colour shift
    grain = fbm(u * 26, v * 90, 5, 4)                # stretched grain
    streak = fbm(u * 4, v * 70, 8, 3)
    base = 118 + tint + (grain - 0.5) * 46 + (streak - 0.5) * 18
    r, g, b = base * 1.16, base * 0.86, base * 0.58
    if seam > 0.46:                                  # dark gap between boards
        r *= 0.45; g *= 0.42; b *= 0.40
    return r, g, b

def tex_table(u, v):                         # lighter oak tabletop
    rings = fbm(u * 8, v * 60, 21, 4)
    grain = fbm(u * 30, v * 80, 22, 3)
    base = 150 + (rings - 0.5) * 40 + (grain - 0.5) * 26
    return base * 1.15, base * 0.95, base * 0.66

def tex_bartop(u, v):                         # dark walnut bar / counter
    grain = fbm(u * 22, v * 70, 31, 4)
    knot = fbm(u * 6, v * 18, 32, 3)
    base = 64 + (grain - 0.5) * 30 + (knot - 0.5) * 16
    return base * 1.25, base * 0.82, base * 0.55

def tex_stucco(u, v):                         # warm plaster wall
    m = fbm(u * 9, v * 9, 41, 5)
    fine = fbm(u * 60, v * 60, 42, 3)
    base = 196 + (m - 0.5) * 34 + (fine - 0.5) * 12
    return base * 1.02, base * 0.96, base * 0.85

def tex_concrete(u, v):                       # grey parapet / structure
    m = fbm(u * 7, v * 7, 51, 5)
    spec = fbm(u * 120, v * 120, 52, 2)
    base = 150 + (m - 0.5) * 40 + (spec - 0.5) * 22
    return base, base * 1.0, base * 1.02

def tex_metal(u, v):                          # dark brushed metal
    brush = fbm(u * 6, v * 130, 61, 3)
    spec = fbm(u * 40, v * 40, 62, 2)
    base = 58 + (brush - 0.5) * 26 + (spec - 0.5) * 14
    return base * 0.95, base * 0.98, base * 1.05

def tex_glass(u, v):                          # subtle tinted glass
    g = fbm(u * 5, v * 5, 71, 3)
    base = 150 + (g - 0.5) * 24
    return base * 0.82, base * 0.93, base

def tex_canopy(u, v):                          # cream canvas weave
    weave = (math.sin(u * size_weave) + math.sin(v * size_weave)) * 4
    soil = fbm(u * 8, v * 8, 81, 3)
    base = 222 + (soil - 0.5) * 16 + weave
    return base * 1.0, base * 0.97, base * 0.86

def tex_terracotta(u, v):                       # planter
    m = fbm(u * 10, v * 10, 91, 4)
    base = 150 + (m - 0.5) * 40
    return base * 1.2, base * 0.72, base * 0.5

def tex_foliage(u, v):                            # leafy green
    leaf = fbm(u * 22, v * 22, 101, 5)
    hi = fbm(u * 55, v * 55, 102, 3)
    g = 95 + leaf * 80 + (hi - 0.5) * 30
    return g * 0.45, g, g * 0.40

size_weave = 2 * math.pi * 80

TEXTURES = [
    ("deck_wood.png",  1024, tex_deck),
    ("table_oak.png",   512, tex_table),
    ("bar_walnut.png",  512, tex_bartop),
    ("wall_stucco.png", 512, tex_stucco),
    ("concrete.png",    512, tex_concrete),
    ("metal_dark.png",  512, tex_metal),
    ("glass.png",       256, tex_glass),
    ("canopy.png",      512, tex_canopy),
    ("terracotta.png",  256, tex_terracotta),
    ("foliage.png",     512, tex_foliage),
]

# --------------------------------------------------------------------------
# geometry builder
# --------------------------------------------------------------------------
CUBE_LOOPS = [
    [(1,-1,-1),(1,1,-1),(1,1,1),(1,-1,1)],        # +X
    [(-1,-1,-1),(-1,1,-1),(-1,1,1),(-1,-1,1)],    # -X
    [(-1,1,-1),(1,1,-1),(1,1,1),(-1,1,1)],        # +Y
    [(-1,-1,-1),(1,-1,-1),(1,-1,1),(-1,-1,1)],    # -Y
    [(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)],        # +Z
    [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1)],    # -Z
]

class Builder:
    def __init__(self):
        self.v, self.vt, self.vn, self.faces = [], [], [], []
        self.cur = None

    def use(self, name, mtl):
        self.faces.append(("grp", name, mtl))

    def _add_quad(self, pts, normal, uvs):
        base = len(self.v) + 1
        for p in pts: self.v.append(p)
        self.vn.append(normal)
        for uv in uvs: self.vt.append(uv)
        ni = len(self.vn)
        f = [(base + k, base + k, ni) for k in range(len(pts))]
        self.faces.append(("f", f))

    def box(self, cx, cy, cz, sx, sy, sz, tile=1.0):
        hx, hy, hz = sx / 2, sy / 2, sz / 2
        cen = (cx, cy, cz)
        for loop in CUBE_LOOPS:
            pts = [(cx + s[0]*hx, cy + s[1]*hy, cz + s[2]*hz) for s in loop]
            a, b, c = pts[0], pts[1], pts[2]
            ux, uy, uz = b[0]-a[0], b[1]-a[1], b[2]-a[2]
            vx, vy, vz = c[0]-a[0], c[1]-a[1], c[2]-a[2]
            nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
            # orient outward
            fc = ((a[0]+c[0])/2, (a[1]+c[1])/2, (a[2]+c[2])/2)
            if (nx*(fc[0]-cen[0]) + ny*(fc[1]-cen[1]) + nz*(fc[2]-cen[2])) < 0:
                pts = pts[::-1]
                nx, ny, nz = -nx, -ny, -nz
            ln = math.sqrt(nx*nx+ny*ny+nz*nz) or 1
            nrm = (nx/ln, ny/ln, nz/ln)
            ax = max(range(3), key=lambda i: abs((nx,ny,nz)[i]))
            ip = [i for i in range(3) if i != ax]            # in-plane axes
            uvs = [((p[ip[0]])/tile, (p[ip[1]])/tile) for p in pts]
            self._add_quad(pts, nrm, uvs)

    def prism(self, cx, cy, cz, r, h, sides, tile=1.0):
        y0, y1 = cy - h/2, cy + h/2
        ring = []
        for i in range(sides):
            a = 2*math.pi*i/sides
            ring.append((cx + r*math.cos(a), cz + r*math.sin(a), a))
        # sides
        for i in range(sides):
            x0, z0, a0 = ring[i]
            x1, z1, a1 = ring[(i+1) % sides]
            pts = [(x0,y0,z0),(x1,y0,z1),(x1,y1,z1),(x0,y1,z0)]
            nx, nz = math.cos((a0+a1)/2), math.sin((a0+a1)/2)
            uvs = [(i*r*2/tile,0),((i+1)*r*2/tile,0),
                   ((i+1)*r*2/tile,h/tile),(i*r*2/tile,h/tile)]
            self._add_quad(pts, (nx,0,nz), uvs)
        # top & bottom as triangle fans
        for yy, ny, order in ((y1,1,range(sides)), (y0,-1,range(sides-1,-1,-1))):
            base = len(self.v) + 1
            self.v.append((cx, yy, cz))
            for i in range(sides):
                x, z, _ = ring[i]
                self.v.append((x, yy, z))
            self.vn.append((0, ny, 0)); ni = len(self.vn)
            self.vt.append((0.5, 0.5))
            for i in range(sides):
                x, z, _ = ring[i]
                self.vt.append((0.5 + (x-cx)/(2*r), 0.5 + (z-cz)/(2*r)))
            cuv = len(self.vt) - sides
            ol = list(order)
            for k in range(sides):
                i0 = ol[k]; i1 = ol[(k+1) % sides]
                f = [(base, cuv, ni),
                     (base+1+i0, cuv+1+i0, ni),
                     (base+1+i1, cuv+1+i1, ni)]
                self.faces.append(("f", f))

    def write(self, obj_path, mtl_name):
        with open(obj_path, "w") as f:
            f.write("# Rooftop restaurant - procedurally generated\n")
            f.write("mtllib %s\n" % mtl_name)
            for p in self.v:  f.write("v %.4f %.4f %.4f\n" % p)
            for t in self.vt: f.write("vt %.4f %.4f\n" % t)
            for n in self.vn: f.write("vn %.4f %.4f %.4f\n" % n)
            for item in self.faces:
                if item[0] == "grp":
                    f.write("g %s\nusemtl %s\n" % (item[1], item[2]))
                else:
                    f.write("f " + " ".join("%d/%d/%d" % t for t in item[1]) + "\n")

# --------------------------------------------------------------------------
# build the scene
# --------------------------------------------------------------------------
B = Builder()
seats = 0

# ---- deck slab (the flat plane everything sits on) ----------------------
B.use("deck", "deck_wood")
B.box(0, -0.10, 0, 20.0, 0.20, 14.0, tile=1.4)

# A low trim band flush around the deck edge so the plane reads cleanly.
B.use("deck_trim", "concrete")
for (cx, cz, sx, sz) in [
    (0,  6.95, 20.0, 0.10), (0, -6.95, 20.0, 0.10),
    (9.95, 0, 0.10, 14.0), (-9.95, 0, 0.10, 14.0)]:
    B.box(cx, 0.05, cz, sx, 0.10, sz, tile=1.5)

# ---- bar ----------------------------------------------------------------
bar_cx = 7.4
B.use("bar_body", "bar_walnut")
B.box(bar_cx, 0.52, -0.5, 0.65, 1.04, 5.0, tile=1.5)         # main counter
B.box(bar_cx + 0.95, 0.45, -0.5, 0.55, 0.90, 4.6, tile=1.5)  # back cabinet
B.use("bar_top", "concrete")
B.box(bar_cx, 1.08, -0.5, 0.78, 0.06, 5.1, tile=1.2)         # stone bar top

# ---- pergola over the dining area ---------------------------------------
perg_x = (-8.6, 2.2)
perg_z = (-5.4, 5.4)
perg_h = 3.0
B.use("pergola_posts", "metal")
for px in perg_x:
    for pz in perg_z:
        B.box(px, perg_h/2, pz, 0.16, perg_h, 0.16, tile=1.0)
    B.box(px, perg_h/2, 0, 0.16, perg_h, 0.16, tile=1.0)     # mid posts
B.use("pergola_beams", "bar_walnut")
for pz in perg_z:                                            # long beams
    B.box((perg_x[0]+perg_x[1])/2, perg_h+0.07, pz,
          perg_x[1]-perg_x[0]+0.3, 0.16, 0.14, tile=1.5)
ncross = 7
for k in range(ncross):                                      # cross beams
    cz = perg_z[0] + (perg_z[1]-perg_z[0])*k/(ncross-1)
    B.box((perg_x[0]+perg_x[1])/2, perg_h+0.18, cz,
          perg_x[1]-perg_x[0], 0.10, 0.10, tile=1.0)
B.use("pergola_canopy", "canopy")                            # fabric strips
nstrip = 5
for k in range(nstrip):
    cz = perg_z[0] + 0.6 + (perg_z[1]-perg_z[0]-1.2)*k/(nstrip-1)
    B.box((perg_x[0]+perg_x[1])/2, perg_h+0.26, cz,
          perg_x[1]-perg_x[0]-0.4, 0.02, 1.4, tile=2.0)

# ---- planters along the rail --------------------------------------------
def planter(cx, cz):
    B.use("planter", "terracotta")
    B.box(cx, 0.30, cz, 0.7, 0.60, 0.7, tile=0.8)
    B.use("foliage", "foliage")
    B.box(cx, 0.78, cz, 0.66, 0.40, 0.66, tile=0.7)
for x in (-8.5, -5.5, -2.5, 0.5):
    planter(x, 6.4)
    planter(x, -6.4)
for z in (-4.5, 0, 4.5):
    planter(-9.4, z)

# ---- tables + chairs (25 tables x 4 = 100 seats) ------------------------
def chair(cx, cz, facing):
    B.use("chair", "metal")
    dx, dz = facing
    B.box(cx, 0.45, cz, 0.42, 0.06, 0.42, tile=1.0)          # seat
    # backrest sits on the far side from the table centre
    B.box(cx + dx*0.20, 0.66, cz + dz*0.20,
          0.42 if dz else 0.06, 0.42, 0.42 if dx else 0.06, tile=1.0)
    for sx in (-0.16, 0.16):
        for sz in (-0.16, 0.16):
            B.box(cx+sx, 0.22, cz+sz, 0.04, 0.44, 0.04, tile=1.0)

def table(cx, cz):
    global seats
    B.use("table", "table_oak")
    B.prism(cx, 0.74, cz, 0.55, 0.06, 16, tile=0.9)          # round top
    B.use("table_base", "metal")
    B.box(cx, 0.37, cz, 0.10, 0.70, 0.10, tile=1.0)          # pedestal
    B.prism(cx, 0.03, cz, 0.30, 0.05, 12, tile=1.0)          # foot
    for (ox, oz, fc) in [(0, 0.9, (0,1)), (0, -0.9, (0,-1)),
                         (0.9, 0, (1,0)), (-0.9, 0, (-1,0))]:
        chair(cx+ox, cz+oz, fc)
        seats += 1

cols = [-8.5, -5.5, -2.5, 0.5, 3.5]
rows = [-4.5, -2.25, 0.0, 2.25, 4.5]
for cx in cols:
    for cz in rows:
        table(cx, cz)

# --------------------------------------------------------------------------
# write OBJ + MTL + textures
# --------------------------------------------------------------------------
print("generating %d textures..." % len(TEXTURES))
for (name, sz, fn) in TEXTURES:
    gen_texture(name, sz, fn)
    print("  ", name, "%dx%d" % (sz, sz))

MTL = """# Rooftop restaurant materials
newmtl deck_wood
\tNs 18\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.10 0.10 0.10
\tmap_Kd deck_wood.png\n\tmap_Ka deck_wood.png

newmtl table_oak
\tNs 24\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.12 0.12 0.12
\tmap_Kd table_oak.png\n\tmap_Ka table_oak.png

newmtl bar_walnut
\tNs 30\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.18 0.18 0.18
\tmap_Kd bar_walnut.png\n\tmap_Ka bar_walnut.png

newmtl wall_stucco
\tNs 8\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.04 0.04 0.04
\tmap_Kd wall_stucco.png\n\tmap_Ka wall_stucco.png

newmtl concrete
\tNs 8\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.05 0.05 0.05
\tmap_Kd concrete.png\n\tmap_Ka concrete.png

newmtl metal
\tNs 120\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.55 0.55 0.55
\tmap_Kd metal_dark.png\n\tmap_Ka metal_dark.png

newmtl glass
\tNs 200\n\td 0.42\n\tTr 0.58\n\tillum 4\n\tKa 0.6 0.7 0.75\n\tKd 0.6 0.7 0.75\n\tKs 0.9 0.9 0.9
\tmap_Kd glass.png

newmtl canopy
\tNs 6\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.03 0.03 0.03
\tmap_Kd canopy.png\n\tmap_Ka canopy.png

newmtl terracotta
\tNs 10\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.06 0.06 0.06
\tmap_Kd terracotta.png\n\tmap_Ka terracotta.png

newmtl foliage
\tNs 6\n\td 1\n\tillum 2\n\tKa 1 1 1\n\tKd 1 1 1\n\tKs 0.05 0.05 0.05
\tmap_Kd foliage.png\n\tmap_Ka foliage.png
"""

mtl_name = "rooftop_restaurant.mtl"
with open(os.path.join(OUT, mtl_name), "w") as f:
    f.write(MTL)
B.write(os.path.join(OUT, "rooftop_restaurant.obj"), mtl_name)

print("seats:", seats)
print("verts:", len(B.v), "faces:", sum(1 for it in B.faces if it[0]=="f"))
print("output:", OUT)
