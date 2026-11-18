#!/usr/bin/env bash
# Build one state's map pack from an OSM extract.
# Usage: pipeline/build_state.sh <uf> <state.osm.pbf> <osm-date-iso> <out-dir>
# Needs: osmium-tool, java 21, planetiler.jar (PLANETILER env), python3 with numpy/osmium/pmtiles/pillow/gdal.
set -euo pipefail

UF="$1"
OSM="$2"
OSM_DATE="$3"
OUT="$(mkdir -p "$4" && cd "$4" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="$(mktemp -d)"
PLANETILER="${PLANETILER:-planetiler.jar}"
JAVA_MEM="${JAVA_MEM:-6g}"

read -r W S E N NAME < <(python3 - "$ROOT/web/data/states.json" "$UF" <<'EOF'
import json, sys
st = next(s for s in json.load(open(sys.argv[1]))["states"] if s["uf"] == sys.argv[2])
w, s, e, n = st["bbox"]
m = 0.15  # margin so border roads are complete in both neighbouring packs
print(w - m, s - m, e + m, n + m, st["name"].replace(" ", "_"))
EOF
)
echo "== $UF ($NAME) bbox $W,$S,$E,$N"

echo "== roads"
osmium tags-filter "$OSM" w/highway w/route=ferry -o "$WORK/roads-raw.pbf" --overwrite
osmium add-locations-to-ways "$WORK/roads-raw.pbf" -o "$WORK/roads.pbf" --overwrite
echo "== places and points of interest"
osmium tags-filter "$OSM" \
  nwr/place nwr/healthcare \
  nwr/amenity=drinking_water,water_point,hospital,clinic,doctors,pharmacy,fuel,police,fire_station,shelter \
  nwr/natural=spring nwr/man_made=water_tap,water_well \
  nwr/tourism=alpine_hut,wilderness_hut nwr/shop=supermarket \
  -o "$WORK/poi-raw.pbf" --overwrite
osmium add-locations-to-ways "$WORK/poi-raw.pbf" -o "$WORK/poi.pbf" --overwrite

echo "== routing graph + search index"
python3 "$HERE/build_index.py" "$WORK/roads.pbf" "$WORK/poi.pbf" "$OUT/$UF"

echo "== vector tiles (Planetiler, OpenMapTiles schema)"
java -Xmx"$JAVA_MEM" -jar "$PLANETILER" \
  --osm-path="$OSM" --output="$OUT/$UF.pmtiles" --force \
  ${PLANETILER_DOWNLOAD:---download} --download-dir="${PLANETILER_SOURCES:-data/sources}" \
  --bounds="$W,$S,$E,$N" --languages=pt,en \
  --exclude_layers=housenumber,poi,aerodrome_label \
  --nodemap-type=sparsearray --storage=mmap --tmpdir="$WORK/tmp"

echo "== terrain (Copernicus DEM GLO-90)"
(cd "$WORK" && python3 "$HERE/terrain.py" "$W" "$S" "$E" "$N" "$OUT/$UF-terrain.pmtiles" 11)

echo "== release metadata"
python3 - "$UF" "$OSM_DATE" "$OUT" <<'EOF'
import json, os, sys
uf, date, out = sys.argv[1:4]
names = [f"{uf}.pmtiles", f"{uf}-terrain.pmtiles", f"{uf}.route.gz", f"{uf}.search.json.gz"]
files = [{"name": n, "size": os.path.getsize(os.path.join(out, n))} for n in names]
json.dump({"uf": uf, "date": date, "version": 1, "files": files}, open(os.path.join(out, f"{uf}.release.json"), "w"))
print(json.dumps(files))
EOF
rm -rf "$WORK"
