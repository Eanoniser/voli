#!/usr/bin/env python3
"""Create a small synthetic state pack ("sp") for testing the app without real OSM downloads.

Writes into test/packs/: sp.pmtiles, sp-terrain.pmtiles, sp.route.gz, sp.search.json.gz
(route/search are produced by running the real pipeline/build_index.py on synthetic OSM XML).
"""
import gzip
import io
import math
import os
import subprocess
import sys

import mapbox_vector_tile
import numpy as np
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "packs")
os.makedirs(OUT, exist_ok=True)

LON0, LAT0 = -46.40, -23.50  # synthetic town origin
DX, DY = 0.0016, 0.0014  # ~160 m blocks

nodes = {}  # id -> (lon, lat, tags)
ways = []  # (id, [node ids], tags)
nid = [1]
wid = [1]


def node(lon, lat, tags=None, key=None):
    k = key or (round(lon, 7), round(lat, 7))
    if k in node.cache:
        return node.cache[k]
    i = nid[0]
    nid[0] += 1
    nodes[i] = (lon, lat, tags or {})
    node.cache[k] = i
    return i


node.cache = {}


def way(points, tags):
    ids = [node(lon, lat) for lon, lat in points]
    ways.append((wid[0], ids, tags))
    wid[0] += 1


# Street grid 10 x 10
N = 10
for i in range(N):
    pts = [(LON0 + j * DX, LAT0 + i * DY) for j in range(N)]
    way(pts, {"highway": "residential", "name": f"Rua {i + 1}", "surface": "asphalt"})
    pts = [(LON0 + i * DX, LAT0 + j * DY) for j in range(N)]
    way(pts, {"highway": "residential" if i != 5 else "primary", "name": f"Rua {chr(65 + i)}" if i != 5 else "Avenida Brasil",
              "surface": "asphalt", **({"oneway": "yes"} if i == 3 else {})})
# Highway going east from the town
hw = [(LON0 + (N - 1) * DX + k * 0.004, LAT0 + 4 * DY + k * 0.0007) for k in range(0, 15)]
hw[0] = (LON0 + (N - 1) * DX, LAT0 + 4 * DY)
way(hw, {"highway": "trunk", "name": "Rodovia dos Testes", "ref": "SP-999", "surface": "asphalt", "maxspeed": "100"})
# Dirt shortcut north to a farm, with a ford
farm = [(LON0 + 5 * DX, LAT0 + (N - 1) * DY)] + [(LON0 + 5 * DX + 0.0005 * k, LAT0 + (N - 1) * DY + 0.002 * k) for k in range(1, 8)]
way(farm[:4], {"highway": "unclassified", "name": "Estrada da Fazenda", "surface": "dirt"})
way(farm[3:5], {"highway": "unclassified", "name": "Estrada da Fazenda", "surface": "dirt", "ford": "yes"})
way(farm[4:], {"highway": "track", "tracktype": "grade3"})
# Private condo road
way([(LON0, LAT0), (LON0 - 0.003, LAT0 - 0.002)], {"highway": "service", "access": "private", "name": "Condomínio Particular"})

# Places & POIs (nodes)
pois = [
    (LON0 + 4.5 * DX, LAT0 + 4.5 * DY, {"place": "town", "name": "Vila Teste"}),
    (hw[-1][0], hw[-1][1], {"place": "village", "name": "Povoado Leste"}),
    (LON0 + 2 * DX, LAT0 + 7 * DY, {"amenity": "hospital", "name": "Hospital Municipal"}),
    (LON0 + 8 * DX, LAT0 + 4 * DY + 0.0002, {"amenity": "fuel", "name": "Posto Estrela"}),
    (LON0 + 6 * DX, LAT0 + 2 * DY, {"amenity": "pharmacy", "name": "Farmácia Central"}),
    (farm[-1][0] + 0.001, farm[-1][1], {"natural": "spring", "name": "Nascente do Alto"}),
    (LON0 + 1 * DX, LAT0 + 1 * DY, {"amenity": "police", "name": "Delegacia"}),
] + [
    # house numbers along "Rua 3"
    (LON0 + k * 0.0015 + 0.0003, LAT0 + 2 * DY + 0.0001, {"addr:street": "Rua 3", "addr:housenumber": str(num)})
    for k, num in enumerate((10, 50, 120, 200, 310))
]

