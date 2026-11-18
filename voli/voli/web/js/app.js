// Voli — offline survival maps for Brazil.
import * as maplibregl from "../vendor/maplibre-gl.mjs";
import { PMTiles } from "./pmtiles.js";
import { buildStyle } from "./style.js";
import * as geo from "./geo.js";
import * as native from "./native.js";

const ORIGIN = location.origin;
const DISCLAIMER_VERSION = 1;
const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © OpenMapTiles · Overture Maps · Natural Earth · Relevo: Copernicus DEM © DLR e.V. / Airbus, ESA';

// ---------------------------------------------------------------- state
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("vt." + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem("vt." + k, JSON.stringify(v)); } catch (_) { /* full */ } },
};
const DEFAULT_SETTINGS = {
  theme: "auto", colors: "mono", terrain: true, terrainExaggeration: 1.35, buildings3d: true, showPois: true,
  avoidUnpaved: true, ferry: false, offroad: false, avoidTolls: false,
  voice: true, vibrate: true, northUp: false, keepScreenOn: true, staleDays: 30,
  textScale: 1.15, maxContrast: false, reduceMotion: false,
  units: "metric", coordFormat: "both", trackSpacing: 15, wifiOnly: true, autoCheck: true,
};
const settings = Object.assign({}, DEFAULT_SETTINGS, store.get("settings", {}));
const saveSettings = () => store.set("settings", settings);

let STATES = [];
let installed = {}; // uf -> {meta, files}
let packSet = []; // [{uf, bbox, vector, terrain}]
let map;
let me = null; // last GPS fix {lon, lat, acc, alt, heading, speed, t}
let deviceHeading = null;
let following = true;
let nav = null; // active navigation state
let currentRoute = null;
let destination = null;
let straightTarget = null; // waypoint followed in a straight line (off-road)
let downloads = {}; // uf -> {done, total}
let manifest = store.get("manifest", null);

