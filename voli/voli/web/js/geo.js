// Small geo helpers. Pure math, no network.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distance(lon1, lat1, lon2, lat2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lon1, lat1, lon2, lat2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Distance in metres from point P to segment AB (equirectangular, fine for short segments). */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const k = Math.cos(rad(py));
  const x = (px - ax) * k, y = py - ay;
  const dx = (bx - ax) * k, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? (x * dx + y * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = x - t * dx, ey = y - t * dy;
  return { d: Math.sqrt(ex * ex + ey * ey) * 111195, t };
}

let imperial = false;
export function setImperial(on) { imperial = !!on; }

export function formatDistance(m) {
  if (imperial) {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.max(30, Math.round(ft / 10) * 10)} pés`;
    const mi = m / 1609.344;
    return mi < 10 ? `${mi.toFixed(1).replace(".", ",")} mi` : `${Math.round(mi)} mi`;
  }
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1).replace(".", ",")} km`;
  return `${Math.round(m / 1000)} km`;
}

export function formatDuration(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")}`;
}

export function toDMS(value, isLat) {
  const hemi = isLat ? (value < 0 ? "S" : "N") : value < 0 ? "O" : "L";
  const v = Math.abs(value);
  const d = Math.floor(v);
  const mFloat = (v - d) * 60;
  const m = Math.floor(mFloat);
  const s = ((mFloat - m) * 60).toFixed(1).replace(".", ",");
  return `${d}°${String(m).padStart(2, "0")}'${s.padStart(4, "0")}" ${hemi}`;
}

export function cardinal(b) {
  const names = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
  return names[Math.round(b / 45) % 8];
}

/** Sunrise / sunset (NOAA simplified). Returns Date objects or null for polar day/night. */
export function sunTimes(date, lat, lon) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const eqtime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(rad(90.833)) - Math.sin(rad(lat)) * Math.sin(decl)) / (Math.cos(rad(lat)) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null;
  const ha = deg(Math.acos(cosH));
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const rise = 720 - 4 * (lon + ha) - eqtime;
  const set = 720 - 4 * (lon - ha) - eqtime;
  return { sunrise: new Date(base + rise * 60000), sunset: new Date(base + set * 60000) };
}

export function lngLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latR = rad(lat);
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return [x, y];
}

export function tileBounds(z, x, y) {
  const n = Math.pow(2, z);
  const lon1 = (x / n) * 360 - 180;
  const lon2 = ((x + 1) / n) * 360 - 180;
  const lat1 = deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))));
  const lat2 = deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))));
  return [lon1, lat1, lon2, lat2];
}
