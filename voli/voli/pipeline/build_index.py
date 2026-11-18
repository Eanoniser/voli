#!/usr/bin/env python3
"""Build the offline routing graph and search index for one state.

Inputs are produced by build_state.sh with osmium-tool:
  roads.pbf  - highway / ferry ways with node locations stored on the ways (add-locations-to-ways)
  poi.pbf    - places and points of interest, ways also with locations

Outputs:
  <out>.route.gz        binary graph read by web/js/router-worker.js (format "VLRT" v1)
  <out>.search.json.gz  places, streets and POIs for offline search

Usage: build_index.py roads.pbf poi.pbf out_prefix
"""
import gzip
import json
import math
import os
import re
import struct
import sys
from array import array

import numpy as np
import osmium

# ----------------------------------------------------------------------------- routing profile
SPEED = {  # average km/h used for travel time (Brazil)
    "motorway": 95, "motorway_link": 50, "trunk": 85, "trunk_link": 45, "primary": 65, "primary_link": 40,
    "secondary": 55, "secondary_link": 35, "tertiary": 45, "tertiary_link": 30, "unclassified": 35,
    "residential": 28, "living_street": 10, "service": 15, "road": 20, "track": 15,
}
UNPAVED = {"unpaved", "dirt", "gravel", "ground", "sand", "earth", "grass", "mud", "compacted", "fine_gravel",
           "pebblestone", "woodchips", "dirt/sand", "clay", "rock", "stone", "salt", "ice", "snow"}
PAVED = {"paved", "asphalt", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "sett",
         "cobblestone", "unhewn_cobblestone", "chipseal", "metal", "wood", "bricks"}
F_UNPAVED, F_TRACK, F_FERRY, F_FORD, F_TOLL, F_PRIVATE, F_ROUNDABOUT, F_UNKNOWN = 1, 2, 4, 8, 16, 32, 64, 128
NO_ACCESS = {"no", "private"}
YES_ACCESS = {"yes", "designated", "destination", "permissive", "customers", "delivery"}
SKIP_SERVICE = {"parking_aisle", "driveway", "drive-through"}

PLACE_KINDS = {"city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter", "locality", "isolated_dwelling"}


def poi_category(tags):
    a = tags.get("amenity")
    if a == "drinking_water" or tags.get("drinking_water") == "yes" and a in (None, "water_point", "fountain"):
        return "water"
    if tags.get("natural") == "spring" or tags.get("man_made") in ("water_tap", "water_well"):
        return None if tags.get("drinking_water") == "no" else "water"
    if a == "water_point":
        return "water"
    if a == "hospital" or tags.get("healthcare") == "hospital":
        return "hospital"
    if a in ("clinic", "doctors") or tags.get("healthcare") in ("clinic", "centre"):
        return "clinic"
    if a == "pharmacy":
        return "pharmacy"
    if a == "fuel":
        return "fuel"
    if a == "police":
        return "police"
    if a == "fire_station":
        return "fire"
    if a == "shelter" or tags.get("tourism") in ("alpine_hut", "wilderness_hut"):
        return "shelter"
    if tags.get("shop") == "supermarket":
        return "food"
    return None


def parse_speed(v):
    if not v:
        return None
    m = re.match(r"^\s*(\d+)", v)
    if not m:
        return None
    s = int(m.group(1))
    if "mph" in v:
        s = int(s * 1.609)
    return s if 5 <= s <= 150 else None


class RoadHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ids = array("q")
        self.lat = array("i")
        self.lon = array("i")
        self.way_start = array("I")
        self.way_len = array("I")
        self.way_speed = array("B")
        self.way_flags = array("B")
        self.way_oneway = array("b")
        self.way_name = array("I")
        self.names = {"": 0}
        self.name_list = [""]

    def name_id(self, n):
        i = self.names.get(n)
        if i is None:
            i = self.names[n] = len(self.name_list)
            self.name_list.append(n)
        return i

    def way(self, w):
        t = w.tags
        hw = t.get("highway")
        ferry = t.get("route") == "ferry"
        if ferry:
            if t.get("motor_vehicle") == "no" or t.get("motorcar") == "no":
                return
        elif hw not in SPEED:
            return
        if hw == "service" and t.get("service") in SKIP_SERVICE:
            return
        if t.get("area") == "yes":
            return
        access = t.get("motor_vehicle") or t.get("motorcar") or t.get("vehicle") or t.get("access")
        if access == "no" and not (t.get("motorcar") in YES_ACCESS or t.get("motor_vehicle") in YES_ACCESS):
            return
        flags = 0
        if access in NO_ACCESS:
            flags |= F_PRIVATE
        surface = t.get("surface")
        tt = t.get("tracktype")
        if hw == "track":
            flags |= F_TRACK
        if surface in UNPAVED or (tt and tt != "grade1"):
            flags |= F_UNPAVED
        elif surface is None and hw in ("unclassified", "tertiary", "road", "secondary", "service") and not ferry:
            flags |= F_UNKNOWN
        if ferry:
            flags |= F_FERRY
        if t.get("ford") in ("yes", "stepping_stones"):
            flags |= F_FORD
        if t.get("toll") == "yes":
            flags |= F_TOLL
        if t.get("junction") in ("roundabout", "circular"):
            flags |= F_ROUNDABOUT
        ow = t.get("oneway")
        if ow in ("yes", "1", "true"):
            oneway = 1
        elif ow == "-1":
            oneway = -1
        elif ow == "no":
            oneway = 0
        elif hw in ("motorway",) or t.get("junction") in ("roundabout", "circular"):
            oneway = 1
        else:
            oneway = 0
        if ferry:
            speed = 10
        else:
            speed = SPEED[hw]
            ms = parse_speed(t.get("maxspeed"))
            if ms:
                speed = min(int(ms * 0.85), max(speed, int(ms * 0.85)))
        name = t.get("name") or t.get("ref") or ""
        start = len(self.ids)
        n = 0
        try:
            for nd in w.nodes:
                loc = nd.location
                if not loc.valid():
                    continue
                self.ids.append(nd.ref)
                self.lat.append(int(round(loc.lat * 1e6)))
                self.lon.append(int(round(loc.lon * 1e6)))
                n += 1
        except osmium.InvalidLocationError:
            pass
        if n < 2:
            del self.ids[start:], self.lat[start:], self.lon[start:]
            return
        self.way_start.append(start)
        self.way_len.append(n)
        self.way_speed.append(max(5, min(130, speed)))
        self.way_flags.append(flags)
        self.way_oneway.append(oneway)
        self.way_name.append(self.name_id(name))


class PoiHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.places = []
        self.pois = []
        self.addresses = []  # [street, housenumber, lon, lat]

    def _add(self, tags, lon, lat):
        number = tags.get("addr:housenumber")
        street = tags.get("addr:street") or tags.get("addr:place")
        if number and street and len(number) <= 12:
            for num in number.replace(";", ",").split(",")[:4]:
                num = num.strip()
                if num:
                    self.addresses.append([street.strip(), num, round(lon, 6), round(lat, 6)])
        place = tags.get("place")
        name = tags.get("name:pt") or tags.get("name") or ""
        if place in PLACE_KINDS and name:
            self.places.append([name, "suburb" if place == "quarter" else place, round(lon, 5), round(lat, 5)])
        cat = poi_category(tags)
        if cat:
            self.pois.append([cat, round(lon, 5), round(lat, 5), name])

    def node(self, n):
        if n.location.valid():
            self._add(n.tags, n.location.lon, n.location.lat)

    def way(self, w):
        if not (w.tags.get("place") in PLACE_KINDS or poi_category(w.tags) or "addr:housenumber" in w.tags):
            return
        xs, ys = [], []
        try:
            for nd in w.nodes:
                if nd.location.valid():
                    xs.append(nd.location.lon)
                    ys.append(nd.location.lat)
        except osmium.InvalidLocationError:
            return
        if xs:
            self._add(w.tags, sum(xs) / len(xs), sum(ys) / len(ys))


def haversine(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.minimum(1, np.sqrt(a)))


def ranges(begin, length, offsets):
    """Concatenate arange(begin[i], begin[i] + length[i]) for all i, vectorised."""
    total = int(offsets[-1])
    if total == 0:
        return np.zeros(0, dtype=np.int64)
    return np.repeat(begin - offsets[:-1], length) + np.arange(total, dtype=np.int64)