// ---------------------------------------------------------------- helpers
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}
function fmtBytes(b) {
  if (!b) return "—";
  if (b > 1e9) return (b / 1e9).toFixed(1).replace(".", ",") + " GB";
  return Math.max(1, Math.round(b / 1e6)) + " MB";
}
function daysSince(iso) { return iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null; }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR") : "?"; }
function normalize(s) { return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
async function gunzip(buf) {
  const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
async function blobWorker(url, opts) {
  const text = await (await fetch(url)).text();
  return URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
}

// ---------------------------------------------------------------- sheet / modal
function openSheet(content, key, compact) {
  const c = $("sheet-content");
  c.replaceChildren(content);
  $("sheet").classList.toggle("compact", !!compact);
  $("sheet").scrollTop = 0;
  $("sheet").classList.remove("hidden");
  $("sheet").dataset.key = key || "";
  for (const b of document.querySelectorAll("#bottombar button")) b.classList.toggle("on", b.dataset.panel === key);
}
function closeSheet() {
  $("sheet").classList.add("hidden");
  $("sheet").dataset.key = "";
  for (const b of document.querySelectorAll("#bottombar button")) b.classList.remove("on");
}
function modal(content) {
  $("modal-box").replaceChildren(content);
  $("modal").classList.remove("hidden");
}
function closeModal() { $("modal").classList.add("hidden"); }

// ---------------------------------------------------------------- packs
async function loadStates() {
  const r = await fetch("data/states.json");
  STATES = (await r.json()).states;
}

function refreshInstalled() {
  installed = native.listPacks();
  const ufs = Object.keys(installed).filter((uf) => {
    const f = installed[uf].files || {};
    return f[uf + ".pmtiles"];
  });
  packSet = ufs.map((uf) => {
    const st = STATES.find((s) => s.uf === uf);
    const f = installed[uf].files;
    return {
      uf,
      bbox: st ? st.bbox : [-180, -90, 180, 90],
      vector: new PMTiles(`${ORIGIN}/packs/${uf}.pmtiles`),
      terrain: f[uf + "-terrain.pmtiles"] ? new PMTiles(`${ORIGIN}/packs/${uf}-terrain.pmtiles`) : null,
    };
  });
}

function packsForTile(z, x, y) {
  const [w, s, e, n] = geo.tileBounds(z, x, y);
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const hits = packSet.filter((p) => !(e < p.bbox[0] || w > p.bbox[2] || n < p.bbox[1] || s > p.bbox[3]));
  // Packs whose box contains the tile centre are tried first (their data is complete there).
  return hits.sort((a, b) => {
    const ia = cx >= a.bbox[0] && cx <= a.bbox[2] && cy >= a.bbox[1] && cy <= a.bbox[3];
    const ib = cx >= b.bbox[0] && cx <= b.bbox[2] && cy >= b.bbox[1] && cy <= b.bbox[3];
    return ib - ia;
  });
}

let flatDem = null;
async function flatDemTile() {
  if (flatDem) return flatDem;
  // Elevation 0 in Mapbox Terrain-RGB encoding: value 100000 -> RGB(1, 134, 160)
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(1,134,160)";
  ctx.fillRect(0, 0, 256, 256);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  flatDem = await blob.arrayBuffer();
  return flatDem;
}

function registerProtocol() {
  maplibregl.addProtocol("vt", async (params) => {
    const m = /^vt:\/\/(vector|terrain)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error("bad url " + params.url);
    const kind = m[1], z = +m[2], x = +m[3], y = +m[4];
    for (const p of packsForTile(z, x, y)) {
      const src = kind === "vector" ? p.vector : p.terrain;
      if (!src) continue;
      try {
        const data = await src.getTile(z, x, y);
        if (data && data.byteLength) return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
      } catch (e) {
        console.warn("tile error", p.uf, kind, z, x, y, e);
      }
    }
    if (kind === "terrain") return { data: (await flatDemTile()).slice(0) };
    return { data: new ArrayBuffer(0) };
  });
}

/** Elevation in metres from the installed terrain packs (independent of map rendering). */
async function elevationAt(lon, lat) {
  const z = 11;
  const [x, y] = geo.lngLatToTile(lon, lat, z);
  for (const p of packsForTile(z, x, y)) {
    if (!p.terrain) continue;
    const data = await p.terrain.getTile(z, x, y).catch(() => null);
    if (!data) continue;
    const bmp = await createImageBitmap(new Blob([data]));
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const n = Math.pow(2, z);
    const fx = ((lon + 180) / 360) * n - x;
    const latR = (lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n - y;
    const px = Math.min(bmp.width - 1, Math.floor(fx * bmp.width));
    const py = Math.min(bmp.height - 1, Math.floor(fy * bmp.height));
    const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
    return -10000 + (r * 65536 + g * 256 + b) * 0.1;
  }
  return null;
}

// ---------------------------------------------------------------- router
let routerWorker = null;
let routerSeq = 0;
const routerWaiters = new Map();
let routerReady = null;

async function startRouter() {
  if (!routerWorker) {
    routerWorker = new Worker(await blobWorker("js/router-worker.js"));
    routerWorker.onmessage = (ev) => {
      const w = routerWaiters.get(ev.data.id);
      if (w) { routerWaiters.delete(ev.data.id); w(ev.data); }
    };
  }
  routerReady = (async () => {
    const graphs = [];
    for (const p of packSet) {
      const f = installed[p.uf].files;
      if (!f[p.uf + ".route.gz"]) continue;
      const buf = await gunzip(await (await fetch(`${ORIGIN}/packs/${p.uf}.route.gz`)).arrayBuffer());
      graphs.push({ buf, bbox: p.bbox });
    }
    return routerCall({ type: "load", graphs }, graphs.map((g) => g.buf));
  })();
  return routerReady;
}

function routerCall(msg, transfer = []) {
  const id = ++routerSeq;
  return new Promise((resolve) => {
    routerWaiters.set(id, resolve);
    routerWorker.postMessage({ ...msg, id }, transfer);
  });
}

// ---------------------------------------------------------------- search
let searchData = null;

/*
 * Offline search index. A state can hold hundreds of thousands of places (OpenStreetMap + Overture),
 * so names are kept in one normalised string and matched with indexOf (fast, little memory),
 * with small typed arrays for coordinates and labels.
 */
const KIND = { PLACE: 0, STREET: 1, POI: 2, BIZ: 3 };
const KIND_WEIGHT = [3.2, 1.4, 1.8, 1.5];
const PLACE_WEIGHT = { city: 1.2, town: 0.9, village: 0.3, suburb: 0.2 };

async function loadSearch() {
  if (searchData) return searchData;
  const parts = [], lon = [], lat = [], kind = [], subA = [], subB = [], rank = [];
  const subs = [""], subIdx = new Map([["", 0]]);
  const subId = (t) => { t = t || ""; let i = subIdx.get(t); if (i === undefined) { i = subs.length; subs.push(t); subIdx.set(t, i); } return i; };
  const add = (name, k, x, y, a, b = 0, r = 0) => {
    if (!name) return;
    parts.push(name.replace(/\n/g, " ")); lon.push(x); lat.push(y); kind.push(k); subA.push(a); subB.push(b); rank.push(r);
  };
  const pois = [];
  const addrStreets = [], addrStreetsNorm = [], addrStreetIdx = new Map();
  const aStreet = [], aNum = [], aLon = [], aLat = [], aCity = [];
  for (const p of packSet) {
    const f = installed[p.uf].files;
    if (!f[p.uf + ".search.json.gz"]) continue;
    try {
      const txt = new TextDecoder().decode(await gunzip(await (await fetch(`${ORIGIN}/packs/${p.uf}.search.json.gz`)).arrayBuffer()));
      const d = JSON.parse(txt);
      const cityIds = (d.cities || []).map((c) => subId(c));
      const city = (i) => (i >= 0 && i < cityIds.length ? cityIds[i] : 0);
      for (const [name, k, x, y] of d.places || []) add(name, KIND.PLACE, x, y, subId(placeLabel(k)), 0, PLACE_WEIGHT[k] || 0);
      for (const [name, x, y, ci] of d.streets || []) add(name, KIND.STREET, x, y, city(ci));
      for (const [cat, x, y, name] of d.pois || []) {
        pois.push({ cat, lon: x, lat: y, name });
        add(name, KIND.POI, x, y, subId(POI[cat]?.label || ""));
      }
      const A = d.addr;
      if (A && A.n) {
        const nums = A.n.split("\n");
        const streetIds = A.s.map((st) => {
          const k = normalize(st);
          let id = addrStreetIdx.get(k);
          if (id === undefined) { id = addrStreets.length; addrStreets.push(st); addrStreetsNorm.push(k); addrStreetIdx.set(k, id); }
          return id;
        });
        for (let i = 0; i < nums.length; i++) {
          aStreet.push(streetIds[A.i[i]]); aNum.push(nums[i]); aLon.push(A.x[i] / 1e5); aLat.push(A.y[i] / 1e5); aCity.push(city(A.t[i]));
        }
      }
      const B = d.biz;
      if (B && B.n) {
        // columnar businesses: names arrive as one joined string
        parts.push(B.n);
        const labelIds = B.l.map((l) => subId(bizLabel(l)));
        for (let i = 0; i < B.x.length; i++) {
          lon.push(B.x[i] / 1e5); lat.push(B.y[i] / 1e5); kind.push(KIND.BIZ);
          subA.push(labelIds[B.c[i]]); subB.push(city(B.t[i])); rank.push(0);
        }
      }
    } catch (e) { console.warn("search load", p.uf, e); }
  }
  const names = parts.join("\n") + "\n";
  const text = normalize(names);
  const n = lon.length;
  const nameStarts = new Uint32Array(n + 1), textStarts = new Uint32Array(n + 1);
  for (let i = 0, a = 0, b = 0; i < n; i++) {
    nameStarts[i] = a; textStarts[i] = b;
    a = names.indexOf("\n", a) + 1; b = text.indexOf("\n", b) + 1;
  }
  nameStarts[n] = names.length; textStarts[n] = text.length;
  searchData = {
    names, text, nameStarts, starts: textStarts, count: n,
    lon: Float64Array.from(lon), lat: Float64Array.from(lat), kind: Uint8Array.from(kind),
    subA: Uint32Array.from(subA), subB: Uint32Array.from(subB), rank: Float32Array.from(rank), subs, pois,
    addr: {
      streets: addrStreets, streetsNorm: addrStreetsNorm, street: Uint32Array.from(aStreet), num: aNum,
      numInt: Int32Array.from(aNum.map((n) => parseInt(n, 10) || -1)),
      lon: Float64Array.from(aLon), lat: Float64Array.from(aLat), city: Uint32Array.from(aCity),
    },
    vocab: null,
  };
  return searchData;
}

function placeLabel(kind) {
  return { city: "Cidade", town: "Cidade", village: "Vila / povoado", hamlet: "Povoado", suburb: "Bairro", neighbourhood: "Bairro", locality: "Localidade", isolated_dwelling: "Sítio / fazenda" }[kind] || "Lugar";
}

// Overture basic categories (English ids) shown in Portuguese; unknown ones fall back to "Estabelecimento".
const BIZ_PT = {
  restaurant: "Restaurante", casual_eatery: "Lanchonete", fast_food: "Lanchonete", cafe: "Café", coffee_shop: "Café",
  bar: "Bar", bakery: "Padaria", supermarket: "Supermercado", grocery_store: "Mercado", convenience_store: "Conveniência",
  pharmacy: "Farmácia", drugstore: "Farmácia", hospital: "Hospital", clinic: "Clínica", doctor: "Médico", dentist: "Dentista",
  gas_station: "Posto de combustível", car_repair: "Oficina", auto_repair: "Oficina", tire_shop: "Borracharia",
  hotel: "Hotel", lodging: "Hospedagem", motel: "Motel", hostel: "Hostel", campground: "Camping",
  bank: "Banco", atm: "Caixa eletrônico", school: "Escola", university: "Universidade", church: "Igreja",
  place_of_worship: "Templo / igreja", park: "Parque", gym: "Academia", beauty_salon: "Salão de beleza",
  hair_salon: "Cabeleireiro", clothing_store: "Loja de roupas", shoe_store: "Calçados", hardware_store: "Material de construção",
  pet_store: "Pet shop", veterinarian: "Veterinário", police_station: "Polícia", fire_station: "Bombeiros",
  post_office: "Correios", government_office: "Órgão público", museum: "Museu", shopping_mall: "Shopping",
  parking: "Estacionamento", bus_station: "Rodoviária", airport: "Aeroporto", lawyer: "Advogado", real_estate: "Imobiliária",
};
function bizLabel(basic) {
  if (!basic) return "Estabelecimento";
  return BIZ_PT[basic] || "Estabelecimento";
}

const POI = {
  water: { label: "Água potável", letter: "A", color: "#0b4fc4" },
  hospital: { label: "Hospital / pronto-socorro", letter: "H", color: "#d92d20" },
  clinic: { label: "Posto de saúde / clínica", letter: "+", color: "#e5534b" },
  pharmacy: { label: "Farmácia", letter: "F", color: "#006d77" },
  fuel: { label: "Posto de combustível", letter: "C", color: "#b34700" },
  police: { label: "Polícia", letter: "P", color: "#0b3d91" },
  fire: { label: "Bombeiros", letter: "B", color: "#b3150b" },
  shelter: { label: "Abrigo", letter: "⌂", color: "#6b4b2a" },
  food: { label: "Mercado", letter: "M", color: "#5b3fa8" },
};

function findItem(starts, pos) {
  let lo = 0, hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Plain name search over the index; returns [{i, score}] best first. */
function searchNames(S, nq, c) {
  const coslat = Math.cos((c.lat * Math.PI) / 180);
  const words = nq.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const key = words.reduce((a, b) => (b.length > a.length ? b : a), "");
  const seen = new Set();
  const scored = [];
  let from = 0, guard = 0;
  while (scored.length < 60000 && guard++ < 600000) {
    const at = S.text.indexOf(key, from);
    if (at < 0) break;
    const i = findItem(S.starts, at);
    from = S.starts[i + 1];
    if (seen.has(i)) continue;
    seen.add(i);
    const item = S.text.slice(S.starts[i], S.starts[i + 1] - 1);
    if (words.length > 1 && !words.every((w) => item.includes(w))) continue;
    let sc = item.startsWith(nq) ? 3 : item.includes(" " + nq) || item.startsWith(key) ? 2 : 1;
    const dx = (S.lon[i] - c.lng) * coslat, dy = S.lat[i] - c.lat;
    sc += KIND_WEIGHT[S.kind[i]] + S.rank[i] - Math.log10(Math.sqrt(dx * dx + dy * dy) * 111.2 + 1) * 0.9;
    scored.push({ i, score: sc });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/* ---- typo tolerance: closest known word (edit distance 1, or 2 for long words) ---- */
function buildVocab(S) {
  const freq = new Map();
  const re = /[a-z0-9]{3,}/g;
  let m;
  while ((m = re.exec(S.text))) freq.set(m[0], (freq.get(m[0]) || 0) + 1);
  const byLen = new Map();
  for (const [w, f] of freq) {
    if (!byLen.has(w.length)) byLen.set(w.length, []);
    byLen.get(w.length).push([w, f]);
  }
  return { freq, byLen };
}
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev[j - 2] + 1); // swapped letters
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function correctWord(S, w) {
  if (w.length < 4 || /^\d+$/.test(w)) return w;
  if (!S.vocab) S.vocab = buildVocab(S);
  if (S.vocab.freq.has(w)) return w;
  const max = w.length >= 7 ? 2 : 1;
  let best = null, bestD = max + 1, bestF = 0;
  for (let len = w.length - max; len <= w.length + max; len++) {
    for (const [cand, f] of S.vocab.byLen.get(len) || []) {
      const d = editDistance(w, cand, max);
      if (d < bestD || (d === bestD && f > bestF)) { best = cand; bestD = d; bestF = f; }
    }
  }
  return best || w;
}

/* ---- "Rua das Flores, 120" ---- */
function parseAddress(q) {
  const m = /^(.*?\S)[\s,]+(?:n[º°o.]?\s*)?(\d{1,6}[a-z]?)$/i.exec(q.trim());
  if (!m || m[1].replace(/[^a-zA-ZÀ-ÿ]/g, "").length < 3) return null;
  return { street: normalize(m[1].replace(/,$/, "")), number: m[2] };
}
function searchAddress(S, street, number, c) {
  const A = S.addr;
  if (!A || !A.num.length) return [];
  const words = street.split(/\s+/).filter(Boolean);
  const streets = new Set();
  A.streetsNorm.forEach((n, id) => { if (words.every((w) => n.includes(w))) streets.add(id); });
  if (!streets.size) return [];
  const want = parseInt(number, 10);
  const groups = new Map(); // street+city -> best entry
  for (let i = 0; i < A.num.length; i++) {
    if (!streets.has(A.street[i])) continue;
    const exact = A.num[i].toLowerCase() === number.toLowerCase();
    const diff = exact ? 0 : A.numInt[i] >= 0 ? Math.abs(A.numInt[i] - want) + 0.5 : 1e9;
    const k = A.street[i] + "|" + A.city[i];
    const g = groups.get(k);
    if (!g || diff < g.diff) groups.set(k, { i, diff, exact });
  }
  const coslat = Math.cos((c.lat * Math.PI) / 180);
  return [...groups.values()].map((g) => {
    const dx = (A.lon[g.i] - c.lng) * coslat, dy = A.lat[g.i] - c.lat;
    return { ...g, dist: Math.sqrt(dx * dx + dy * dy) };
  }).sort((a, b) => (a.exact !== b.exact ? (a.exact ? -1 : 1) : a.dist - b.dist)).slice(0, 8);
}

function resultRow(ico, name, sub, lon, lat, poi) {
  const box = $("search-results");
  const d = me ? geo.formatDistance(geo.distance(me.lon, me.lat, lon, lat)) : "";
  return el("button", { class: "result", onclick: () => { box.classList.add("hidden"); $("search-input").blur(); chooseDestination(lon, lat, name, sub); } },
    el("span", { class: "ico" + (poi ? " poi" : "") }, ico),
    el("span", { class: "grow" }, el("b", {}, name), el("small", {}, [sub, d].filter(Boolean).join(" · "))));
}

function runSearch(q) {
  const box = $("search-results");
  const nq = normalize(q.trim());
  if (nq.length < 2) { showSearchHome(); return; }
  if (!searchData) { box.replaceChildren(el("div", { class: "result" }, "Carregando índice offline…")); box.classList.remove("hidden"); }
  loadSearch().then((S) => {
    if (normalize($("search-input").value.trim()) !== nq) return;
    const t0 = performance.now();
    const c = map.getCenter();
    const rows = [];
    // 1. Street address with a house number
    const addr = parseAddress(q);
    if (addr) {
      for (const r of searchAddress(S, addr.street, addr.number, c)) {
        const A = S.addr;
        const streetName = A.streets[A.street[r.i]];
        const cityName = S.subs[A.city[r.i]];
        const title = `${streetName}, ${A.num[r.i]}`;
        const note = r.exact ? "Endereço" : `nº ${addr.number} não está no mapa · mais próximo`;
        rows.push(resultRow("⌂", title, [note, cityName].filter(Boolean).join(" · "), A.lon[r.i], A.lat[r.i]));
      }
    }
    // 2. Names; if few results, try correcting typos
    const query = addr && !rows.length ? addr.street : nq;
    let found = searchNames(S, query, c);
    let corrected = null;
    if (found.length < 3) {
      const fixed = query.split(/\s+/).map((w) => correctWord(S, w)).join(" ");
      if (fixed !== query) {
        const more = searchNames(S, fixed, c);
        if (more.length > found.length) { found = more; corrected = fixed; }
      }
    }
    console.debug(`search "${nq}": ${found.length} matches in ${Math.round(performance.now() - t0)} ms`);
    if (corrected) rows.push(el("div", { class: "result note" }, `Mostrando resultados para “${corrected}”`));
    if (addr && !rows.some((r) => r.textContent.includes(","))) {
      rows.push(el("div", { class: "result note" }, `O número ${addr.number} não está nos mapas offline desta rua. Mostrando a rua.`));
    }
    const shown = new Set();
    for (const { i } of found) {
      const name = S.names.slice(S.nameStarts[i], S.nameStarts[i + 1] - 1);
      const sub = [S.subs[S.subA[i]], S.subs[S.subB[i]]].filter(Boolean).join(" · ");
      const lon = S.lon[i], lat = S.lat[i];
      const k = normalize(name) + "|" + Math.round(lon * 500) + "|" + Math.round(lat * 500); // same place from two sources
      if (shown.has(k)) continue;
      shown.add(k);
      const kind = S.kind[i];
      rows.push(resultRow(kind === KIND.STREET ? "≡" : kind === KIND.PLACE ? "◉" : kind === KIND.BIZ ? "▣" : "✚", name, sub, lon, lat, kind >= KIND.POI));
      if (rows.length >= 30) break;
    }
    if (!rows.length) {
      rows.push(el("div", { class: "result" }, S.count ? "Nada encontrado nos mapas baixados." : "Baixe o mapa do seu estado para buscar sem internet."));
    }
    box.replaceChildren(...rows);
    box.classList.remove("hidden");
  });
}

/* ---- empty search: Home, Work, shortcuts by type and recent places ---- */
const SHORTCUTS = [
  ["fuel", "Postos"], ["pharmacy", "Farmácias"], ["hospital", "Hospitais"], ["clinic", "Saúde"],
  ["food", "Mercados"], ["police", "Polícia"], ["water", "Água"], ["shelter", "Abrigos"],
];
function savedPlace(key) { return store.get("place." + key, null); }
function setSavedPlace(key, p) { store.set("place." + key, p); toast(key === "home" ? "Casa salva" : "Trabalho salvo"); }
function addRecent(p) {
  const list = store.get("recents", []).filter((r) => !(Math.abs(r.lon - p.lon) < 1e-5 && Math.abs(r.lat - p.lat) < 1e-5));
  list.unshift({ name: p.name, sub: p.sub || "", lon: p.lon, lat: p.lat });
  store.set("recents", list.slice(0, 12));
}

function showSearchHome() {
  const box = $("search-results");
  const rows = [];
  const fav = (key, label, ico) => {
    const p = savedPlace(key);
    return p
      ? el("button", { class: "result", onclick: () => { box.classList.add("hidden"); $("search-input").blur(); chooseDestination(p.lon, p.lat, label, p.name); } },
          el("span", { class: "ico" }, ico), el("span", { class: "grow" }, el("b", {}, label), el("small", {}, p.name || "")))
      : el("div", { class: "result" }, el("span", { class: "ico" }, ico),
          el("span", { class: "grow" }, el("b", {}, label), el("small", {}, "Segure um lugar no mapa para definir")));
  };
  rows.push(el("div", { class: "fav-row" }, fav("home", "Casa", "⌂"), fav("work", "Trabalho", "▤")));
  rows.push(el("div", { class: "chips" }, SHORTCUTS.map(([cat, label]) =>
    el("button", { class: "chip", onclick: () => showNearest(cat, label) }, el("span", {}, POI[cat]?.letter || "•"), label))));
  const recents = store.get("recents", []);
  if (recents.length) {
    rows.push(el("div", { class: "result note" }, "Recentes"));
    for (const r of recents) rows.push(resultRow("↺", r.name, r.sub, r.lon, r.lat));
    rows.push(el("button", { class: "result note link", onclick: () => { store.set("recents", []); showSearchHome(); } }, "Limpar recentes"));
  }
  box.replaceChildren(...rows);
  box.classList.remove("hidden");
}

async function showNearest(cat, label) {
  const box = $("search-results");
  const S = await loadSearch();
  const ref = me || { lon: map.getCenter().lng, lat: map.getCenter().lat };
  const list = S.pois.filter((p) => p.cat === cat)
    .map((p) => ({ ...p, d: geo.distance(ref.lon, ref.lat, p.lon, p.lat) }))
    .sort((a, b) => a.d - b.d).slice(0, 25);
  const rows = [el("button", { class: "result note link", onclick: showSearchHome }, "← " + label + (me ? " perto de você" : " perto do centro do mapa"))];
  if (!list.length) rows.push(el("div", { class: "result" }, "Nenhum encontrado nos mapas baixados."));
  for (const p of list) {
    const b = geo.bearing(ref.lon, ref.lat, p.lon, p.lat);
    rows.push(resultRow(POI[cat]?.letter || "•", p.name || POI[cat].label, `${POI[cat].label} · ${Math.round(b)}° ${geo.cardinal(b)}`, p.lon, p.lat, true));
  }
  box.replaceChildren(...rows);
  box.classList.remove("hidden");
  if (list.length) {
    const bb = new maplibregl.LngLatBounds([ref.lon, ref.lat], [ref.lon, ref.lat]);
    for (const p of list.slice(0, 8)) bb.extend([p.lon, p.lat]);
    map.fitBounds(bb, { padding: { top: 80, bottom: Math.round(innerHeight * 0.5), left: 40, right: 40 }, maxZoom: 16, duration: settings.reduceMotion ? 0 : 700 });
  }
}

/* ---- offline 3D view of a place: tilted, slowly orbiting ---- */
let orbit = null;
function view3D(lon, lat) {
  stopOrbit();
  setFollowing(false);
  map.flyTo({ center: [lon, lat], zoom: 16.8, pitch: 62, bearing: map.getBearing(), duration: settings.reduceMotion ? 0 : 1600 });
  if (settings.reduceMotion) return;
  map.once("moveend", () => {
    let last = performance.now();
    const step = (t) => {
      if (!orbit) return;
      map.setBearing((map.getBearing() + ((t - last) / 1000) * 6) % 360); // 6° per second
      last = t;
      orbit = requestAnimationFrame(step);
    };
    orbit = requestAnimationFrame(step);
  });
  orbit = -1;
}
function stopOrbit() { if (orbit && orbit > 0) cancelAnimationFrame(orbit); orbit = null; }

// ---------------------------------------------------------------- map
function currentTheme() {
  if (settings.theme !== "auto") return settings.theme;
  const ref = me || (map ? { lon: map.getCenter().lng, lat: map.getCenter().lat } : { lon: -47.9, lat: -15.8 });
  const t = geo.sunTimes(new Date(), ref.lat, ref.lon);
  if (!t) return "day";
  const now = Date.now();
  return now > t.sunrise.getTime() + 15 * 60000 && now < t.sunset.getTime() - 15 * 60000 ? "day" : "night";
}

let appliedTheme = null;
function applyStyle(force) {
  const theme = currentTheme();
  if (!force && theme === appliedTheme) return;
  appliedTheme = theme;
  document.body.classList.toggle("night", theme === "night");
  const mono = settings.colors !== "color";
  document.body.classList.toggle("mono", mono);
  const mapTheme = mono ? (theme === "night" ? "monoNight" : "monoDay") : theme;
  const style = buildStyle({ theme: mapTheme, origin: ORIGIN, terrain: settings.terrain, buildings3d: settings.buildings3d, exaggeration: settings.terrainExaggeration, attribution: ATTRIBUTION });
  map.setStyle(style, { diff: false });
  map.once("style.load", addOverlayLayers);
}

function addOverlayLayers() {
  const empty = { type: "FeatureCollection", features: [] };
  const add = (id, src) => { if (!map.getSource(id)) map.addSource(id, src); };
  add("pois", { type: "geojson", data: poiGeoJSON() });
  add("route", { type: "geojson", data: empty, lineMetrics: false });
  add("route-flags", { type: "geojson", data: empty });
  add("breadcrumbs", { type: "geojson", data: trackGeoJSON() });
  add("straight", { type: "geojson", data: empty });
  add("accuracy", { type: "geojson", data: empty });
  add("waypoints", { type: "geojson", data: waypointGeoJSON() });
  const night = appliedTheme === "night";
  const mono = settings.colors !== "color";
  const ROUTE = mono ? (night ? "#ffffff" : "#000000") : "#0b4fc4";
  map.addLayer({ id: "accuracy", type: "fill", source: "accuracy", paint: { "fill-color": mono ? (night ? "#ffffff" : "#000000") : "#1a6dff", "fill-opacity": 0.12 } });
  map.addLayer({ id: "breadcrumbs", type: "line", source: "breadcrumbs", paint: { "line-color": mono ? (night ? "#ffffff" : "#000000") : "#8a5cf6", "line-width": 3, "line-dasharray": [1, 1.5] } });
  map.addLayer({ id: "route-case", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": mono ? (night ? "#000000" : "#ffffff") : (night ? "#ffffff" : "#000000"), "line-width": ["interpolate", ["linear"], ["zoom"], 8, 8.5, 16, 18] } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ROUTE, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 16, 11] } });
  map.addLayer({
    id: "route-flags", type: "line", source: "route-flags", layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      // Colour-blind safe: orange vs. black differ in lightness and dash pattern, not just hue.
      "line-color": mono
        ? ["match", ["get", "kind"], "unpaved", night ? "#000000" : "#ffffff", "unknown", "#9a9a9a", night ? "#000000" : "#ffffff"]
        : ["match", ["get", "kind"], "unpaved", "#ff8c1a", "unknown", "#ffd29c", "#000000"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 16, 9], "line-dasharray": [1.2, 1],
    },
  });
  map.addLayer({ id: "straight", type: "line", source: "straight", paint: { "line-color": mono ? (night ? "#ffffff" : "#000000") : "#ff6a00", "line-width": 3, "line-dasharray": [2, 2] } });
  map.addLayer({
    id: "pois", type: "circle", source: "pois", minzoom: 11,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 6, 16, 13],
      "circle-color": mono ? (night ? "#ffffff" : "#000000") : ["match", ["get", "cat"], ...Object.entries(POI).flatMap(([k, v]) => [k, v.color]), "#888"],
      "circle-stroke-color": mono && night ? "#000" : (mono ? "#fff" : "#000"), "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "pois-letter", type: "symbol", source: "pois", minzoom: 12.5,
    layout: { "text-field": ["get", "letter"], "text-font": ["Noto Sans Bold"], "text-size": 14, "text-allow-overlap": true },
    paint: { "text-color": mono && night ? "#000000" : "#ffffff" },
  });
  map.addLayer({
    id: "pois-name", type: "symbol", source: "pois", minzoom: 15,
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-offset": [0, 1.4], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": night ? "#ffffff" : "#000000", "text-halo-color": night ? "#000000" : "#ffffff", "text-halo-width": 2 },
  });
  map.addLayer({ id: "waypoints", type: "circle", source: "waypoints", paint: { "circle-radius": 8, "circle-color": mono ? (night ? "#ffffff" : "#000000") : "#ff6a00", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 } });
  map.addLayer({
    id: "waypoints-name", type: "symbol", source: "waypoints",
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1.3], "text-anchor": "top" },
    paint: { "text-color": night ? "#ffffff" : "#0d2440", "text-halo-color": night ? "#0c1828" : "#ffffff", "text-halo-width": 1.6 },
  });
  if (currentRoute) drawRoute(currentRoute);
  updateStraightLine();
  setPoiVisibility();
}

function poiGeoJSON() {
  return {
    type: "FeatureCollection",
    features: (searchData?.pois || []).map((p) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { cat: p.cat, name: p.name || "", letter: POI[p.cat]?.letter || "" },
    })),
  };
}

