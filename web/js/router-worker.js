// Offline router (Web Worker). Loads one or more state graphs produced by
// pipeline/route_graph.py, merges them where they overlap and answers route queries
// with time-based A*. No network access.

const REV = 0x80000000;
const F = { UNPAVED: 1, TRACK: 2, FERRY: 4, FORD: 8, TOLL: 16, PRIVATE: 32, ROUNDABOUT: 64, UNKNOWN_SURFACE: 128 };
const MAX_SPEED_MPS = 120 / 3.6;

let G = null; // merged graph

// ---------- loading ----------

function parseGraph(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "VLRT") throw new Error("Arquivo de rotas inválido");
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error("Versão de rotas não suportada: " + version);
  const V = dv.getUint32(8, true), E = dv.getUint32(12, true), S = dv.getUint32(16, true);
  const Gc = dv.getUint32(20, true), namesLen = dv.getUint32(24, true);
  let off = 28;
  const names = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off, namesLen)));
  off += namesLen;
  off = (off + 3) & ~3;
  const take = (Type, n) => {
    const a = new Type(buf, off, n);
    off += n * Type.BYTES_PER_ELEMENT;
    off = (off + 3) & ~3;
    return a;
  };
  return {
    V, E, S, G: Gc, names,
    lat: take(Int32Array, V),
    lon: take(Int32Array, V),
    first: take(Uint32Array, V + 1),
    to: take(Uint32Array, E),
    seg: take(Uint32Array, E),
    segLen: take(Float32Array, S),
    segGeom: take(Uint32Array, S + 1),
    gLat: take(Int32Array, Gc),
    gLon: take(Int32Array, Gc),
    segName: take(Uint32Array, S),
    segSpeed: take(Uint8Array, S),
    segFlags: take(Uint8Array, S),
  };
}