def build_graph(h):
    ids = np.frombuffer(h.ids, dtype=np.int64)
    lat = np.frombuffer(h.lat, dtype=np.int32)
    lon = np.frombuffer(h.lon, dtype=np.int32)
    ws = np.frombuffer(h.way_start, dtype=np.uint32).astype(np.int64)
    wl = np.frombuffer(h.way_len, dtype=np.uint32).astype(np.int64)
    print(f"  ways={len(ws):,} way-nodes={len(ids):,}", flush=True)

    uniq, inv, counts = np.unique(ids, return_inverse=True, return_counts=True)
    is_vertex = counts >= 2
    is_vertex[inv[ws]] = True
    is_vertex[inv[ws + wl - 1]] = True
    vertex_id = np.full(len(uniq), -1, dtype=np.int64)
    vertex_id[is_vertex] = np.arange(int(is_vertex.sum()))
    V = int(is_vertex.sum())
    vlat = np.zeros(V, dtype=np.int32)
    vlon = np.zeros(V, dtype=np.int32)
    vid_per_node = vertex_id[inv]
    mask = vid_per_node >= 0
    vlat[vid_per_node[mask]] = lat[mask]
    vlon[vid_per_node[mask]] = lon[mask]

    # Split ways into segments between vertices.
    seg_a, seg_b, seg_gs, seg_gl, seg_way = [], [], [], [], []
    vp = vid_per_node
    for w in range(len(ws)):
        s0, n = int(ws[w]), int(wl[w])
        start = s0
        for i in range(s0 + 1, s0 + n):
            if vp[i] >= 0:
                if vp[start] != vp[i] or i - start > 1:
                    seg_a.append(vp[start]); seg_b.append(vp[i]); seg_gs.append(start); seg_gl.append(i - start + 1); seg_way.append(w)
                start = i
    S = len(seg_a)
    seg_a = np.array(seg_a, dtype=np.int64); seg_b = np.array(seg_b, dtype=np.int64)
    seg_gs = np.array(seg_gs, dtype=np.int64); seg_gl = np.array(seg_gl, dtype=np.int64)
    seg_way = np.array(seg_way, dtype=np.int64)
    print(f"  vertices={V:,} segments={S:,}", flush=True)

    # Segment lengths
    starts = np.zeros(S + 1, dtype=np.int64)
    starts[1:] = np.cumsum(seg_gl)
    flat = ranges(seg_gs, seg_gl, starts)
    flat_lat = lat[flat] / 1e6
    flat_lon = lon[flat] / 1e6
    d = haversine(flat_lat[:-1], flat_lon[:-1], flat_lat[1:], flat_lon[1:]) if S else np.zeros(0)
    d = np.concatenate([[0.0], d])
    csum = np.cumsum(d)
    seg_len = (csum[starts[1:] - 1] - csum[starts[:-1]]).astype(np.float32)

    oneway = np.frombuffer(h.way_oneway, dtype=np.int8)[seg_way]
    fwd = oneway >= 0
    bwd = oneway <= 0

    # Keep only the largest connected component (undirected) so every snapped point can be routed.
    parent = np.arange(V, dtype=np.int64)

    def find(x):
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    for a, b in zip(seg_a.tolist(), seg_b.tolist()):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    roots = np.array([find(v) for v in range(V)], dtype=np.int64)
    main = np.bincount(roots).argmax()
    keep_v = roots == main
    keep_s = keep_v[seg_a]
    print(f"  main component keeps {keep_v.sum():,}/{V:,} vertices", flush=True)

    new_v = np.full(V, -1, dtype=np.int64)
    new_v[keep_v] = np.arange(int(keep_v.sum()))
    vlat, vlon = vlat[keep_v], vlon[keep_v]
    V = len(vlat)
    seg_idx = np.nonzero(keep_s)[0]
    seg_a, seg_b = new_v[seg_a[seg_idx]], new_v[seg_b[seg_idx]]
    seg_len = seg_len[seg_idx]
    fwd, bwd = fwd[seg_idx], bwd[seg_idx]
    seg_way = seg_way[seg_idx]
    gs, gl = seg_gs[seg_idx], seg_gl[seg_idx]
    S = len(seg_idx)
    seg_geom = np.zeros(S + 1, dtype=np.int64)
    seg_geom[1:] = np.cumsum(gl)
    geom_idx = ranges(gs, gl, seg_geom)
    seg_geom = seg_geom.astype(np.uint32)
    g_lat, g_lon = lat[geom_idx], lon[geom_idx]

    # Directed edges -> CSR
    sid = np.arange(S, dtype=np.int64)
    src = np.concatenate([seg_a[fwd], seg_b[bwd]])
    dst = np.concatenate([seg_b[fwd], seg_a[bwd]])
    eseg = np.concatenate([sid[fwd], sid[bwd] | 0x80000000])
    order = np.argsort(src, kind="stable")
    src, dst, eseg = src[order], dst[order], eseg[order]
    first = np.zeros(V + 1, dtype=np.uint32)
    first[1:] = np.cumsum(np.bincount(src, minlength=V))
    E = len(src)
    print(f"  final V={V:,} E={E:,} S={S:,} geometry points={len(g_lat):,}", flush=True)
    return {
        "V": V, "E": E, "S": S, "G": len(g_lat), "names": h.name_list,
        "lat": vlat.astype(np.int32), "lon": vlon.astype(np.int32), "first": first,
        "to": dst.astype(np.uint32), "seg": eseg.astype(np.uint32), "segLen": seg_len.astype(np.float32),
        "segGeom": seg_geom, "gLat": g_lat.astype(np.int32), "gLon": g_lon.astype(np.int32),
        "segName": np.frombuffer(h.way_name, dtype=np.uint32)[seg_way].astype(np.uint32),
        "segSpeed": np.frombuffer(h.way_speed, dtype=np.uint8)[seg_way].astype(np.uint8),
        "segFlags": np.frombuffer(h.way_flags, dtype=np.uint8)[seg_way].astype(np.uint8),
        "segA": seg_a, "segB": seg_b,
    }