async function initMap() {
  maplibregl.setWorkerUrl(await blobWorker("vendor/maplibre-gl-worker.mjs"));
  registerProtocol();
  const last = store.get("view", { center: [-54, -15], zoom: 2.6 });
  map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0c1828" } }] },
    center: last.center, zoom: last.zoom, pitch: 0, maxPitch: 75,
    attributionControl: { compact: true },
    fadeDuration: 150,
  });
  applyStyle(true);
  map.once("load", () => document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
  map.on("moveend", () => {
    const c = map.getCenter();
    store.set("view", { center: [c.lng, c.lat], zoom: map.getZoom() });
    updateAgeBanner();
  });
  map.on("rotate", () => {
    $("compass-needle").style.transform = `rotate(${-90 - map.getBearing()}deg)`;
    $("btn-compass").classList.toggle("hidden", Math.abs(map.getBearing()) < 1);
  });
  map.on("dragstart", () => { setFollowing(false); stopOrbit(); });
  map.on("touchstart", () => stopOrbit());
  map.on("mousedown", () => stopOrbit());
  map.on("contextmenu", (e) => pointSheet(e.lngLat.lng, e.lngLat.lat));
  map.on("click", (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ["pois", "waypoints"].filter((l) => map.getLayer(l)) })[0];
    if (f) {
      const [lon, lat] = f.geometry.coordinates;
      if (f.layer.id === "waypoints") pointSheet(lon, lat, f.properties.name);
      else pointSheet(lon, lat, f.properties.name || POI[f.properties.cat]?.label, POI[f.properties.cat]?.label);
    }
  });
  // Long-press for touch devices
  let pressTimer = null;
  map.on("touchstart", (e) => {
    if (e.originalEvent.touches.length !== 1) return;
    pressTimer = setTimeout(() => pointSheet(e.lngLat.lng, e.lngLat.lat), 600);
  });
  for (const ev of ["touchend", "touchmove", "touchcancel", "movestart"]) map.on(ev, () => clearTimeout(pressTimer));
  setInterval(() => applyStyle(false), 5 * 60000);
}

