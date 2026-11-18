#!/usr/bin/env python3
"""Build terrain tiles (Mapbox Terrain-RGB, lossless WebP) for a bounding box from Copernicus DEM GLO-90.

Copernicus DEM GLO-90 is free to use, including commercially, with attribution:
  "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS
   by the European Union and ESA; all rights reserved"
Source: AWS Open Data bucket copernicus-dem-90m (no account needed).

Usage: terrain.py west south east north out.pmtiles [maxzoom=11]
"""
import io
import math
import os
import sys

import numpy as np
from osgeo import gdal
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

gdal.UseExceptions()
gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
gdal.SetConfigOption("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")

BUCKET = "https://copernicus-dem-90m.s3.amazonaws.com"
ORIGIN = 20037508.342789244
TILE = 256


def cop_name(lat, lon):
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    base = f"Copernicus_DSM_COG_30_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"
    if os.environ.get("DEM_DIR"):  # local copy (used by tests)
        return os.path.join(os.environ["DEM_DIR"], base + ".tif")
    return f"/vsicurl/{BUCKET}/{base}/{base}.tif"


def mercator(lon, lat):
    x = lon * ORIGIN / 180
    y = math.log(math.tan((90 + lat) * math.pi / 360)) * ORIGIN / math.pi
    return x, y


def tile_range(z, w, s, e, n):
    def tx(lon):
        return int((lon + 180) / 360 * 2 ** z)

    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)

    return tx(w), ty(n), min(tx(e), 2 ** z - 1), min(ty(s), 2 ** z - 1)


def encode(h):
    v = np.clip(np.round((h + 10000.0) * 10.0), 0, 16777215).astype(np.uint32)
    rgb = np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255], axis=-1).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "WEBP", lossless=True, quality=100, method=4)
    return buf.getvalue()


def main():
    w, s, e, n = map(float, sys.argv[1:5])
    out = sys.argv[5]
    maxzoom = int(sys.argv[6]) if len(sys.argv) > 6 else 11
    minzoom = 5

    sources = []
    for lat in range(math.floor(s) - 1, math.ceil(n) + 1):
        for lon in range(math.floor(w) - 1, math.ceil(e) + 1):
            path = cop_name(lat, lon)
            try:
                ds = gdal.Open(path)
                if ds is not None:
                    sources.append(path)
                    ds = None
            except RuntimeError:
                pass  # ocean tiles do not exist
    print(f"  DEM source tiles: {len(sources)}", flush=True)
    if not sources:
        raise SystemExit("no DEM data found")
    vrt = gdal.BuildVRT("/vsimem/dem.vrt", sources)
    vrt = None

    # Warp once to Web Mercator at the max zoom resolution.
    res = 2 * ORIGIN / (TILE * 2 ** maxzoom)
    x0, y0, x1, y1 = tile_range(maxzoom, w, s, e, n)
    minx = -ORIGIN + x0 * TILE * res
    maxx = -ORIGIN + (x1 + 1) * TILE * res
    maxy = ORIGIN - y0 * TILE * res
    miny = ORIGIN - (y1 + 1) * TILE * res
    print("  warping…", flush=True)
    gdal.Warp(
        "dem3857.tif", "/vsimem/dem.vrt", dstSRS="EPSG:3857", outputBounds=(minx, miny, maxx, maxy),
        xRes=res, yRes=res, resampleAlg="bilinear", dstNodata=-32768, outputType=gdal.GDT_Float32,
        creationOptions=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=3", "BIGTIFF=IF_SAFER"], multithread=True,
        warpMemoryLimit=1024,
    )
    ds = gdal.Open("dem3857.tif", gdal.GA_Update)
    ds.BuildOverviews("AVERAGE", [2, 4, 8, 16, 32, 64])
    band = ds.GetRasterBand(1)
    W, H = ds.RasterXSize, ds.RasterYSize

    tiles = []
    for z in range(minzoom, maxzoom + 1):
        tx0, ty0, tx1, ty1 = tile_range(z, w, s, e, n)
        scale = 2 ** (maxzoom - z)  # source pixels per output pixel
        count = 0
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                px = tx * TILE * scale - x0 * TILE
                py = ty * TILE * scale - y0 * TILE
                size = TILE * scale
                # Clip the read window to the raster; pad the rest with sea level.
                rx0, ry0 = max(0, px), max(0, py)
                rx1, ry1 = min(W, px + size), min(H, py + size)
                h = np.zeros((TILE, TILE), dtype=np.float32)
                if rx1 > rx0 and ry1 > ry0:
                    bw = max(1, round((rx1 - rx0) / scale))
                    bh = max(1, round((ry1 - ry0) / scale))
                    arr = band.ReadAsArray(rx0, ry0, rx1 - rx0, ry1 - ry0, buf_xsize=bw, buf_ysize=bh,
                                           resample_alg=gdal.GRIORA_Average)
                    arr = np.where(arr <= -1000, 0, arr)
                    ox, oy = round((rx0 - px) / scale), round((ry0 - py) / scale)
                    h[oy:oy + bh, ox:ox + bw] = arr[: TILE - oy, : TILE - ox]
                if not np.any(h):
                    continue  # flat sea: the app substitutes a flat tile
                tiles.append((zxy_to_tileid(z, tx, ty), encode(h)))
                count += 1
        print(f"  z{z}: {count} tiles", flush=True)

    tiles.sort(key=lambda t: t[0])
    with open(out, "wb") as f:
        writer = Writer(f)
        for tid, data in tiles:
            writer.write_tile(tid, data)
        cx, cy = (w + e) / 2, (s + n) / 2
        writer.finalize(
            {
                "tile_type": TileType.WEBP, "tile_compression": Compression.NONE,
                "min_zoom": minzoom, "max_zoom": maxzoom,
                "min_lon_e7": int(w * 1e7), "min_lat_e7": int(s * 1e7), "max_lon_e7": int(e * 1e7), "max_lat_e7": int(n * 1e7),
                "center_zoom": 8, "center_lon_e7": int(cx * 1e7), "center_lat_e7": int(cy * 1e7),
            },
            {
                "name": "Voli terrain", "encoding": "mapbox",
                "attribution": "Copernicus DEM GLO-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA",
            },
        )
    print(f"  wrote {len(tiles)} tiles to {out}", flush=True)


if __name__ == "__main__":
    main()
