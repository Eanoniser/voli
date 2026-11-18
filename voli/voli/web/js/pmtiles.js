// Minimal PMTiles v3 reader (spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
// Written for Voli so the app ships with no extra third-party code.
// Reads byte ranges over HTTP (the Android shell serves local files with Range support).

const HEADER_BYTES = 16384;

function readVarint(view, state) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = view[state.pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (b < 0x80) return result;
    shift += 7;
  }
}

function u64(dv, off) {
  return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 4294967296;
}

function rotate(n, xy, rx, ry) {
  if (ry === 0) {
    if (rx === 1) {
      xy[0] = n - 1 - xy[0];
      xy[1] = n - 1 - xy[1];
    }
    const t = xy[0];
    xy[0] = xy[1];
    xy[1] = t;
  }
}

export function zxyToTileId(z, x, y) {
  const n = Math.pow(2, z);
  let acc = (n * n - 1) / 3;
  const xy = [x, y];
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0;
    const ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(n, xy, rx, ry);
  }
  return acc + d;
}

async function decompress(buf, compression) {
  if (compression === 0 || compression === 1) return buf; // unknown / none
  if (compression === 2) {
    const ds = new DecompressionStream("gzip");
    const stream = new Response(buf).body.pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error("Unsupported PMTiles compression: " + compression);
}

function parseDirectory(bytes) {
  const state = { pos: 0 };
  const n = readVarint(bytes, state);
  const entries = new Array(n);
  let lastId = 0;
  for (let i = 0; i < n; i++) {
    lastId += readVarint(bytes, state);
    entries[i] = { tileId: lastId, offset: 0, length: 0, runLength: 1 };
  }
  for (let i = 0; i < n; i++) entries[i].runLength = readVarint(bytes, state);
  for (let i = 0; i < n; i++) entries[i].length = readVarint(bytes, state);
  for (let i = 0; i < n; i++) {
    const v = readVarint(bytes, state);
    if (v === 0 && i > 0) entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    else entries[i].offset = v - 1;
  }
  return entries;
}

function findEntry(entries, tileId) {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = entries[mid].tileId;
    if (c < tileId) lo = mid + 1;
    else if (c > tileId) hi = mid - 1;
    else return entries[mid];
  }
  if (hi >= 0) {
    const e = entries[hi];
    if (e.runLength === 0) return e; // leaf directory pointer
    if (tileId - e.tileId < e.runLength) return e;
  }
  return null;
}

export class PMTiles {
  constructor(url) {
    this.url = url;
    this.dirCache = new Map();
    this.headerPromise = null;
  }

  async range(offset, length) {
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${this.url}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // Servers that ignore Range return the whole file.
    if (res.status === 200 && buf.length > length) return buf.subarray(offset, offset + length);
    return buf;
  }

  getHeader() {
    if (!this.headerPromise) {
      this.headerPromise = (async () => {
        const buf = await this.range(0, HEADER_BYTES);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const magic = String.fromCharCode(...buf.subarray(0, 7));
        if (magic !== "PMTiles" || buf[7] !== 3) throw new Error("Not a PMTiles v3 file: " + this.url);
        const h = {
          rootOffset: u64(dv, 8),
          rootLength: u64(dv, 16),
          metadataOffset: u64(dv, 24),
          metadataLength: u64(dv, 32),
          leafOffset: u64(dv, 40),
          leafLength: u64(dv, 48),
          dataOffset: u64(dv, 56),
          dataLength: u64(dv, 64),
          internalCompression: buf[97],
          tileCompression: buf[98],
          tileType: buf[99],
          minZoom: buf[100],
          maxZoom: buf[101],
          bounds: [
            dv.getInt32(102, true) / 1e7,
            dv.getInt32(106, true) / 1e7,
            dv.getInt32(110, true) / 1e7,
            dv.getInt32(114, true) / 1e7,
          ],
        };
        let rootBytes;
        if (h.rootOffset + h.rootLength <= buf.length) {
          rootBytes = buf.slice(h.rootOffset, h.rootOffset + h.rootLength);
        } else {
          rootBytes = await this.range(h.rootOffset, h.rootLength);
        }
        h.root = parseDirectory(await decompress(rootBytes, h.internalCompression));
        return h;
      })();
      this.headerPromise.catch(() => (this.headerPromise = null));
    }
    return this.headerPromise;
  }

  async getLeaf(h, offset, length) {
    const key = offset;
    let p = this.dirCache.get(key);
    if (!p) {
      p = (async () =>
        parseDirectory(await decompress(await this.range(h.leafOffset + offset, length), h.internalCompression)))();
      this.dirCache.set(key, p);
      p.catch(() => this.dirCache.delete(key));
      if (this.dirCache.size > 64) this.dirCache.delete(this.dirCache.keys().next().value);
    }
    return p;
  }

  /** Returns tile bytes (already decompressed) or null if the tile is absent. */
  async getTile(z, x, y) {
    const h = await this.getHeader();
    if (z < h.minZoom || z > h.maxZoom) return null;
    const tileId = zxyToTileId(z, x, y);
    let entries = h.root;
    for (let depth = 0; depth < 4; depth++) {
      const e = findEntry(entries, tileId);
      if (!e) return null;
      if (e.runLength > 0) {
        const data = await this.range(h.dataOffset + e.offset, e.length);
        return decompress(data, h.tileCompression);
      }
      entries = await this.getLeaf(h, e.offset, e.length);
    }
    return null;
  }

  async getMetadata() {
    const h = await this.getHeader();
    if (!h.metadataLength) return {};
    const bytes = await decompress(await this.range(h.metadataOffset, h.metadataLength), h.internalCompression);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
}