function inBox(b, lon, lat) {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

function mergeGraphs(parts) {
  if (parts.length === 1) return parts[0].g;
  // Vertices inside the overlap of two packs' boxes may exist in both graphs: unify them by exact coordinate.
  const keyMap = new Map();
  const remaps = [];
  let V = 0;
  const outLat = [], outLon = [];
  for (let p = 0; p < parts.length; p++) {
    const { g } = parts[p];
    const others = parts.filter((_, i) => i !== p).map((x) => x.bbox);
    const remap = new Int32Array(g.V);
    const lat = new Int32Array(g.V), lon = new Int32Array(g.V);
    let n = 0;
    for (let v = 0; v < g.V; v++) {
      const la = g.lat[v], lo = g.lon[v];
      let shared = false;
      const flo = lo / 1e6, fla = la / 1e6;
      for (const b of others) if (inBox(b, flo, fla)) { shared = true; break; }
      if (shared) {
        const k = la + "," + lo;
        const existing = keyMap.get(k);
        if (existing !== undefined) { remap[v] = existing; continue; }
        keyMap.set(k, V + n);
      }
      remap[v] = V + n;
      lat[n] = la; lon[n] = lo; n++;
    }
    outLat.push(lat.subarray(0, n)); outLon.push(lon.subarray(0, n));
    remaps.push(remap);
    V += n;
  }
  const cat = (Type, arrs, total) => {
    const out = new Type(total);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  const lat = cat(Int32Array, outLat, V), lon = cat(Int32Array, outLon, V);
  let E = 0, S = 0, Gc = 0;
  for (const { g } of parts) { E += g.E; S += g.S; Gc += g.G; }
  const deg = new Uint32Array(V + 1);
  parts.forEach(({ g }, p) => {
    const r = remaps[p];
    for (let v = 0; v < g.V; v++) deg[r[v] + 1] += g.first[v + 1] - g.first[v];
  });
  for (let i = 0; i < V; i++) deg[i + 1] += deg[i];
  const first = deg;
  const fill = first.slice(0, V);
  const to = new Uint32Array(E), seg = new Uint32Array(E);
  const segLen = new Float32Array(S), segGeom = new Uint32Array(S + 1);
  const gLat = new Int32Array(Gc), gLon = new Int32Array(Gc);
  const segName = new Uint32Array(S), segSpeed = new Uint8Array(S), segFlags = new Uint8Array(S);
  const names = [];
  let sOff = 0, gOff = 0;
  parts.forEach(({ g }, p) => {
    const r = remaps[p];
    const nOff = names.length;
    for (const nm of g.names) names.push(nm);
    for (let v = 0; v < g.V; v++) {
      const gv = r[v];
      for (let e = g.first[v]; e < g.first[v + 1]; e++) {
        const k = fill[gv]++;
        to[k] = r[g.to[e]];
        const s = g.seg[e];
        seg[k] = ((s & ~REV) + sOff) | (s & REV);
      }
    }
    for (let s = 0; s < g.S; s++) {
      segLen[sOff + s] = g.segLen[s];
      segGeom[sOff + s] = g.segGeom[s] + gOff;
      segName[sOff + s] = g.segName[s] + nOff;
      segSpeed[sOff + s] = g.segSpeed[s];
      segFlags[sOff + s] = g.segFlags[s];
    }
    gLat.set(g.gLat, gOff); gLon.set(g.gLon, gOff);
    sOff += g.S; gOff += g.G;
    segGeom[sOff] = gOff;
  });
  return { V, E, S, G: Gc, names, lat, lon, first, to, seg, segLen, segGeom, gLat, gLon, segName, segSpeed, segFlags };
}

function buildIndex(g) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (let i = 0; i < g.G; i++) {
    const lo = g.gLon[i], la = g.gLat[i];
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
  }
  const w = (maxLon - minLon) / 1e6 + 1e-6, h = (maxLat - minLat) / 1e6 + 1e-6;
  let cell = 0.005;
  while ((w / cell) * (h / cell) > 4e6) cell *= 2;
  const nx = Math.ceil(w / cell) + 1, ny = Math.ceil(h / cell) + 1;
  const cellOf = (lo, la) => Math.floor((la - minLat) / 1e6 / cell) * nx + Math.floor((lo - minLon) / 1e6 / cell);
  const count = new Uint32Array(nx * ny + 1);
  // One entry per segment per cell (consecutive points in the same cell are deduplicated).
  for (let s = 0; s < g.S; s++) {
    let last = -1;
    for (let i = g.segGeom[s]; i < g.segGeom[s + 1]; i++) {
      const c = cellOf(g.gLon[i], g.gLat[i]);
      if (c !== last) { count[c + 1]++; last = c; }
    }
  }
  for (let i = 0; i < nx * ny; i++) count[i + 1] += count[i];
  const items = new Uint32Array(count[nx * ny]);
  const pos = count.slice(0, nx * ny);
  for (let s = 0; s < g.S; s++) {
    let last = -1;
    for (let i = g.segGeom[s]; i < g.segGeom[s + 1]; i++) {
      const c = cellOf(g.gLon[i], g.gLat[i]);
      if (c !== last) { items[pos[c]++] = s; last = c; }
    }
  }
  g.index = { minLon, minLat, cell, nx, ny, start: count, items };
  // Endpoints of each segment (a = first geometry point's vertex, b = last). Derived from edges.
  g.segA = new Int32Array(g.S).fill(-1);
  g.segB = new Int32Array(g.S).fill(-1);
  g.segFwd = new Uint8Array(g.S); // 1 if a->b allowed
  g.segBwd = new Uint8Array(g.S); // 1 if b->a allowed
  for (let v = 0; v < g.V; v++) {
    for (let e = g.first[v]; e < g.first[v + 1]; e++) {
      const raw = g.seg[e], s = raw & ~REV;
      if (raw & REV) { g.segB[s] = v; g.segA[s] = g.to[e]; g.segBwd[s] = 1; }
      else { g.segA[s] = v; g.segB[s] = g.to[e]; g.segFwd[s] = 1; }
    }
  }
}

// ---------- geometry helpers ----------

const RAD = Math.PI / 180;
function meters(lo1, la1, lo2, la2) {
  const k = Math.cos(((la1 + la2) / 2) * RAD);
  const dx = (lo2 - lo1) * k, dy = la2 - la1;
  return Math.sqrt(dx * dx + dy * dy) * 111195;
}
function bearing(lo1, la1, lo2, la2) {
  const y = Math.sin((lo2 - lo1) * RAD) * Math.cos(la2 * RAD);
  const x = Math.cos(la1 * RAD) * Math.sin(la2 * RAD) - Math.sin(la1 * RAD) * Math.cos(la2 * RAD) * Math.cos((lo2 - lo1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

function segPoints(g, s) {
  const pts = [];
  for (let i = g.segGeom[s]; i < g.segGeom[s + 1]; i++) pts.push([g.gLon[i] / 1e6, g.gLat[i] / 1e6]);
  return pts;
}

/** Snap a point to the nearest road segment. Returns {s, t (0..1 by length), point, dist, before, after}. */
function snap(g, lon, lat, filter) {
  const ix = g.index;
  const cx = Math.floor((lon - ix.minLon / 1e6) / ix.cell);
  const cy = Math.floor((lat - ix.minLat / 1e6) / ix.cell);
  let best = null;
  const k = Math.cos(lat * RAD);
  for (let ring = 0; ring <= 40; ring++) {
    for (let y = cy - ring; y <= cy + ring; y++) {
      for (let x = cx - ring; x <= cx + ring; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
        if (x < 0 || y < 0 || x >= ix.nx || y >= ix.ny) continue;
        const c = y * ix.nx + x;
        for (let j = ix.start[c]; j < ix.start[c + 1]; j++) {
          const s = ix.items[j];
          if (filter && !filter(s)) continue;
          let acc = 0;
          for (let i = g.segGeom[s]; i < g.segGeom[s + 1] - 1; i++) {
            const ax = g.gLon[i] / 1e6, ay = g.gLat[i] / 1e6, bx = g.gLon[i + 1] / 1e6, by = g.gLat[i + 1] / 1e6;
            const dx = (bx - ax) * k, dy = by - ay;
            const px = (lon - ax) * k, py = lat - ay;
            const l2 = dx * dx + dy * dy;
            let t = l2 ? (px * dx + py * dy) / l2 : 0;
            t = Math.max(0, Math.min(1, t));
            const ex = px - t * dx, ey = py - t * dy;
            const d = Math.sqrt(ex * ex + ey * ey) * 111195;
            const segLen = Math.sqrt(l2) * 111195;
            if (!best || d < best.dist) {
              best = { s, dist: d, along: acc + t * segLen, idx: i - g.segGeom[s], frac: t,
                point: [ax + (bx - ax) * t, ay + (by - ay) * t] };
            }
            acc += segLen;
          }
        }
      }
    }
    // Stop once the ring is wider than the best distance found.
    if (best && ring * ix.cell * 111195 * Math.min(1, k) > best.dist + ix.cell * 111195) break;
  }
  if (!best) return null;
  const total = g.segLen[best.s] || 1;
  best.t = Math.max(0, Math.min(1, best.along / total));
  return best;
}

// ---------- routing ----------

class Heap {
  constructor(cap) { this.ids = new Int32Array(cap); this.keys = new Float64Array(cap); this.n = 0; }
  push(id, key) {
    if (this.n >= this.ids.length) {
      const ids = new Int32Array(this.ids.length * 2); ids.set(this.ids); this.ids = ids;
      const keys = new Float64Array(this.keys.length * 2); keys.set(this.keys); this.keys = keys;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p]; i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop() {
    const id = this.ids[0];
    const last = --this.n;
    const lid = this.ids[last], lkey = this.keys[last];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= last) break;
      if (c + 1 < last && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lkey) break;
      this.ids[i] = this.ids[c]; this.keys[i] = this.keys[c]; i = c;
    }
    this.ids[i] = lid; this.keys[i] = lkey;
    return id;
  }
  topKey() { return this.keys[0]; }
}

function segCost(g, s, opt) {
  const f = g.segFlags[s];
  if ((f & F.TRACK) && !opt.offroad) return Infinity;
  if ((f & F.FORD) && !opt.offroad) return Infinity;
  if ((f & F.FERRY) && !opt.ferry) return Infinity;
  let speed = g.segSpeed[s] || 30;
  if (f & F.UNPAVED) speed = Math.min(speed, 30);
  let cost = g.segLen[s] / (speed / 3.6);
  if (f & F.UNPAVED) cost *= opt.avoidUnpaved ? 5 : 1.3;
  if (f & F.UNKNOWN_SURFACE) cost *= opt.avoidUnpaved ? 1.6 : 1.1;
  if (f & F.TRACK) cost *= 2;
  if (f & F.PRIVATE) cost *= 30; // only used if there is no other way (e.g. start inside a condo)
  if ((f & F.TOLL) && opt.avoidTolls) cost *= 3;
  if (f & F.FERRY) cost += 1800; // waiting time
  return cost;
}

let dist = null, prev = null, stamp = null, curStamp = 0;

function route(g, from, to, opt) {
  const ok = (s) => segCost(g, s, opt) < Infinity;
  const a = snap(g, from[0], from[1], ok);
  const b = snap(g, to[0], to[1], ok);
  if (!a || !b) return { error: "Não há estrada mapeada perto do ponto escolhido." };
  if (!dist || dist.length < g.V) {
    dist = new Float64Array(g.V); prev = new Int32Array(g.V); stamp = new Uint32Array(g.V);
  }
  curStamp++;
  const get = (v) => (stamp[v] === curStamp ? dist[v] : Infinity);
  const set = (v, d, e) => { stamp[v] = curStamp; dist[v] = d; prev[v] = e; };
  const heap = new Heap(1 << 16);
  const tLon = b.point[0], tLat = b.point[1];
  const h = (v) => meters(g.lon[v] / 1e6, g.lat[v] / 1e6, tLon, tLat) / MAX_SPEED_MPS;

  // Seeds: from the snapped point move along segment a.s to either end.
  const ca = segCost(g, a.s, opt);
  if (g.segFwd[a.s]) { set(g.segB[a.s], (1 - a.t) * ca, -2); heap.push(g.segB[a.s], get(g.segB[a.s]) + h(g.segB[a.s])); }
  if (g.segBwd[a.s] && (!g.segFwd[a.s] || a.t * ca < get(g.segA[a.s]))) {
    set(g.segA[a.s], a.t * ca, -3); heap.push(g.segA[a.s], get(g.segA[a.s]) + h(g.segA[a.s]));
  }
  // Targets: reaching an end of segment b.s, then moving along it to the snapped point.
  const cb = segCost(g, b.s, opt);
  const targetExtra = new Map();
  if (g.segFwd[b.s]) targetExtra.set(g.segA[b.s], b.t * cb);
  if (g.segBwd[b.s]) {
    const e = (1 - b.t) * cb;
    const v = g.segB[b.s];
    if (!targetExtra.has(v) || targetExtra.get(v) > e) targetExtra.set(v, e);
  }
  let best = Infinity, bestV = -1;
  // Same segment, moving in an allowed direction.
  let direct = false;
  if (a.s === b.s && ((b.t >= a.t && g.segFwd[a.s]) || (b.t < a.t && g.segBwd[a.s]))) {
    best = Math.abs(b.t - a.t) * ca; direct = true;
  }
  let settled = 0;
  while (heap.n > 0) {
    if (heap.topKey() >= best) break;
    const u = heap.pop();
    const du = get(u);
    settled++;
    const extra = targetExtra.get(u);
    if (extra !== undefined && du + extra < best) { best = du + extra; bestV = u; direct = false; }
    for (let e = g.first[u]; e < g.first[u + 1]; e++) {
      const s = g.seg[e] & ~REV;
      const c = segCost(g, s, opt);
      if (c === Infinity) continue;
      const v = g.to[e];
      const nd = du + c;
      if (nd < get(v)) { set(v, nd, e); heap.push(v, nd + h(v)); }
    }
  }
  if (best === Infinity) return { error: "Não foi possível encontrar uma rota com as opções de segurança atuais." };

  // Rebuild the path as a list of [segment, reversed, fromT, toT].
  const pieces = [];
  if (direct) {
    pieces.push([a.s, b.t < a.t, a.t, b.t]);
  } else {
    // End piece along b.s
    const endFromA = g.segA[b.s] === bestV && g.segFwd[b.s] && targetExtra.get(bestV) === b.t * cb;
    pieces.push(endFromA ? [b.s, false, 0, b.t] : [b.s, true, 1, b.t]);
    let v = bestV;
    let guard = 0;
    while (prev[v] >= 0 && guard++ < 5e6) {
      const e = prev[v];
      const raw = g.seg[e];
      const s = raw & ~REV, rev = (raw & REV) !== 0;
      pieces.push(rev ? [s, true, 1, 0] : [s, false, 0, 1]);
      v = rev ? g.segB[s] : g.segA[s];
    }
    // Start piece along a.s
    pieces.push(prev[v] === -2 ? [a.s, false, a.t, 1] : [a.s, true, a.t, 0]);
    pieces.reverse();
  }
  return { ...describe(g, pieces, a, b), settled, snapFrom: a.dist, snapTo: b.dist };
}

function partialGeometry(g, s, rev, t0, t1) {
  // Geometry of segment s between fractions t0 and t1 (by length), oriented by travel direction.
  const pts = segPoints(g, s);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + meters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  const total = cum[cum.length - 1] || 1;
  const at = (t) => {
    const d = t * total;
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] >= d) {
        const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      }
    }
    return pts[pts.length - 1];
  };
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  const out = [at(lo)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] / total > lo && cum[i] / total < hi) out.push(pts[i]);
  out.push(at(hi));
  if (rev) out.reverse();
  return { pts: out, len: (hi - lo) * total };
}