// ---------------------------------------------------------------- location
const meMarkerEl = el("div", { class: "me" }, el("div", { class: "cone" }), el("div", { class: "dot" }));
let meMarker = null;

function startGPS() {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.watchPosition(onFix, (err) => {
    if (err.code === 1) toast("Permita o acesso à localização para navegar.");
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

function onFix(pos) {
  const c = pos.coords;
  const prev = me;
  me = { lon: c.longitude, lat: c.latitude, acc: c.accuracy, alt: c.altitude, heading: c.heading, speed: c.speed, t: pos.timestamp };
  if ((me.heading == null || Number.isNaN(me.heading)) && prev && geo.distance(prev.lon, prev.lat, me.lon, me.lat) > 4) {
    me.heading = geo.bearing(prev.lon, prev.lat, me.lon, me.lat);
  }
  if (!meMarker) {
    meMarker = new maplibregl.Marker({ element: meMarkerEl, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([me.lon, me.lat]).addTo(map);
    if (following) map.jumpTo({ center: [me.lon, me.lat], zoom: Math.max(map.getZoom(), 14) });
  }
  meMarker.setLngLat([me.lon, me.lat]);
  updateHeadingMarker();
  const acc = map.getSource("accuracy");
  if (acc) acc.setData(circle(me.lon, me.lat, Math.min(me.acc || 0, 2000)));
  recordTrack();
  if (nav) navUpdate();
  else if (following) map.easeTo({ center: [me.lon, me.lat], duration: settings.reduceMotion ? 0 : 600 });
  updateStraightLine();
  if ($("sheet").dataset.key === "survival") renderSurvivalLive();
}

function bestHeading() {
  if (me && me.speed > 2 && me.heading != null && !Number.isNaN(me.heading)) return me.heading;
  return deviceHeading;
}
function updateHeadingMarker() {
  if (!meMarker) return;
  const h = bestHeading();
  meMarkerEl.querySelector(".cone").style.display = h == null || nav ? "none" : "block";
  meMarker.setRotation(h == null ? 0 : h);
  meMarkerEl.classList.toggle("nav", !!nav);
}

function circle(lon, lat, r) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push([lon + (r * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.cos(a)) / 110540]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [pts] }, properties: {} };
}

function startCompass() {
  const handler = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
    if (h == null) return;
    const so = (screen.orientation && screen.orientation.angle) || 0;
    deviceHeading = (h + so) % 360;
    updateHeadingMarker();
    if ($("sheet").dataset.key === "survival") renderCompass();
  };
  window.addEventListener("deviceorientationabsolute", handler, true);
  window.addEventListener("deviceorientation", (e) => { if (e.webkitCompassHeading != null) handler(e); }, true);
}

function setFollowing(on) {
  following = on;
  $("btn-locate").classList.toggle("following", on);
}

// ---------------------------------------------------------------- track (breadcrumbs)
let track = store.get("track", { on: false, points: [] });
function recordTrack() {
  if (!track.on || !me || me.acc > 50) return;
  const last = track.points[track.points.length - 1];
  if (last && geo.distance(last[0], last[1], me.lon, me.lat) < (settings.trackSpacing || 15)) return;
  track.points.push([+me.lon.toFixed(6), +me.lat.toFixed(6), Date.now()]);
  if (track.points.length % 5 === 0) store.set("track", track);
  const s = map.getSource("breadcrumbs");
  if (s) s.setData(trackGeoJSON());
}
function trackGeoJSON() {
  return { type: "Feature", geometry: { type: "LineString", coordinates: track.points.map((p) => [p[0], p[1]]) }, properties: {} };
}
function trackLength() {
  let d = 0;
  for (let i = 1; i < track.points.length; i++) d += geo.distance(track.points[i - 1][0], track.points[i - 1][1], track.points[i][0], track.points[i][1]);
  return d;
}

// ---------------------------------------------------------------- waypoints
let waypoints = store.get("waypoints", []);
function saveWaypoints() {
  store.set("waypoints", waypoints);
  const s = map.getSource("waypoints");
  if (s) s.setData(waypointGeoJSON());
}
function waypointGeoJSON() {
  return { type: "FeatureCollection", features: waypoints.map((w) => ({ type: "Feature", geometry: { type: "Point", coordinates: [w.lon, w.lat] }, properties: { name: w.name } })) };
}
function addWaypoint(lon, lat, name) {
  waypoints.push({ id: Date.now(), name: name || `Ponto ${waypoints.length + 1}`, lon, lat, created: new Date().toISOString() });
  saveWaypoints();
  toast("Ponto salvo");
}

// ---------------------------------------------------------------- point sheet / destination
async function pointSheet(lon, lat, title, subtitle) {
  const d = me ? geo.distance(me.lon, me.lat, lon, lat) : null;
  const b = me ? geo.bearing(me.lon, me.lat, lon, lat) : null;
  const elev = el("span", {}, "…");
  const content = el("div", {},
    el("h2", {}, title || "Ponto no mapa"),
    subtitle ? el("p", { class: "muted" }, subtitle) : null,
    el("div", { class: "grid2" },
      el("div", { class: "tile" }, el("div", { class: "k" }, "Coordenadas"), el("div", { class: "v", style: "font-size:16px;white-space:pre-line" }, fmtCoords(lat, lon))),
      el("div", { class: "tile" }, el("div", { class: "k" }, "Altitude do terreno"), el("div", { class: "v" }, elev)),
      d != null ? el("div", { class: "tile" }, el("div", { class: "k" }, "Em linha reta"), el("div", { class: "v" }, geo.formatDistance(d))) : null,
      b != null ? el("div", { class: "tile" }, el("div", { class: "k" }, "Direção"), el("div", { class: "v" }, `${Math.round(b)}° ${geo.cardinal(b)}`)) : null,
    ),
    el("div", { class: "row wrap", style: "margin-top:14px" },
      el("button", { "data-icon": "➤", class: "btn orange", onclick: () => chooseDestination(lon, lat, title || "Ponto no mapa", subtitle, true) }, "Rota até aqui"),
      el("button", { "data-icon": "◈", class: "btn ghost", onclick: () => view3D(lon, lat) }, "Ver em 3D"),
      el("button", { "data-icon": "⌂", class: "btn ghost", onclick: () => setSavedPlace("home", { name: title || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lon, lat }) }, "Casa"),
      el("button", { "data-icon": "▤", class: "btn ghost", onclick: () => setSavedPlace("work", { name: title || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lon, lat }) }, "Trabalho"),
      el("button", { "data-icon": "⚑", class: "btn ghost", onclick: () => { addWaypoint(lon, lat, title); closeSheet(); } }, "Salvar ponto"),
      el("button", { "data-icon": "↗", class: "btn ghost", onclick: () => followStraight({ lon, lat, name: title || "Ponto" }) }, "Linha reta"),
    ),
  );
  openSheet(content, "point");
  const h = await elevationAt(lon, lat).catch(() => null);
  elev.textContent = h == null ? "sem dado" : `${Math.round(h)} m`;
}

function chooseDestination(lon, lat, name, sub, immediate) {
  destination = { lon, lat, name, sub };
  stopOrbit();
  addRecent(destination);
  if (!destMarker) destMarker = new maplibregl.Marker({ element: el("div", { class: "pin" }), anchor: "bottom" });
  destMarker.setLngLat([lon, lat]).addTo(map);
  setFollowing(false);
  if (!immediate) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 14) });
  planRoute();
}
let destMarker = null;

function routeOptions() {
  return { avoidUnpaved: settings.avoidUnpaved, ferry: settings.ferry, offroad: settings.offroad, avoidTolls: settings.avoidTolls };
}

async function planRoute() {
  if (!destination) return;
  const from = me ? [me.lon, me.lat] : null;
  const head = el("div", {}, el("h2", {}, destination.name || "Destino"), destination.sub ? el("p", { class: "muted" }, destination.sub) : null);
  if (!from) {
    openSheet(el("div", {}, head,
      el("p", {}, "Aguardando sinal de GPS para calcular a rota a partir de onde você está."),
      el("div", { class: "row wrap" },
        el("button", { "data-icon": "◎", class: "btn ghost", onclick: () => planRouteFrom([map.getCenter().lng, map.getCenter().lat]) }, "Calcular a partir do centro do mapa"),
        el("button", { "data-icon": "↗", class: "btn ghost", onclick: () => followStraight(destination) }, "Linha reta"),
      )), "route");
    return;
  }
  planRouteFrom(from);
}

