#!/usr/bin/env python3
"""Extract Overture Maps places (businesses and services) for every Brazilian state.

Overture places are published under CDLA Permissive 2.0 / Apache 2.0 (per source) and contain
no OpenStreetMap data. Attribution: "Overture Maps Foundation".

Usage:
  overture_places.py <source> <states.json> <out_dir> [states]
    source = an Overture release id (e.g. 2026-10-21.0), read from the public S3 bucket,
             or a local parquet file/glob (used by the tests)
    states = optional comma-separated UFs

Writes <out_dir>/<uf>.places.jsonl.gz with one JSON array per line:
  [name, lon, lat, category_key, basic_category, confidence]
category_key is one of Voli's essential categories (hospital, clinic, pharmacy, fuel, police,
fire, food, shelter) or "" for other businesses. Drinking water is never taken from Overture:
it only comes from OpenStreetMap, where it is mapped as an actual water point.
"""
import gzip
import json
import os
import sys
import time

import duckdb

S3 = "s3://overturemaps-us-west-2/release/{rel}/theme=places/type=place/*"
MARGIN = 0.15
MIN_CONFIDENCE = 0.6

# Overture taxonomy -> Voli essential categories. Matched against taxonomy.primary, the
# hierarchy path and basic_category (substring match, first rule wins).
RULES = [
    ("hospital", ("hospital", "emergency_room", "emergency_department")),
    ("fire", ("fire_station", "fire_department")),
    ("police", ("police",)),
    ("pharmacy", ("pharmacy", "drugstore", "drug_store")),
    ("fuel", ("gas_station", "fuel", "petrol")),
    ("clinic", ("urgent_care", "medical_center", "health_center", "clinic", "doctor", "health_post", "community_health")),
    ("food", ("supermarket", "grocery", "hypermarket", "convenience_store")),
    ("shelter", ("shelter", "mountain_hut", "campground", "campsite")),
]
NOT = ("veterinar", "animal", "pet_", "hospitality", "dental", "beauty", "spa", "repair", "car_wash", "station_wagon")


def category_key(*labels):
    text = " ".join(l for l in labels if l).lower()
    for key, words in RULES:
        if any(w in text for w in words) and not any(n in text for n in NOT):
            return key
    return ""


def open_db(remote):
    con = duckdb.connect()
    if remote:  # the S3 reader is only needed for the public Overture bucket
        con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    return con


def columns(con, src):
    return {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{src}', hive_partitioning=0) LIMIT 0").fetchall()}


def main():
    source, states_path, out_dir = sys.argv[1:4]
    want = [s.strip().lower() for s in (sys.argv[4] if len(sys.argv) > 4 else "").split(",") if s.strip()]
    states = json.load(open(states_path))["states"]
    if want:
        states = [s for s in states if s["uf"] in want]
    os.makedirs(out_dir, exist_ok=True)
    src = source if (source.endswith(".parquet") or "/" in source) else S3.format(rel=source)
    con = open_db(src.startswith("s3://"))
    cols = columns(con, src)
    if "taxonomy" in cols:  # schema since September 2026
        cat_sql = "taxonomy.primary AS primary_cat, array_to_string(taxonomy.hierarchy, '/') AS hierarchy"
    else:  # older releases
        cat_sql = "categories.primary AS primary_cat, array_to_string(categories.alternate, '/') AS hierarchy"
    basic_sql = "basic_category" if "basic_category" in cols else "NULL"
    status_sql = "operating_status" if "operating_status" in cols else "NULL"

    w = min(s["bbox"][0] for s in states) - MARGIN
    so = min(s["bbox"][1] for s in states) - MARGIN
    e = max(s["bbox"][2] for s in states) + MARGIN
    n = max(s["bbox"][3] for s in states) + MARGIN
    t0 = time.time()
    # One remote scan for the whole country, filtered by the bbox columns (cheap thanks to parquet statistics).
    con.execute(f"""
        CREATE TABLE p AS
        SELECT names.primary AS name, {cat_sql}, {basic_sql} AS basic, CAST(confidence AS DOUBLE) AS confidence,
               CAST((bbox.xmin + bbox.xmax) / 2 AS DOUBLE) AS lon, CAST((bbox.ymin + bbox.ymax) / 2 AS DOUBLE) AS lat
        FROM read_parquet('{src}', hive_partitioning=0)
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {so} AND {n}
          AND confidence >= {MIN_CONFIDENCE}
          AND names.primary IS NOT NULL
          AND coalesce({status_sql}, 'open') = 'open'
    """)
    total = con.execute("SELECT count(*) FROM p").fetchone()[0]
    print(f"Overture places in Brazil bbox: {total:,} ({time.time() - t0:.0f}s)", flush=True)

    hist = {}
    for st in states:
        bw, bs, be, bn = st["bbox"]
        rows = con.execute(
            "SELECT name, lon, lat, primary_cat, hierarchy, basic, confidence FROM p "
            "WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?",
            [bw - MARGIN, be + MARGIN, bs - MARGIN, bn + MARGIN]).fetchall()
        path = os.path.join(out_dir, f"{st['uf']}.places.jsonl.gz")
        with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as f:
            for name, lon, lat, prim, hier, basic, conf in rows:
                key = category_key(prim, hier, basic)
                hist[key] = hist.get(key, 0) + 1
                f.write(json.dumps([name.strip()[:80], round(lon, 5), round(lat, 5), key, basic or prim or "",
                                    round(conf or 0, 2)], ensure_ascii=False, separators=(",", ":")) + "\n")
        print(f"  {st['uf']}: {len(rows):,} places", flush=True)
    print("essential categories:", json.dumps(hist, sort_keys=True))


if __name__ == "__main__":
    main()