def write_graph(g, path):
    names = json.dumps(g["names"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out = bytearray()
    out += b"VLRT" + struct.pack("<IIIIII", 1, g["V"], g["E"], g["S"], g["G"], len(names))
    out += names

    def pad():
        while len(out) % 4:
            out.append(0)

    pad()
    for key in ("lat", "lon", "first", "to", "seg", "segLen", "segGeom", "gLat", "gLon", "segName", "segSpeed", "segFlags"):
        out += np.ascontiguousarray(g[key]).astype(g[key].dtype.newbyteorder("<")).tobytes()
        pad()
    with gzip.open(path, "wb", compresslevel=6) as f:
        f.write(bytes(out))


def build_search(g, places, pois, path, biz=(), addresses=()):
    # Streets: one entry per (name, ~2 km cell), labelled with the nearest town.
    towns = [p for p in places if p[1] in ("city", "town", "village", "suburb", "hamlet")]
    cities = sorted({p[0] for p in towns})
    city_idx = {c: i for i, c in enumerate(cities)}
    grid = {}
    for name, kind, lon, lat in towns:
        grid.setdefault((int(lon // 0.2), int(lat // 0.2)), []).append((lon, lat, name, kind))

    def nearest_town(lon, lat):
        cx, cy = int(lon // 0.2), int(lat // 0.2)
        best, bd = None, 1e18
        # Prefer municipalities over suburbs when equally close.
        for r in range(0, 4):
            for x in range(cx - r, cx + r + 1):
                for y in range(cy - r, cy + r + 1):
                    for tlon, tlat, tname, kind in grid.get((x, y), ()):
                        d = (tlon - lon) ** 2 * math.cos(math.radians(lat)) ** 2 + (tlat - lat) ** 2
                        if kind == "suburb":
                            d *= 1.5
                        if d < bd:
                            bd, best = d, tname
            if best is not None:
                break
        return city_idx.get(best, -1) if best else -1

    streets = {}
    seg_name = g["segName"]
    sg = g["segGeom"]
    for s in range(g["S"]):
        nm = g["names"][seg_name[s]]
        if not nm:
            continue
        mid = (int(sg[s]) + int(sg[s + 1])) // 2
        lon, lat = g["gLon"][mid] / 1e6, g["gLat"][mid] / 1e6
        key = (nm, round(lon / 0.02), round(lat / 0.02))
        if key not in streets:
            streets[key] = [nm, round(lon, 5), round(lat, 5)]
    street_rows = []
    for nm, lon, lat in streets.values():
        street_rows.append([nm, lon, lat, nearest_town(lon, lat)])
    # Businesses are stored column by column (one joined string of names + integer arrays):
    # far smaller to parse and to keep in a phone's memory than one object per place.
    labels, label_idx = [], {}
    bn, bx, by, bl, bt = [], [], [], [], []
    for name, lon, lat, label in sorted(biz, key=lambda r: (round(r[2], 1), round(r[1], 1))):
        if label not in label_idx:
            label_idx[label] = len(labels)
            labels.append(label)
        bn.append(name.replace("\n", " "))
        bx.append(round(lon * 1e5))
        by.append(round(lat * 1e5))
        bl.append(label_idx[label])
        bt.append(nearest_town(lon, lat))
    biz_cols = {"n": "\n".join(bn), "x": bx, "y": by, "c": bl, "l": labels, "t": bt}
    # House numbers (OpenStreetMap addr:*), column by column, sorted by street then number.
    streets_list, street_idx = [], {}
    ai, an, ax, ay, at = [], [], [], [], []
    seen_addr = set()
    for street, num, lon, lat in sorted(addresses, key=lambda r: (r[0], r[1])):
        key = (street, num, round(lon, 4), round(lat, 4))
        if key in seen_addr:
            continue
        seen_addr.add(key)
        if street not in street_idx:
            street_idx[street] = len(streets_list)
            streets_list.append(street)
        ai.append(street_idx[street])
        an.append(num.replace("\n", " "))
        ax.append(round(lon * 1e5))
        ay.append(round(lat * 1e5))
        at.append(nearest_town(lon, lat))
    addr_cols = {"s": streets_list, "i": ai, "n": "\n".join(an), "x": ax, "y": ay, "t": at}
    biz_rows = bn
    data = {"version": 4, "cities": cities, "places": places, "streets": street_rows, "pois": pois, "biz": biz_cols,
            "addr": addr_cols}
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  search: places={len(places):,} streets={len(street_rows):,} pois={len(pois):,} businesses={len(biz_rows):,} addresses={len(ai):,}", flush=True)


def _words(name):
    import unicodedata
    t = unicodedata.normalize("NFD", name or "").encode("ascii", "ignore").decode().lower()
    return {w for w in re.findall(r"[a-z0-9]+", t) if len(w) >= 4}


def load_overture(path, osm_pois):
    """Overture places: essential ones join the POI layer unless they duplicate an OSM POI
    (same category, closer than 25 m, or closer than 80 m with a shared name word);
    every named place joins the search index."""
    if not path or not os.path.isfile(path):
        return [], []
    cell = 0.001  # ~110 m
    grid = {}
    for cat, lon, lat, name in osm_pois:
        grid.setdefault((cat, int(lon / cell), int(lat / cell)), []).append((lon, lat, _words(name)))

    def duplicate(key, lon, lat, name):
        cx, cy = int(lon / cell), int(lat / cell)
        words = _words(name)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for olon, olat, owords in grid.get((key, cx + dx, cy + dy), ()):
                    d = haversine(lat, lon, olat, olon)
                    if d < 25 or (d < 80 and words & owords):
                        return True
        return False

    extra_pois, biz = [], []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            name, lon, lat, key, basic, _conf = json.loads(line)
            biz.append([name, lon, lat, basic])
            if key and not duplicate(key, lon, lat, name):
                grid.setdefault((key, int(lon / cell), int(lat / cell)), []).append((lon, lat, _words(name)))
                extra_pois.append([key, lon, lat, name])
    return extra_pois, biz


def main():
    roads, poi, out = sys.argv[1], sys.argv[2], sys.argv[3]
    overture = sys.argv[4] if len(sys.argv) > 4 else None
    print("Reading roads…", flush=True)
    rh = RoadHandler()
    rh.apply_file(roads, locations=False)
    g = build_graph(rh)
    write_graph(g, out + ".route.gz")
    print("Reading places and POIs…", flush=True)
    ph = PoiHandler()
    ph.apply_file(poi, locations=False)
    extra_pois, biz = load_overture(overture, ph.pois)
    if overture:
        print(f"  overture: {len(biz):,} places, {len(extra_pois):,} added to the essentials layer", flush=True)
    build_search(g, ph.places, ph.pois + extra_pois, out + ".search.json.gz", biz, ph.addresses)


if __name__ == "__main__":
    main()