async function planRouteFrom(from) {
  openSheet(el("div", {}, el("h2", {}, destination.name || "Destino"), el("p", { class: "muted" }, "Calculando rota offline…")), "route");
  if (!packSet.length) { openSheet(noMapsContent(), "route"); return; }
  await routerReady;
  const res = await routerCall({ type: "route", from, to: [destination.lon, destination.lat], options: routeOptions() });
  if (!res.ok) {
    openSheet(el("div", {},
      el("h2", {}, "Sem rota"),
      el("p", {}, res.error),
      el("p", { class: "muted" }, "Dica: verifique se o mapa da região está baixado, ou libere estradas de terra / balsas em Ajustes, se for seguro."),
      el("div", { class: "row wrap" }, el("button", { "data-icon": "↗", class: "btn ghost", onclick: () => followStraight(destination) }, "Seguir em linha reta"))), "route");
    return;
  }
  currentRoute = res.route;
  currentRoute.from = from;
  drawRoute(currentRoute);
  const b = new maplibregl.LngLatBounds();
  for (const c of currentRoute.coords) b.extend(c);
  map.fitBounds(b, { padding: { top: 110, bottom: Math.round(innerHeight * 0.42), left: 50, right: 50 }, pitch: 0, bearing: 0, duration: settings.reduceMotion ? 0 : 800 });
  openSheet(routeSummary(currentRoute), "route", true);
}

function routeWarnings(r) {
  const w = [];
  const km = (m) => geo.formatDistance(m);
  if (r.snapFrom > 300) w.push(["red", `Você está a ${km(r.snapFrom)} da estrada mapeada mais próxima. Siga com cuidado até ela.`]);
  if (r.snapTo > 300) w.push(["red", `O destino fica a ${km(r.snapTo)} da estrada mais próxima. O trecho final não tem rota.`]);
  if (r.warn.private > 0) w.push(["red", `Passa por via particular ou de acesso restrito (${km(r.warn.private)}). Pode estar fechada.`]);
  if (r.warn.ford > 0) w.push(["red", `Atravessa ${r.warn.ford} vau (passagem dentro de rio). Nunca atravesse água com correnteza ou de profundidade desconhecida.`]);
  if (r.warn.ferry > 0) w.push(["", `Inclui ${r.warn.ferry} travessia de balsa. Confirme horários: o app não sabe se ela está operando.`]);
  if (r.warn.unpaved > 0) w.push(["", `${km(r.warn.unpaved)} de estrada de terra. Com chuva pode ficar intransitável.`]);
  if (r.warn.track > 0) w.push(["red", `${km(r.warn.track)} de trilha / estrada rural precária. Só veículo apropriado.`]);
  if (r.warn.unknown > 1000) w.push(["", `${km(r.warn.unknown)} sem informação de pavimento. Pode ser terra.`]);
  if (r.warn.toll > 0) w.push(["", "A rota tem pedágio."]);
  return w;
}

function routeSummary(r) {
  const warnings = routeWarnings(r);
  const age = oldestDataAge();
  if (age != null && age > (settings.staleDays || 30)) warnings.unshift([age > 90 ? "red" : "", `Mapa com dados de ${age} dias atrás. Obras, bloqueios e mudanças recentes não aparecem.`]);
  const serious = warnings.filter(([c]) => c === "red").length;
  return el("div", {},
    el("h2", {}, destination?.name || "Rota"),
    el("div", { class: "summary" }, el("span", { class: "big" }, geo.formatDuration(r.time)), el("span", {}, geo.formatDistance(r.distance)),
      el("span", { class: "muted" }, "chegada " + new Date(Date.now() + r.time * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }))),
    // Safety warnings are never hidden: in the small sheet they show as one tappable line.
    warnings.length
      ? el("button", { class: "peek-more warn" + (serious ? " red" : ""), style: "width:100%;text-align:left" },
          `${warnings.length} ${warnings.length > 1 ? "alertas" : "alerta"} nesta rota. Toque para ver.`)
      : el("p", {}, el("span", { class: "badge green" }, "Sem alertas de segurança na rota")),
    el("div", { class: "row wrap" },
      el("button", { "data-icon": "➤", class: "btn orange", onclick: startNavigation }, "Iniciar"),
      el("button", { "data-icon": "☰", class: "btn ghost peek-hide", onclick: () => openSheet(stepsList(r), "route") }, "Passo a passo"),
      el("button", { "data-icon": "◈", class: "btn ghost peek-hide", onclick: () => view3D(destination.lon, destination.lat) }, "Ver o destino em 3D"),
      el("button", { "data-icon": "✕", class: "btn ghost peek-hide", onclick: clearRoute }, "Cancelar"),
    ),
    warnings.length ? el("div", { class: "warn-list peek-hide" }, warnings.map(([cls, t]) => el("div", { class: "warn " + cls }, t))) : null,
    el("p", { class: "muted peek-hide", style: "font-size:15px" }, "Tempo estimado sem trânsito (o app é offline e não sabe do trânsito em tempo real)."),
  );
}

function stepsList(r) {
  return el("div", {},
    el("h2", {}, "Passo a passo"),
    r.steps.map((s) => el("div", { class: "list-item" }, el("span", { class: "badge orange" }, arrowFor(s)), el("div", { class: "grow" }, el("b", {}, s.text), el("small", {}, s.distance ? geo.formatDistance(s.distance) : "")))),
    el("button", { "data-icon": "←", class: "btn ghost", style: "margin-top:10px", onclick: () => openSheet(routeSummary(r), "route") }, "Voltar"),
  );
}

function drawRoute(r) {
  const src = map.getSource("route");
  if (!src) return;
  src.setData({ type: "Feature", geometry: { type: "LineString", coordinates: r.coords }, properties: {} });
  map.getSource("route-flags").setData({
    type: "FeatureCollection",
    features: r.flagged.map(([a, b, kind]) => ({ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: r.coords.slice(a, b + 1) } })),
  });
}

function clearRoute() {
  currentRoute = null;
  destination = null;
  if (destMarker) destMarker.remove();
  const empty = { type: "FeatureCollection", features: [] };
  map.getSource("route")?.setData(empty);
  map.getSource("route-flags")?.setData(empty);
  closeSheet();
}

function noMapsContent() {
  return el("div", {}, el("h2", {}, "Nenhum mapa baixado"),
    el("p", {}, "Baixe o mapa do seu estado enquanto tiver internet. Depois tudo funciona sem sinal."),
    el("button", { "data-icon": "⬇", class: "btn orange", onclick: () => openPanel("packs") }, "Baixar mapas"));
}

// ---------------------------------------------------------------- navigation
function arrowFor(s) {
  if (s.type === "arrive") return "◉";
  if (s.type === "roundabout") return "⟳";
  if (s.type === "ferry") return "⛴";
  return { right: "↱", left: "↰", "slight-right": "↗", "slight-left": "↖", uturn: "⤺", straight: "↑" }[s.mod] || "↑";
}

function startNavigation() {
  if (!currentRoute) return;
  nav = { route: currentRoute, idx: 0, offCount: 0, announced: {}, lastReroute: 0 };
  document.body.classList.add("navigating");
  closeSheet();
  requestAnimationFrame(layoutSheet);
  ["nav-card", "nav-footer", "nav-safety"].forEach((id) => $(id).classList.remove("hidden"));
  if (settings.keepScreenOn) native.keepScreenOn(true);
  setFollowing(true);
  map.setPitch(settings.terrain ? 58 : 45);
  say("Iniciando rota. Siga sempre as placas e a sinalização de trânsito.");
  setTimeout(() => $("nav-safety").classList.add("hidden"), 12000);
  navUpdate();
}

function stopNavigation(arrived) {
  nav = null;
  document.body.classList.remove("navigating");
  requestAnimationFrame(layoutSheet);
  ["nav-card", "nav-footer", "nav-safety"].forEach((id) => $(id).classList.add("hidden"));
  native.keepScreenOn(false);
  map.easeTo({ pitch: 0, bearing: 0 });
  updateHeadingMarker();
  if (arrived) { say("Você chegou ao destino."); toast("Você chegou!"); clearRoute(); }
}

function say(text) { if (settings.voice) native.speak(text); }

/** Find the closest point on the route near the last known index. */
function locateOnRoute(r, lon, lat, fromIdx) {
  let best = { d: Infinity, i: fromIdx, t: 0 };
  const end = Math.min(r.coords.length - 1, fromIdx + 400);
  for (let i = Math.max(0, fromIdx - 5); i < end; i++) {
    const a = r.coords[i], b = r.coords[i + 1];
    const { d, t } = geo.pointSegmentDistance(lon, lat, a[0], a[1], b[0], b[1]);
    if (d < best.d) best = { d, i, t };
  }
  const segLen = r.cum[best.i + 1] - r.cum[best.i];
  best.along = r.cum[best.i] + best.t * segLen;
  return best;
}