function turnText(delta) {
  const a = Math.abs(delta);
  const side = delta > 0 ? "direita" : "esquerda";
  if (a < 20) return { mod: "straight", text: "Siga em frente" };
  if (a < 55) return { mod: "slight-" + (delta > 0 ? "right" : "left"), text: `Mantenha-se à ${side}` };
  if (a < 140) return { mod: delta > 0 ? "right" : "left", text: `Vire à ${side}` };
  return { mod: "uturn", text: "Faça o retorno" };
}

function describe(g, pieces) {
  const coords = [];
  const legs = []; // per piece: {s, len, startIdx, endIdx}
  for (const [s, rev, t0, t1] of pieces) {
    const { pts, len } = partialGeometry(g, s, rev, t0, t1);
    if (len < 0.01 && legs.length) continue;
    const startIdx = coords.length ? coords.length - 1 : 0;
    if (coords.length) pts.shift();
    for (const p of pts) coords.push(p);
    legs.push({ s, len, startIdx, endIdx: coords.length - 1 });
  }
  const warn = { unpaved: 0, unknown: 0, track: 0, ford: 0, ferry: 0, private: 0, toll: 0 };
  const flagged = []; // [startIdx, endIdx, kind] for drawing warnings on the map
  let time = 0, distance = 0;
  for (const l of legs) {
    const f = g.segFlags[l.s];
    distance += l.len;
    const full = g.segLen[l.s] || 1;
    let speed = g.segSpeed[l.s] || 30;
    if (f & (F.UNPAVED | F.TRACK)) speed = Math.min(speed, (f & F.TRACK) ? 15 : 30);
    time += l.len / (speed / 3.6) + ((f & F.FERRY) ? (1800 * l.len) / full : 0);
    if (f & F.UNPAVED) { warn.unpaved += l.len; flagged.push([l.startIdx, l.endIdx, "unpaved"]); }
    if (f & F.UNKNOWN_SURFACE) { warn.unknown += l.len; flagged.push([l.startIdx, l.endIdx, "unknown"]); }
    if (f & F.TRACK) warn.track += l.len;
    if (f & F.FORD) { warn.ford++; flagged.push([l.startIdx, l.endIdx, "ford"]); }
    if (f & F.FERRY) { warn.ferry++; flagged.push([l.startIdx, l.endIdx, "ferry"]); }
    if (f & F.PRIVATE) { warn.private += l.len; flagged.push([l.startIdx, l.endIdx, "private"]); }
    if (f & F.TOLL) warn.toll += l.len;
  }
  // Maneuvers
  const steps = [];
  const nameOf = (s) => g.names[g.segName[s]] || "";
  const startB = coords.length > 1 ? bearing(coords[0][0], coords[0][1], coords[Math.min(1, coords.length - 1)][0], coords[Math.min(1, coords.length - 1)][1]) : 0;
  steps.push({ type: "depart", text: `Siga ${nameOf(legs[0].s) ? "pela " + nameOf(legs[0].s) : "em frente"}`, name: nameOf(legs[0].s), idx: 0, bearing: startB, distance: 0 });
  let inRoundabout = false, exits = 0;
  for (let i = 1; i < legs.length; i++) {
    const p = legs[i - 1], c = legs[i];
    const fp = g.segFlags[p.s], fc = g.segFlags[c.s];
    const vIdx = c.startIdx;
    const B = coords[vIdx];
    let ia = vIdx - 1, ic = vIdx + 1;
    while (ia > 0 && meters(coords[ia][0], coords[ia][1], B[0], B[1]) < 15) ia--;
    while (ic < coords.length - 1 && meters(coords[ic][0], coords[ic][1], B[0], B[1]) < 15) ic++;
    const A = coords[Math.max(0, ia)], C = coords[Math.min(coords.length - 1, ic)];
    const bin = bearing(A[0], A[1], B[0], B[1]);
    const bout = bearing(B[0], B[1], C[0], C[1]);
    const delta = ((bout - bin + 540) % 360) - 180;
    const name = nameOf(c.s);
    if (fc & F.ROUNDABOUT) {
      if (!inRoundabout) { inRoundabout = true; exits = 0; steps.push({ type: "roundabout", text: "Entre na rotatória", name, idx: vIdx, exit: 0 }); }
      else exits++;
      continue;
    }
    if (inRoundabout) {
      inRoundabout = false;
      const st = steps[steps.length - 1];
      st.exit = exits + 1;
      st.text = `Na rotatória, pegue a ${exits + 1}ª saída` + (name ? ` para ${name}` : "");
      st.name = name;
      continue;
    }
    if ((fc & F.FERRY) && !(fp & F.FERRY)) { steps.push({ type: "ferry", text: "Embarque na balsa", name, idx: vIdx }); continue; }
    const changedName = name !== nameOf(p.s);
    if (Math.abs(delta) >= 35 || (changedName && Math.abs(delta) >= 15)) {
      const t = turnText(delta);
      steps.push({ type: "turn", mod: t.mod, text: t.text + (name ? ` na ${name}` : ""), name, idx: vIdx });
    } else if (changedName && name) {
      steps.push({ type: "continue", mod: "straight", text: `Continue na ${name}`, name, idx: vIdx });
    }
  }
  steps.push({ type: "arrive", text: "Você chegou ao destino", name: "", idx: coords.length - 1 });
  // Distance from each step to the next
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + meters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  for (let i = 0; i < steps.length; i++) {
    steps[i].at = cum[steps[i].idx];
    steps[i].distance = i + 1 < steps.length ? cum[steps[i + 1].idx] - cum[steps[i].idx] : 0;
  }
  return { coords, cum, distance, time, steps, warn, flagged };
}

// ---------- messages ----------

self.onmessage = (ev) => {
  const { id, type } = ev.data;
  try {
    if (type === "load") {
      const parts = ev.data.graphs.map(({ buf, bbox }) => ({ g: parseGraph(buf), bbox }));
      G = parts.length ? mergeGraphs(parts) : null;
      if (G) buildIndex(G);
      dist = null;
      self.postMessage({ id, ok: true, V: G ? G.V : 0, E: G ? G.E : 0 });
    } else if (type === "route") {
      if (!G) throw new Error("Nenhum mapa de rotas instalado. Baixe o mapa do seu estado.");
      const t0 = Date.now();
      const r = route(G, ev.data.from, ev.data.to, ev.data.options || {});
      self.postMessage({ id, ok: !r.error, error: r.error, route: r.error ? null : r, ms: Date.now() - t0 });
    } else if (type === "snap") {
      if (!G) throw new Error("Sem mapa de rotas");
      const s = snap(G, ev.data.point[0], ev.data.point[1]);
      self.postMessage({ id, ok: true, dist: s ? s.dist : null, point: s ? s.point : null });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message ? e.message : e) });
  }
};
