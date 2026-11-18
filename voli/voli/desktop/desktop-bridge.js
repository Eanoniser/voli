// Desktop (Linux / Raspberry Pi) bridge: gives the web app the same `VoliNative` interface
// the Android shell provides, backed by the local voli.py server. Loaded before js/app.js.
(function () {
  "use strict";

  function getJSON(path) {
    var x = new XMLHttpRequest();
    x.open("GET", path, false); // synchronous on purpose: the Android bridge methods are synchronous
    x.send();
    return x.status === 200 ? x.responseText : "{}";
  }
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false }; });
  }
  function emit(name, data) {
    if (window.__vtEmit) window.__vtEmit(name, JSON.stringify(data));
  }

  window.VoliNative = {
    getConfig: function () { return getJSON("/api/config"); },
    listPacks: function () { return getJSON("/api/packs"); },
    fetchText: function (reqId, url) {
      fetch("/api/fetch?url=" + encodeURIComponent(url))
        .then(function (r) { return r.json(); })
        .then(function (d) { d.reqId = reqId; emit("fetchText", d); })
        .catch(function (e) { emit("fetchText", { reqId: reqId, ok: false, error: String(e) }); });
    },
    downloadPack: function (uf, filesJson, metaJson) {
      post("/api/download", { uf: uf, files: JSON.parse(filesJson), meta: JSON.parse(metaJson) });
    },
    cancelDownload: function (uf) { post("/api/cancel", { uf: uf }); },
    deletePack: function (uf) {
      var x = new XMLHttpRequest();
      x.open("POST", "/api/delete", false);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify({ uf: uf }));
      try { return JSON.parse(x.responseText).ok; } catch (e) { return false; }
    },
    freeSpace: function () { try { return String(JSON.parse(getJSON("/api/free")).bytes); } catch (e) { return "0"; } },
    isWifi: function () { try { return !!JSON.parse(getJSON("/api/wifi")).ok; } catch (e) { return true; } },
    speak: function (text) {
      // Prefer the system voice through the server (espeak-ng / speech-dispatcher); fall back to the browser.
      post("/api/speak", { text: text }).then(function (r) {
        if (!r.ok && "speechSynthesis" in window) {
          var u = new SpeechSynthesisUtterance(text);
          u.lang = "pt-BR";
          speechSynthesis.cancel();
          speechSynthesis.speak(u);
        }
      });
    },
    keepScreenOn: function (on) {
      try {
        if (on && navigator.wakeLock && !window.__voliWake) {
          navigator.wakeLock.request("screen").then(function (l) { window.__voliWake = l; });
        } else if (!on && window.__voliWake) {
          window.__voliWake.release(); window.__voliWake = null;
        }
      } catch (e) { /* not supported */ }
    },
    vibrate: function () { /* no vibration motor on computers */ },
    exitApp: function () { window.close(); },
  };

  // ---- GPS: positions from the USB receiver (via voli.py) replace the browser's geolocation.
  var watchers = {};
  var seq = 0;
  var lastFix = null;
  var hasDeviceGps = false;
  var nativeGeo = navigator.geolocation;

  function toPosition(d) {
    return {
      timestamp: Date.now(),
      coords: {
        latitude: d.lat, longitude: d.lon, accuracy: d.accuracy || 15,
        altitude: d.alt == null ? null : d.alt, altitudeAccuracy: null,
        heading: d.heading == null ? null : d.heading, speed: d.speed == null ? null : d.speed,
      },
    };
  }

  var es = new EventSource("/api/events");
  ["progress", "downloaded", "downloadError", "gpsStatus"].forEach(function (name) {
    es.addEventListener(name, function (ev) { emit(name, JSON.parse(ev.data)); });
  });
  es.addEventListener("gps", function (ev) {
    var d = JSON.parse(ev.data);
    if (!d.fix) return;
    hasDeviceGps = true;
    lastFix = toPosition(d);
    Object.keys(watchers).forEach(function (id) { watchers[id].ok(lastFix); });
  });

  var geo = {
    getCurrentPosition: function (ok, err, opts) {
      if (lastFix) return ok(lastFix);
      if (nativeGeo) return nativeGeo.getCurrentPosition(ok, err, opts);
    },
    watchPosition: function (ok, err, opts) {
      var id = ++seq;
      var w = { ok: ok };
      // Also listen to the browser's own location (works when online / on devices with location services).
      if (nativeGeo) {
        w.native = nativeGeo.watchPosition(function (p) { if (!hasDeviceGps) ok(p); }, function () { /* the USB GPS may still answer */ }, opts);
      }
      watchers[id] = w;
      if (lastFix) setTimeout(function () { ok(lastFix); }, 0);
      return id;
    },
    clearWatch: function (id) {
      var w = watchers[id];
      if (w && w.native != null && nativeGeo) nativeGeo.clearWatch(w.native);
      delete watchers[id];
    },
  };
  try {
    Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
  } catch (e) {
    navigator.__proto__ = Object.create(navigator.__proto__, { geolocation: { value: geo } });
  }
})();
