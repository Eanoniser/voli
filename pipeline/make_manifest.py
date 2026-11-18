#!/usr/bin/env python3
"""Merge <uf>.release.json files into manifest.json (read by the app to list and update map packs).
Usage: make_manifest.py <dir-with-release-json> <out manifest.json>"""
import datetime
import glob
import json
import os
import sys

src, out = sys.argv[1], sys.argv[2]
states = {}
for path in sorted(glob.glob(os.path.join(src, "*.release.json"))):
    r = json.load(open(path))
    states[r["uf"]] = {"date": r["date"], "version": r.get("version", 1), "files": r["files"]}
manifest = {
    "version": 1,
    "generated": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
    "attribution": "© OpenStreetMap contributors (ODbL), © OpenMapTiles, Copernicus DEM GLO-90 © DLR e.V. / Airbus, ESA",
    "states": states,
}
json.dump(manifest, open(out, "w"), ensure_ascii=False, indent=1)
print(f"manifest with {len(states)} states")