# --- write OSM XML (locations stored on way nodes, like osmium add-locations-to-ways)
def esc(s):
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def write_osm(path, with_pois):
    with open(path, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="voli-test">\n')
        if with_pois:
            for k, (lon, lat, tags) in enumerate(pois):
                f.write(f'<node id="{900000 + k}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">')
                for kk, vv in tags.items():
                    f.write(f'<tag k="{kk}" v="{esc(vv)}"/>')
                f.write("</node>\n")
        else:
            for wid_, ids, tags in ways:
                f.write(f'<way id="{wid_}" version="1">')
                for i in ids:
                    lon, lat, _ = nodes[i]
                    f.write(f'<nd ref="{i}" lat="{lat:.7f}" lon="{lon:.7f}"/>')
                for kk, vv in tags.items():
                    f.write(f'<tag k="{kk}" v="{esc(vv)}"/>')
                f.write("</way>\n")
        f.write("</osm>\n")


def write_full(path):
    """Plain OSM XML (nodes + ways + POIs) used to test pipeline/build_state.sh end to end."""
    with open(path, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="voli-test">\n')
        for i in sorted(nodes):
            lon, lat, _ = nodes[i]
            f.write(f'<node id="{i}" version="1" timestamp="2026-11-15T00:00:00Z" lat="{lat:.7f}" lon="{lon:.7f}"/>\n')
        for k, (lon, lat, tags) in enumerate(pois):
            f.write(f'<node id="{900000 + k}" version="1" timestamp="2026-11-15T00:00:00Z" lat="{lat:.7f}" lon="{lon:.7f}">')
            f.write("".join(f'<tag k="{kk}" v="{esc(vv)}"/>' for kk, vv in tags.items()) + "</node>\n")
        for wid_, ids, tags in ways:
            f.write(f'<way id="{wid_}" version="1" timestamp="2026-11-15T00:00:00Z">' + "".join(f'<nd ref="{i}"/>' for i in ids))
            f.write("".join(f'<tag k="{kk}" v="{esc(vv)}"/>' for kk, vv in tags.items()) + "</way>\n")
        f.write("</osm>\n")


write_full("/tmp/synthetic.osm")
roads_xml = os.path.join(OUT, "roads.osm")
poi_xml = os.path.join(OUT, "poi.osm")
write_osm(roads_xml, False)
write_osm(poi_xml, True)
subprocess.check_call([sys.executable, os.path.join(HERE, "..", "pipeline", "build_index.py"), roads_xml, poi_xml, os.path.join(OUT, "sp")])
os.remove(roads_xml)
os.remove(poi_xml)

# --- vector tiles (OpenMapTiles-like layers)
CLASS = {"residential": "minor", "unclassified": "minor", "service": "service", "primary": "primary", "trunk": "trunk", "track": "track"}


def tile_xy(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    r = math.radians(lat)
    y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n
    return x, y


lake = [(LON0 - 0.006, LAT0 + 0.004), (LON0 - 0.002, LAT0 + 0.006), (LON0 - 0.0015, LAT0 + 0.011), (LON0 - 0.007, LAT0 + 0.012), (LON0 - 0.009, LAT0 + 0.008)]
forest = [(LON0 + 0.0, LAT0 + 0.016), (LON0 + 0.02, LAT0 + 0.016), (LON0 + 0.02, LAT0 + 0.03), (LON0, LAT0 + 0.03)]
buildings = []
for i in range(N - 1):
    for j in range(N - 1):
        if (i + j) % 3 == 0:
            x, y = LON0 + j * DX + 0.0004, LAT0 + i * DY + 0.0004
            buildings.append(([(x, y), (x + 0.0006, y), (x + 0.0006, y + 0.0005), (x, y + 0.0005)], 6 + ((i * 7 + j * 3) % 9) * 4))

features_by_layer = {"transportation": [], "transportation_name": [], "water": [], "landcover": [], "building": [], "place": []}
for _, ids, tags in ways:
    coords = [(nodes[i][0], nodes[i][1]) for i in ids]
    cls = CLASS.get(tags["highway"], "minor")
    surface = "unpaved" if tags.get("surface") in ("dirt",) or tags["highway"] == "track" else "paved"
    features_by_layer["transportation"].append(("LineString", coords, {"class": cls, "surface": surface}))
    if tags.get("name"):
        features_by_layer["transportation_name"].append(("LineString", coords, {"class": cls, "name": tags["name"], **({"ref": tags["ref"]} if tags.get("ref") else {})}))
features_by_layer["water"].append(("Polygon", lake, {"class": "lake"}))
features_by_layer["landcover"].append(("Polygon", forest, {"class": "wood"}))
for poly, h in buildings:
    features_by_layer["building"].append(("Polygon", poly, {"render_height": h, "render_min_height": 0}))
for lon, lat, tags in pois:
    if "place" in tags and "name" in tags:
        features_by_layer["place"].append(("Point", [(lon, lat)], {"class": tags["place"], "name": tags["name"]}))

W, S, E, Nn = LON0 - 0.05, LAT0 - 0.04, LON0 + 0.09, LAT0 + 0.06


def to_tile(coords, z, tx, ty, extent=4096):
    out = []
    for lon, lat in coords:
        x, y = tile_xy(lon, lat, z)
        out.append((round((x - tx) * extent), round((1 - (y - ty)) * extent)))  # mvt lib flips y by default
    return out


tiles = []
for z in range(6, 15):
    x0, y0 = tile_xy(W, Nn, z)
    x1, y1 = tile_xy(E, S, z)
    for tx in range(int(x0), int(x1) + 1):
        for ty in range(int(y0), int(y1) + 1):
            layers = []
            for lname, feats in features_by_layer.items():
                fl = []
                for geom, coords, props in feats:
                    if z < 12 and lname in ("building", "transportation_name") or z < 10 and props.get("class") in ("minor", "service", "track"):
                        continue
                    pts = to_tile(coords, z, tx, ty)
                    if geom == "Point":
                        wkt = f"POINT ({pts[0][0]} {pts[0][1]})"
                    elif geom == "LineString":
                        wkt = "LINESTRING (" + ", ".join(f"{a} {b}" for a, b in pts) + ")"
                    else:
                        ring = pts + [pts[0]]
                        wkt = "POLYGON ((" + ", ".join(f"{a} {b}" for a, b in ring) + "))"
                    fl.append({"geometry": wkt, "properties": props})
                if fl:
                    layers.append({"name": lname, "features": fl})
            if not layers:
                continue
            data = mapbox_vector_tile.encode(layers, default_options={"quantize_bounds": None, "extents": 4096, "y_coord_down": False})
            tiles.append((zxy_to_tileid(z, tx, ty), gzip.compress(data)))


def write_pmtiles(path, tiles, tile_type, compression, minz, maxz, meta):
    tiles.sort(key=lambda t: t[0])
    with open(path, "wb") as f:
        w = Writer(f)
        for tid, d in tiles:
            w.write_tile(tid, d)
        w.finalize({
            "tile_type": tile_type, "tile_compression": compression, "min_zoom": minz, "max_zoom": maxz,
            "min_lon_e7": int(W * 1e7), "min_lat_e7": int(S * 1e7), "max_lon_e7": int(E * 1e7), "max_lat_e7": int(Nn * 1e7),
            "center_zoom": 13, "center_lon_e7": int(LON0 * 1e7), "center_lat_e7": int(LAT0 * 1e7),
        }, meta)


write_pmtiles(os.path.join(OUT, "sp.pmtiles"), tiles, TileType.MVT, Compression.GZIP, 6, 14, {"name": "synthetic"})
print("vector tiles:", len(tiles))


# --- synthetic terrain: hills north of town
def elev(lon, lat):
    return 700 + 350 * np.exp(-(((lon - (LON0 + 0.01)) / 0.012) ** 2 + ((lat - (LAT0 + 0.03)) / 0.01) ** 2)) + 60 * np.sin(lon * 400) * np.cos(lat * 300)


ttiles = []
for z in range(5, 12):
    x0, y0 = tile_xy(W, Nn, z)
    x1, y1 = tile_xy(E, S, z)
    for tx in range(int(x0), int(x1) + 1):
        for ty in range(int(y0), int(y1) + 1):
            px = (np.arange(256) + 0.5) / 256
            lon = (tx + px) / 2 ** z * 360 - 180
            yy = (ty + px) / 2 ** z
            lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * yy))))
            LON, LAT = np.meshgrid(lon, lat)
            h = elev(LON, LAT)
            v = np.round((h + 10000) * 10).astype(np.uint32)
            rgb = np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255], -1).astype(np.uint8)
            b = io.BytesIO()
            Image.fromarray(rgb, "RGB").save(b, "WEBP", lossless=True)
            ttiles.append((zxy_to_tileid(z, tx, ty), b.getvalue()))
write_pmtiles(os.path.join(OUT, "sp-terrain.pmtiles"), ttiles, TileType.WEBP, Compression.NONE, 5, 11, {"encoding": "mapbox"})
print("terrain tiles:", len(ttiles))
