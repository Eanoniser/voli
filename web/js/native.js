// Thin wrapper around the Android bridge (window.VoliNative, see MainActivity.java).
// When running in a desktop browser for development, a small fallback is used.

const listeners = new Map();
let reqSeq = 0;

window.__vtEmit = (name, json) => {
  let data = json;
  try { data = typeof json === "string" ? JSON.parse(json) : json; } catch (_) { /* keep raw */ }
  for (const fn of listeners.get(name) || []) fn(data);
};

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

const N = window.VoliNative || null;
export const isAndroid = !!N;

export function getConfig() {
  if (N) return JSON.parse(N.getConfig());
  return { packsBaseUrl: "/packs-remote/", appVersion: "dev" };
}

export function listPacks() {
  if (N) return JSON.parse(N.listPacks());
  try { return JSON.parse(localStorage.getItem("vt.devPacks") || "{}"); } catch (_) { return {}; }
}

export function fetchText(url) {
  if (!N) return fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))));
  const id = "t" + ++reqSeq;
  return new Promise((resolve, reject) => {
    const off = on("fetchText", (d) => {
      if (d.reqId !== id) return;
      off();
      d.ok ? resolve(d.body) : reject(new Error(d.error || "HTTP " + d.status));
    });
    N.fetchText(id, url);
  });
}

export function downloadPack(uf, files, meta) {
  if (N) return N.downloadPack(uf, JSON.stringify(files), JSON.stringify(meta));
  // Dev fallback: pretend the files are already served under /packs/.
  const packs = listPacks();
  packs[uf] = { meta, files: Object.fromEntries(files.map((f) => [f.name, f.size || 0])) };
  localStorage.setItem("vt.devPacks", JSON.stringify(packs));
  setTimeout(() => window.__vtEmit("downloaded", JSON.stringify({ uf })), 300);
}

export function cancelDownload(uf) { if (N) N.cancelDownload(uf); }

export function deletePack(uf) {
  if (N) return N.deletePack(uf);
  const packs = listPacks();
  delete packs[uf];
  localStorage.setItem("vt.devPacks", JSON.stringify(packs));
  return true;
}

export function isWifi() {
  if (N && N.isWifi) return !!N.isWifi();
  return true;
}

export function freeSpace() { return N ? Number(N.freeSpace()) : 50e9; }

export function speak(text) {
  if (N) return N.speak(text);
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "pt-BR";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
}

export function keepScreenOn(on) { if (N) N.keepScreenOn(!!on); }
export function vibrate(ms) { if (N) N.vibrate(ms); else if (navigator.vibrate) navigator.vibrate(ms); }