async function navUpdate() {
  if (!nav || !me) return;
  const r = nav.route;
  const pos = locateOnRoute(r, me.lon, me.lat, nav.idx);
  nav.idx = pos.i;
  const offLimit = Math.max(45, Math.min(me.acc || 0, 80) + 25);
  if (pos.d > offLimit) nav.offCount++;
  else nav.offCount = 0;
  if (nav.offCount >= 3 && Date.now() - nav.lastReroute > 8000) {
    nav.lastReroute = Date.now();
    nav.offCount = 0;
    toast("Fora da rota. Recalculando…");
    say("Recalculando.");
    const res = await routerCall({ type: "route", from: [me.lon, me.lat], to: [destination.lon, destination.lat], options: routeOptions() });
    if (res.ok && nav) {
      currentRoute = res.route;
      nav.route = currentRoute;
      nav.idx = 0;
      nav.announced = {};
      drawRoute(currentRoute);
      return navUpdate();
    }
    return;
  }
  // Next maneuver
  const steps = r.steps;
  let next = steps.find((s) => s.at > pos.along + 3) || steps[steps.length - 1];
  const toNext = Math.max(0, next.at - pos.along);
  const remaining = Math.max(0, r.distance - pos.along);
  $("nav-arrow").textContent = arrowFor(next);
  $("nav-dist").textContent = geo.formatDistance(toNext);
  $("nav-instr").textContent = next.text;
  // keep the safety reminder just below the instruction card, whatever its height
  const cr = $("nav-card").getBoundingClientRect();
  $("nav-safety").style.top = Math.round(cr.bottom / Number(settings.textScale || 1) + 8) + "px";
  const remainingTime = r.time * (remaining / Math.max(1, r.distance));
  $("nav-eta").textContent = new Date(Date.now() + remainingTime * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  $("nav-remaining").textContent = `${geo.formatDuration(remainingTime)} · ${geo.formatDistance(remaining)}`;
  // Voice prompts at ~600 m, ~150 m and at the maneuver
  const key = steps.indexOf(next);
  const a = (nav.announced[key] = nav.announced[key] || {});
  const speedish = Math.max(me.speed || 0, 8);
  if (next.type === "arrive" && toNext < 25) return stopNavigation(true);
  if (toNext < 600 && toNext > 250 && !a.far && speedish > 12) { a.far = true; say(`Em ${geo.formatDistance(toNext)}, ${next.text}`); }
  else if (toNext < 160 && toNext > 40 && !a.near) { a.near = true; say(`Em ${geo.formatDistance(toNext)}, ${next.text}`); }
  else if (toNext <= 40 && !a.now) { a.now = true; say(next.text); if (settings.vibrate) native.vibrate(120); }
  if (following) {
    const h = me.heading != null && me.speed > 1.5 ? me.heading : geo.bearing(r.coords[pos.i][0], r.coords[pos.i][1], r.coords[Math.min(pos.i + 1, r.coords.length - 1)][0], r.coords[Math.min(pos.i + 1, r.coords.length - 1)][1]);
    const zoom = me.speed > 22 ? 15 : me.speed > 12 ? 16 : 16.8;
    map.easeTo({ center: [me.lon, me.lat], bearing: settings.northUp ? 0 : h, zoom, pitch: settings.northUp ? 0 : settings.terrain ? 58 : 45, padding: { top: Math.round(innerHeight * 0.35), bottom: 60 }, duration: settings.reduceMotion ? 0 : 900 });
  }
}

// ---------------------------------------------------------------- straight-line guidance (off-road)
function followStraight(target) {
  straightTarget = target;
  updateStraightLine();
  closeSheet();
  openPanel("survival");
  toast("Linha reta: use a bússola para seguir a direção");
}
function updateStraightLine() {
  const s = map?.getSource("straight");
  if (!s) return;
  if (!straightTarget || !me) { s.setData({ type: "FeatureCollection", features: [] }); return; }
  s.setData({ type: "Feature", geometry: { type: "LineString", coordinates: [[me.lon, me.lat], [straightTarget.lon, straightTarget.lat]] }, properties: {} });
}

// ---------------------------------------------------------------- data age
function oldestDataAge() {
  if (!packSet.length || !map) return null;
  const c = map.getCenter();
  const here = packSet.filter((p) => c.lng >= p.bbox[0] && c.lng <= p.bbox[2] && c.lat >= p.bbox[1] && c.lat <= p.bbox[3]);
  const ages = (here.length ? here : packSet).map((p) => daysSince(installed[p.uf]?.meta?.date)).filter((x) => x != null);
  return ages.length ? Math.max(...ages) : null;
}
function updateAgeBanner() {
  const b = $("age-banner");
  if (!packSet.length) {
    b.textContent = "Nenhum mapa offline baixado. Toque em “Mapas” para baixar o seu estado.";
    b.className = "";
    return;
  }
  const age = oldestDataAge();
  if (age == null || age <= (settings.staleDays || 30)) { b.className = "hidden"; return; }
  b.textContent = age > 90
    ? `Mapa muito desatualizado (${age} dias). Atualize assim que tiver internet.`
    : `Mapa com ${age} dias. Atualize quando tiver internet.`;
  b.className = age > 90 ? "bad" : "";
}

// ---------------------------------------------------------------- panels
function openPanel(name) {
  if ($("sheet").dataset.key === name) return closeSheet();
  ({ packs: renderPacks, points: renderPoints, survival: renderSurvival, settings: renderSettings })[name]();
}

async function fetchManifest() {
  const cfg = native.getConfig();
  try {
    const txt = await native.fetchText(cfg.packsBaseUrl + "manifest.json");
    manifest = JSON.parse(txt);
    store.set("manifest", manifest);
    return true;
  } catch (e) {
    if ($("sheet").dataset.key === "packs") toast("Sem internet ou mapas ainda não publicados.");
    return false;
  }
}

function renderPacks() {
  const cfg = native.getConfig();
  const list = el("div", {});
  const sorted = [...STATES].sort((a, b) => (installed[b.uf] ? 1 : 0) - (installed[a.uf] ? 1 : 0) || a.name.localeCompare(b.name));
  for (const st of sorted) {
    const inst = installed[st.uf];
    const remote = manifest?.states?.[st.uf];
    const dl = downloads[st.uf];
    const size = remote ? remote.files.reduce((s, f) => s + (f.size || 0), 0) : 0;
    const age = inst ? daysSince(inst.meta?.date) : null;
    const updateAvailable = inst && remote && remote.date && inst.meta?.date !== remote.date;
    const info = [];
    if (inst) info.push(el("span", { class: "badge " + (age > 90 ? "red" : age > 30 ? "orange" : "green") }, `dados de ${fmtDate(inst.meta?.date)}`));
    if (updateAvailable) info.push(" ", el("span", { class: "badge orange" }, "atualização disponível"));
    if (!inst && remote) info.push(el("small", {}, fmtBytes(size)));
    const actions = [];
    if (dl) {
      actions.push(el("button", { "data-icon": "■", class: "btn small ghost", onclick: () => { native.cancelDownload(st.uf); delete downloads[st.uf]; renderPacks(); } }, "Parar"));
    } else {
      if (remote && (!inst || updateAvailable)) {
        actions.push(el("button", { "data-icon": "⬇", class: "btn small orange", onclick: () => startDownload(st.uf) }, inst ? "Atualizar" : "Baixar"));
      }
      if (inst) actions.push(el("button", { "data-icon": "✕", class: "btn small ghost", onclick: () => removePack(st.uf) }, "Apagar"));
    }
    list.append(el("div", { class: "list-item" },
      el("div", { class: "grow" }, el("b", {}, `${st.name} (${st.uf.toUpperCase()})`), el("div", {}, info),
        dl ? el("div", { class: "progress" }, el("i", { style: `width:${Math.round((dl.done / Math.max(1, dl.total)) * 100)}%` })) : null),
      actions));
  }
  openSheet(el("div", {},
    el("h2", {}, "Mapas offline"),
    el("p", { class: "muted" }, "Baixe com Wi-Fi. Cada estado inclui mapa, relevo 3D, rotas e busca. Mapas novos são gerados toda semana a partir do OpenStreetMap."),
    el("div", { class: "row wrap" },
      el("button", { "data-icon": "⟳", class: "btn small ghost", onclick: async () => { if (await fetchManifest()) renderPacks(); } }, manifest ? "Verificar atualizações" : "Carregar lista de mapas"),
      el("small", { class: "muted" }, `Espaço livre: ${fmtBytes(native.freeSpace())}`),
    ),
    manifest ? el("p", { class: "muted", style: "font-size:12px" }, `Lista de ${fmtDate(manifest.generated)}`) : el("p", { class: "muted", style: "font-size:13px" }, "Toque em “Carregar lista de mapas” com internet."),
    list,
    el("p", { class: "muted", style: "font-size:11px;margin-top:12px" }, "Fonte dos mapas: ", cfg.packsBaseUrl),
  ), "packs");
}

function startDownload(uf) {
  const remote = manifest.states[uf];
  const cfg = native.getConfig();
  const files = remote.files.map((f) => ({ name: f.name, size: f.size, url: cfg.packsBaseUrl + f.name }));
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  if (total > native.freeSpace() * 0.95) { toast("Espaço insuficiente no aparelho."); return; }
  if (settings.wifiOnly && !native.isWifi()) {
    toast("Conecte-se ao Wi-Fi para baixar (ou desligue “Baixar mapas só no Wi-Fi” em Ajustes).", 4500);
    return;
  }
  downloads[uf] = { done: 0, total };
  native.downloadPack(uf, files, { date: remote.date, uf, version: remote.version || 1 });
  renderPacks();
}

async function removePack(uf) {
  const st = STATES.find((s) => s.uf === uf);
  modal(el("div", {},
    el("h2", {}, `Apagar ${st.name}?`),
    el("p", {}, "Sem esse mapa, o app não mostra ruas nem calcula rotas nessa região até você baixar de novo (precisa de internet)."),
    el("div", { class: "row" }, el("button", { "data-icon": "✕", class: "btn danger", onclick: async () => { native.deletePack(uf); closeModal(); await reloadPacks(); renderPacks(); } }, "Apagar"),
      el("button", { "data-icon": "✕", class: "btn ghost", onclick: closeModal }, "Cancelar"))));
}

async function reloadPacks() {
  refreshInstalled();
  searchData = null;
  applyStyle(true);
  updateAgeBanner();
  await startRouter();
  loadSearch().then(() => map.getSource("pois")?.setData(poiGeoJSON()));
}

// Linux / Raspberry Pi: status of the USB GPS reported by voli.py
let gpsStatus = "";
native.on("gpsStatus", (d) => {
  gpsStatus = d.status ? "GPS: " + d.status : "";
  if ($("sheet").dataset.key === "survival") renderSurvivalLive();
});

native.on("progress", (d) => {
  downloads[d.uf] = { done: d.done, total: d.total };
  if ($("sheet").dataset.key === "packs") {
    const bars = document.querySelectorAll("#sheet .progress > i");
    // cheap refresh: re-render at most every 700 ms
    if (!renderPacks._t) renderPacks._t = setTimeout(() => { renderPacks._t = null; if ($("sheet").dataset.key === "packs") renderPacks(); }, 700);
  }
});
native.on("downloaded", async (d) => {
  delete downloads[d.uf];
  toast("Mapa baixado: " + d.uf.toUpperCase());
  await reloadPacks();
  if ($("sheet").dataset.key === "packs") renderPacks();
  const st = STATES.find((s) => s.uf === d.uf);
  if (st && !me) map.fitBounds([[st.bbox[0], st.bbox[1]], [st.bbox[2], st.bbox[3]]], { padding: 30 });
});
native.on("downloadError", (d) => {
  delete downloads[d.uf];
  toast("Falha no download: " + (d.message || "verifique a internet"), 4000);
  if ($("sheet").dataset.key === "packs") renderPacks();
});

function renderPoints() {
  const items = waypoints.map((w) => {
    const d = me ? geo.formatDistance(geo.distance(me.lon, me.lat, w.lon, w.lat)) : "";
    return el("div", { class: "list-item" },
      el("button", { class: "grow", style: "text-align:left", onclick: () => { map.flyTo({ center: [w.lon, w.lat], zoom: 15 }); pointSheet(w.lon, w.lat, w.name); } },
        el("b", {}, w.name), el("small", {}, [d, `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`].filter(Boolean).join(" · "))),
      el("button", { "data-icon": "✕", class: "btn small ghost", onclick: () => { waypoints = waypoints.filter((x) => x.id !== w.id); saveWaypoints(); renderPoints(); } }, "Apagar"));
  });
  const nameInput = el("input", { class: "text-input", placeholder: "Nome (ex.: Acampamento, Carro, Nascente)" });
  openSheet(el("div", {},
    el("h2", {}, "Meus pontos"),
    el("p", { class: "muted" }, "Salve onde você está para conseguir voltar depois, mesmo fora da estrada. Dica: toque e segure no mapa para salvar outro lugar."),
    el("div", { class: "row" }, nameInput, el("button", { class: "btn orange", onclick: () => {
      if (!me) return toast("Aguardando GPS…");
      addWaypoint(me.lon, me.lat, nameInput.value.trim());
      renderPoints();
    } }, "Salvar aqui")),
    items.length ? items : el("p", { class: "muted" }, "Nenhum ponto salvo ainda."),
  ), "points");
}

// Survival panel
function renderSurvival() {
  const content = el("div", {},
    el("h2", {}, "Sobrevivência"),
    el("div", { class: "row wrap" },
      el("button", { "data-icon": "✚", class: "btn danger", onclick: showSOS }, "SOS / Emergência"),
      el("button", { "data-icon": track.on ? "■" : "●", class: "btn ghost", onclick: () => { track.on = !track.on; store.set("track", track); renderSurvival(); } }, track.on ? "Parar trilha" : "Gravar trilha"),
      track.points.length ? el("button", { "data-icon": "↩", class: "btn ghost", onclick: backtrack }, "Voltar pela trilha") : null,
      straightTarget ? el("button", { "data-icon": "■", class: "btn ghost", onclick: () => { straightTarget = null; updateStraightLine(); renderSurvival(); } }, "Parar linha reta") : null,
    ),
    el("h3", {}, "Sua posição"),
    el("div", { id: "surv-live" }),
    el("h3", {}, "Bússola"),
    el("div", { class: "compass" },
      el("div", { class: "rose", id: "rose" },
        ["N", "L", "S", "O"].map((t, i) => el("span", { style: `transform: rotate(${i * 90}deg) translate(0, -80px) rotate(${-i * 90}deg) translate(-50%, -50%); color:${t === "N" ? "#d92d20" : "inherit"}` }, t))),
      el("div", { class: "target", id: "compass-target", style: "display:none" }),
      el("div", { class: "pointer" }),
      el("div", { class: "deg", id: "compass-deg" }, "—")),
    el("p", { class: "muted", style: "text-align:center;font-size:12px" }, "Afaste o celular de metais e ímãs. Se a bússola parecer errada, mova o celular em forma de 8."),
    el("h3", {}, "Mais perto de você"),
    el("div", { id: "nearby" }, el("p", { class: "muted" }, "Calculando…")),
  );
  openSheet(content, "survival");
  renderSurvivalLive();
  renderCompass();
  renderNearby();
}

function renderSurvivalLive() {
  const box = $("surv-live");
  if (!box) return;
  const tiles = [];
  if (me) {
    tiles.push(
      ["Latitude", settings.coordFormat === "decimal" ? me.lat.toFixed(6) : settings.coordFormat === "dms" ? geo.toDMS(me.lat, true) : `${me.lat.toFixed(6)}\n${geo.toDMS(me.lat, true)}`],
      ["Longitude", settings.coordFormat === "decimal" ? me.lon.toFixed(6) : settings.coordFormat === "dms" ? geo.toDMS(me.lon, false) : `${me.lon.toFixed(6)}\n${geo.toDMS(me.lon, false)}`],
      ["Precisão do GPS", `± ${Math.round(me.acc)} m`],
      ["Altitude (GPS)", me.alt != null ? `${Math.round(me.alt)} m` : "—"],
    );
    const sun = geo.sunTimes(new Date(), me.lat, me.lon);
    if (sun) {
      const hm = (d) => d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const now = Date.now();
      tiles.push(["Nascer / pôr do sol", `${hm(sun.sunrise)} / ${hm(sun.sunset)}`]);
      if (now < sun.sunrise.getTime()) tiles.push(["Ainda é noite", `amanhece em ${geo.formatDuration((sun.sunrise - now) / 1000)}`]);
      else if (now < sun.sunset.getTime()) tiles.push(["Luz do dia restante", geo.formatDuration((sun.sunset - now) / 1000)]);
      else tiles.push(["Já escureceu", `o sol se pôs às ${hm(sun.sunset)}`]);
    }
    if (track.on || track.points.length) tiles.push(["Trilha gravada", geo.formatDistance(trackLength())]);
    if (straightTarget) {
      tiles.push([`Até ${straightTarget.name}`, `${geo.formatDistance(geo.distance(me.lon, me.lat, straightTarget.lon, straightTarget.lat))} · ${Math.round(geo.bearing(me.lon, me.lat, straightTarget.lon, straightTarget.lat))}°`]);
    }
  } else {
    tiles.push(["GPS", gpsStatus ? `${gpsStatus}. Aguardando sinal… vá para um lugar aberto.` : "Aguardando sinal… vá para um lugar aberto."]);
  }
  box.replaceChildren(el("div", { class: "grid2" }, tiles.map(([k, v]) => el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v", style: "white-space:pre-line;font-size:15px" }, v)))));
}

function renderCompass() {
  const rose = $("rose");
  if (!rose) return;
  const h = deviceHeading;
  rose.style.transform = `rotate(${-(h || 0)}deg)`;
  $("compass-deg").textContent = h == null ? "sem sensor" : `${Math.round(h)}° ${geo.cardinal(h)}`;
  $("compass-deg").style.fontSize = h == null ? "14px" : "";
  const t = $("compass-target");
  if (straightTarget && me && h != null) {
    t.style.display = "block";
    t.style.transform = `rotate(${geo.bearing(me.lon, me.lat, straightTarget.lon, straightTarget.lat) - h}deg)`;
  } else t.style.display = "none";
}

async function renderNearby() {
  const box = $("nearby");
  if (!box) return;
  if (!me) { box.replaceChildren(el("p", { class: "muted" }, "Precisa do GPS.")); return; }
  const { pois } = await loadSearch();
  if (!pois.length) { box.replaceChildren(el("p", { class: "muted" }, "Baixe o mapa do seu estado para ver água, hospitais e postos próximos.")); return; }
  const groups = ["water", "hospital", "clinic", "pharmacy", "fuel", "police", "fire", "shelter", "food"];
  const out = [];
  for (const g of groups) {
    const near = pois.filter((p) => p.cat === g)
      .map((p) => ({ ...p, d: geo.distance(me.lon, me.lat, p.lon, p.lat) }))
      .sort((a, b) => a.d - b.d).slice(0, 2);
    if (!near.length) continue;
    for (const p of near) {
      const b = geo.bearing(me.lon, me.lat, p.lon, p.lat);
      out.push(el("div", { class: "list-item" },
        el("span", { class: "badge", style: `background:${POI[g].color};color:#fff` }, POI[g].letter),
        el("button", { class: "grow", style: "text-align:left", onclick: () => pointSheet(p.lon, p.lat, p.name || POI[g].label, POI[g].label) },
          el("b", {}, p.name || POI[g].label), el("small", {}, `${POI[g].label} · ${geo.formatDistance(p.d)} · ${Math.round(b)}° ${geo.cardinal(b)}`)),
      ));
    }
  }
  box.replaceChildren(...out, el("p", { class: "muted", style: "font-size:12px" }, "Locais vindos do OpenStreetMap: podem estar fechados ou desatualizados. Água: ferva ou trate antes de beber quando não tiver certeza."));
}

function backtrack() {
  if (track.points.length < 2) return;
  const first = track.points[0];
  followStraight({ lon: first[0], lat: first[1], name: "início da trilha" });
  const b = new maplibregl.LngLatBounds();
  for (const p of track.points) b.extend([p[0], p[1]]);
  map.fitBounds(b, { padding: 60 });
}

function showSOS() {
  const s = $("sos");
  const coords = me ? `${me.lat.toFixed(5)}, ${me.lon.toFixed(5)}` : "GPS sem sinal";
  const dms = me ? `${geo.toDMS(me.lat, true)}\n${geo.toDMS(me.lon, false)}` : "";
  s.replaceChildren(
    el("h2", {}, "EMERGÊNCIA"),
    el("div", {}, "Leia para o atendente:"),
    el("div", { class: "coords" }, coords),
    el("div", { style: "white-space:pre-line;font-size:20px;font-weight:700" }, dms),
    me ? el("div", {}, `Precisão do GPS: ± ${Math.round(me.acc)} m`) : null,
    el("div", { class: "calls" },
      el("a", { href: "tel:192" }, "192", el("small", {}, "SAMU")),
      el("a", { href: "tel:193" }, "193", el("small", {}, "Bombeiros")),
      el("a", { href: "tel:190" }, "190", el("small", {}, "Polícia"))),
    el("div", { style: "font-size:14px" }, "Ligações de emergência funcionam mesmo sem crédito. Se não houver sinal, suba para um lugar alto e aberto."),
    el("button", { onclick: () => s.classList.toggle("flash") }, "Sinal luminoso (pisca a tela)"),
    el("button", { onclick: () => { s.classList.add("hidden"); s.classList.remove("flash"); native.keepScreenOn(!!nav); } }, "Fechar"),
  );
  s.classList.remove("hidden");
  native.keepScreenOn(true);
}

function renderSettings() {
  const tog = (key, title, sub, after) => {
    const input = el("input", { type: "checkbox", "aria-label": title });
    input.checked = !!settings[key];
    input.addEventListener("change", () => { settings[key] = input.checked; saveSettings(); applyAccessibility(); after && after(); });
    return el("label", { class: "toggle" }, el("div", {}, el("b", {}, title), sub ? el("small", {}, sub) : null), input);
  };
  const pick = (key, title, options, after, sub) => {
    const sel = el("select", { class: "text-input", style: "width:auto;max-width:55%", "aria-label": title },
      options.map(([v, label]) => el("option", { value: v, selected: String(settings[key]) === String(v) }, label)));
    sel.addEventListener("change", () => {
      const v = sel.value;
      settings[key] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      saveSettings(); applyAccessibility(); after && after();
    });
    return el("label", { class: "toggle" }, el("div", {}, el("b", {}, title), sub ? el("small", {}, sub) : null), sel);
  };
  const restyle = () => applyStyle(true);
  const confirmBtn = (icon, label, question, action) => el("button", { "data-icon": icon, class: "btn ghost small", onclick: () => modal(el("div", {},
    el("h2", {}, label), el("p", {}, question),
    el("div", { class: "row" }, el("button", { "data-icon": "✓", class: "btn danger", onclick: () => { action(); closeModal(); renderSettings(); toast("Feito"); } }, "Confirmar"),
      el("button", { "data-icon": "✕", class: "btn ghost", onclick: closeModal }, "Cancelar")))) }, label);
  const usedBytes = Object.values(installed).reduce((t, p) => t + Object.values(p.files || {}).reduce((a, b) => a + (b || 0), 0), 0);
  const cfg = native.getConfig();

  openSheet(el("div", {},
    el("h2", {}, "Ajustes"),

    el("h3", {}, "Acessibilidade"),
    pick("textScale", "Tamanho do texto e botões", [[1, "Normal"], [1.15, "Grande"], [1.3, "Muito grande"]]),
    tog("maxContrast", "Contraste máximo", "Preto e branco puro, sem textura. Ajuda quem enxerga pouco."),
    tog("reduceMotion", "Reduzir movimentos", "Mapa muda de posição sem animação."),
    tog("vibrate", "Vibrar nos avisos", "Vibra antes de cada manobra e em alertas."),

    el("h3", {}, "Mapa"),
    pick("colors", "Cores do app", [["mono", "Preto e branco"], ["color", "Colorido (azul e laranja)"]], restyle),
    pick("theme", "Tema", [["auto", "Automático (pelo sol)"], ["day", "Dia (claro)"], ["night", "Noite (escuro)"]], restyle),
    tog("terrain", "Relevo 3D", "Montanhas e vales em 3D. Desligue para economizar bateria.", restyle),
    pick("terrainExaggeration", "Altura do relevo", [[1, "Real"], [1.35, "Realçada"], [2, "Bem realçada"]], restyle),
    tog("buildings3d", "Prédios em 3D", null, restyle),
    tog("showPois", "Mostrar locais úteis", "Água, hospitais, postos, polícia, abrigos.", () => setPoiVisibility()),
    pick("units", "Unidade de distância", [["metric", "Quilômetros e metros"], ["imperial", "Milhas e pés"]]),
    pick("coordFormat", "Formato das coordenadas", [["both", "Decimal e graus (os dois)"], ["decimal", "Decimal (-23.55, -46.63)"], ["dms", "Graus, minutos e segundos"]]),

    el("h3", {}, "Navegação"),
    tog("voice", "Instruções por voz"),
    el("div", { class: "row wrap" }, el("button", { "data-icon": "🔊", class: "btn ghost small", onclick: () => native.speak("Em 300 metros, vire à direita na Avenida Brasil.") }, "Testar voz")),
    tog("northUp", "Norte sempre para cima", "Desligado: o mapa gira na direção em que você anda."),
    tog("keepScreenOn", "Manter tela ligada na rota"),
    pick("staleDays", "Avisar mapa desatualizado após", [[15, "15 dias"], [30, "30 dias"], [60, "60 dias"], [90, "90 dias"]], updateAgeBanner),

    el("h3", {}, "Segurança da rota"),
    tog("avoidUnpaved", "Evitar estradas de terra", "Recomendado. Terra com chuva pode atolar ou deslizar."),
    tog("ferry", "Permitir balsas", "Desligado: o app nunca manda você para uma balsa."),
    tog("offroad", "Modo 4x4 (trilhas e vaus)", "Só para veículos apropriados e motoristas experientes."),
    tog("avoidTolls", "Evitar pedágios"),

    el("h3", {}, "Trilha e pontos"),
    pick("trackSpacing", "Gravar um ponto da trilha a cada", [[10, "10 m (mais detalhe)"], [25, "25 m"], [50, "50 m (menos bateria)"]]),
    el("div", { class: "row wrap" },
      confirmBtn("✕", "Apagar trilha", "A trilha gravada será apagada deste aparelho.", () => { track = { on: false, points: [] }; store.set("track", track); map.getSource("breadcrumbs")?.setData(trackGeoJSON()); }),
      confirmBtn("✕", "Apagar pontos", `Apagar os ${waypoints.length} pontos salvos?`, () => { waypoints = []; saveWaypoints(); })),

    el("h3", {}, "Mapas e armazenamento"),
    tog("wifiOnly", "Baixar mapas só no Wi-Fi", "Evita gastar o plano de dados do celular."),
    tog("autoCheck", "Procurar atualizações ao abrir", "Só quando houver internet."),
    el("p", {}, `Mapas instalados: ${Object.keys(installed).length} · ${fmtBytes(usedBytes)} usados · ${fmtBytes(native.freeSpace())} livres`),
    el("div", { class: "row wrap" }, el("button", { "data-icon": "⬇", class: "btn ghost small", onclick: () => openPanel("packs") }, "Gerenciar mapas")),

    el("h3", {}, "Privacidade"),
    el("p", {}, "Sua localização, trilhas e pontos ficam só neste aparelho. O app não tem conta, anúncios nem rastreamento. A internet só é usada para baixar mapas."),

    el("h3", {}, "Sobre"),
    el("p", {}, `Voli ${cfg.appVersion || ""}. Mapas do OpenStreetMap (feito por voluntários), atualizados toda semana.`),
    el("p", { style: "font-size:14px" }, "© OpenStreetMap contributors (ODbL) · © OpenMapTiles · Copernicus DEM GLO-90 © DLR e.V. 2010-2014 e © Airbus Defence and Space GmbH 2014-2018, fornecido pelo programa COPERNICUS da União Europeia e ESA · Overture Maps Foundation (lugares e comércios, CDLA Permissive 2.0 / Apache 2.0) · Natural Earth (domínio público) · MapLibre GL JS (BSD-3) · Noto Sans (OFL)."),
    el("div", { class: "row wrap" },
      el("button", { "data-icon": "⚠", class: "btn ghost small", onclick: showDisclaimer }, "Aviso de segurança"),
      confirmBtn("⟲", "Restaurar ajustes", "Voltar todos os ajustes ao padrão? Mapas, pontos e trilha não são apagados.", () => {
        for (const k of Object.keys(settings)) delete settings[k];
        Object.assign(settings, DEFAULT_SETTINGS); saveSettings(); applyAccessibility(); applyStyle(true);
      })),
  ), "settings");
}

function applyAccessibility() {
  const root = document.documentElement;
  root.style.setProperty("--ui-zoom", String(settings.textScale || 1));
  document.body.classList.toggle("maxc", !!settings.maxContrast);
  document.body.classList.toggle("reduce-motion", !!settings.reduceMotion);
  geo.setImperial(settings.units === "imperial");
  requestAnimationFrame(layoutSheet);
}

/** Keep the bottom sheet exactly above the bottom bar, whatever the text size. */
function layoutSheet() {
  const z = Number(settings.textScale || 1);
  const bar = document.body.classList.contains("navigating") ? $("nav-footer") : $("bottombar");
  const h = bar.getBoundingClientRect().height;
  document.documentElement.style.setProperty("--sheet-bottom", Math.round(h / z) + "px");
}
window.addEventListener("resize", () => layoutSheet());

function setPoiVisibility() {
  for (const id of ["pois", "pois-letter", "pois-name"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", settings.showPois ? "visible" : "none");
}

function fmtCoords(lat, lon) {
  const dec = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const dms = `${geo.toDMS(lat, true)}\n${geo.toDMS(lon, false)}`;
  return settings.coordFormat === "decimal" ? dec : settings.coordFormat === "dms" ? dms : `${dec}\n${dms}`;
}

function showDisclaimer(firstRun) {
  modal(el("div", {},
    el("h2", {}, "Antes de usar"),
    el("p", {}, "O Voli é um guia, não um piloto. Para sua segurança:"),
    el("ul", {},
      el("li", {}, el("b", {}, "As placas, a sinalização e as autoridades valem mais que o app."), " Se a rota mandar entrar em local proibido, perigoso ou alagado, não entre."),
      el("li", {}, "O mapa é offline e pode estar desatualizado: obras, pontes caídas, bloqueios e enchentes podem não aparecer. O app mostra a idade dos dados."),
      el("li", {}, "Por padrão o app evita estradas de terra, trilhas, vaus e balsas, e avisa quando a rota passa por eles."),
      el("li", {}, "Nunca atravesse água corrente ou de profundidade desconhecida."),
      el("li", {}, "Não mexa no celular dirigindo. Use a voz ou peça ao passageiro."),
      el("li", {}, "Em emergência ligue 192 (SAMU), 193 (Bombeiros) ou 190 (Polícia)."),
    ),
    el("button", { "data-icon": "✓", class: "btn orange", onclick: () => { store.set("disclaimer", DISCLAIMER_VERSION); closeModal(); if (firstRun === true && !packSet.length) openPanel("packs"); } }, "Entendi e concordo"),
  ));
}

// ---------------------------------------------------------------- wiring
function wireUI() {
  for (const b of document.querySelectorAll("#bottombar button")) b.addEventListener("click", () => openPanel(b.dataset.panel));
  let t;
  $("search-input").addEventListener("input", (e) => {
    $("search-clear").classList.toggle("hidden", !e.target.value);
    clearTimeout(t);
    t = setTimeout(() => runSearch(e.target.value), 220);
  });
  $("search-input").addEventListener("focus", () => { closeSheet(); if (!$("search-input").value.trim()) showSearchHome(); });
  $("search-clear").addEventListener("click", () => { $("search-input").value = ""; $("search-clear").classList.add("hidden"); showSearchHome(); $("search-input").focus(); });
  $("btn-locate").addEventListener("click", () => {
    setFollowing(true);
    if (me) map.easeTo({ center: [me.lon, me.lat], zoom: Math.max(map.getZoom(), 15) });
    else toast("Procurando GPS…");
  });
  $("btn-compass").addEventListener("click", () => map.easeTo({ bearing: 0 }));
  $("btn-3d").addEventListener("click", () => {
    const tilted = map.getPitch() > 10;
    if (!settings.terrain && !tilted) { settings.terrain = true; saveSettings(); applyStyle(true); }
    map.easeTo({ pitch: tilted ? 0 : 60, duration: 700 });
    $("btn-3d").classList.toggle("active", !tilted);
  });

  $("nav-stop").addEventListener("click", () => stopNavigation(false));
  $("nav-overview").addEventListener("click", () => {
    setFollowing(false);
    const b = new maplibregl.LngLatBounds();
    for (const c of nav.route.coords) b.extend(c);
    map.fitBounds(b, { padding: 60, pitch: 0, bearing: 0 });
  });
  // Handle: tap or swipe up = expand, swipe down = shrink / close.
  const sheet = $("sheet");
  let y0 = null;
  sheet.addEventListener("click", (e) => {
    if (!e.target.classList.contains("sheet-handle") && !e.target.classList.contains("peek-more")) return;
    sheet.classList.toggle("compact");
  });
  sheet.addEventListener("touchstart", (e) => { y0 = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  sheet.addEventListener("touchend", (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    if (dy < -40 && sheet.classList.contains("compact")) sheet.classList.remove("compact");
    else if (dy > 60) { if (!sheet.classList.contains("compact") && $("sheet").dataset.key === "route") sheet.classList.add("compact"); else closeSheet(); }
    y0 = null;
  }, { passive: true });
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal" && store.get("disclaimer", 0) >= DISCLAIMER_VERSION) closeModal(); });
  window.addEventListener("vt-back", () => {
    // Android back button
    if (!$("sos").classList.contains("hidden")) { $("sos").classList.add("hidden"); return; }
    if (!$("modal").classList.contains("hidden") && store.get("disclaimer", 0) >= DISCLAIMER_VERSION) { closeModal(); return; }
    if (!$("search-results").classList.contains("hidden")) { $("search-results").classList.add("hidden"); return; }
    if (!$("sheet").classList.contains("hidden")) { closeSheet(); return; }
    if (nav) { stopNavigation(false); return; }
    window.VoliNative?.exitApp?.();
  });
}

async function main() {
  applyAccessibility();
  wireUI();
  await loadStates();
  refreshInstalled();
  await initMap();
  updateAgeBanner();
  startRouter();
  loadSearch().then(() => map.getSource("pois")?.setData(poiGeoJSON()));
  startGPS();
  startCompass();
  if (store.get("disclaimer", 0) < DISCLAIMER_VERSION) showDisclaimer(true);
  else if (!packSet.length) openPanel("packs");
  if (!manifest || settings.autoCheck) fetchManifest().then((ok) => ok && $("sheet").dataset.key === "packs" && renderPacks());
  window.__vt = { map, routerCall, showSearchHome, showNearest, view3D, setSavedPlace, setTheme(t) { settings.theme = t; saveSettings(); applyStyle(true); }, get route() { return currentRoute; }, chooseDestination, onFix, planRouteFrom, startNavigation };
}

main().catch((e) => {
  console.error(e);
  document.body.append(el("div", { style: "position:fixed;inset:auto 10px 80px 10px;background:#d92d20;color:#fff;padding:12px;border-radius:12px;z-index:99" }, "Erro ao iniciar: " + e.message));
});
