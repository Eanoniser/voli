# Voli

**Offline survival maps for Brazil.** Voli is an Android app with a clean black-and-white look (a blue and orange colour theme is optional), 3D terrain, offline turn-by-turn routing and survival tools. It works with no signal at all, and no location data ever leaves the phone.

The name **Voli** comes from *воля* (volya, Ukrainian for freedom) and also echoes *volar* (Spanish: to fly) and *voo* (Portuguese: flight).

## What it does

- **Built-in world map** (globe view, Brazil highlighted with its states) that works offline from the first launch.
- **Detailed offline map per state** (all 27 Brazilian states), downloaded once over Wi-Fi.
- **3D terrain and hillshade** from Copernicus DEM, plus 3D buildings.
- **Offline routing** with turn-by-turn voice guidance in Brazilian Portuguese and automatic rerouting. Routes can cross state borders when both packs are installed.
- **Safety first:**
  - By default, routes avoid dirt roads, tracks, fords, ferries and private roads, and warn when a route uses any of them.
  - The app shows how old the map data is. A banner appears after 30 days, and a red one after 90 days.
  - A disclaimer must be accepted before first use, and there is a "follow the road signs" reminder at the start of every route.
  - The app warns when the start or destination is far from a mapped road.
  - Arrival times are labeled as "without traffic", because the app has no live data.
- **Survival panel:**
  - Coordinates in decimal and DMS, GPS accuracy and altitude.
  - Compass, sunrise and sunset, and how much daylight is left.
  - Breadcrumb trail recording and "back along the trail".
  - Straight-line guidance to any point for when there is no road.
  - Nearest water, hospitals, clinics, pharmacies, fuel, police, fire stations, shelters and supermarkets.
- **SOS screen** with large coordinates to read to a dispatcher, one-tap 192, 193 and 190 calls, and a flashing screen signal.
- **Waypoints**: save where you are (camp, car, spring) and return later.
- **Accessibility**: black and white by default, large buttons drawn with a fine pen line, high contrast, a maximum-contrast mode, adjustable text size, reduced motion, and a colour-blind-safe palette where every status also has an icon or pattern.
- **Complete settings** (Ajustes): accessibility, map, navigation, route safety, trail, storage (Wi-Fi-only downloads), privacy and about.
- **Offline search** for cities, neighbourhoods, streets and points of interest.

## Linux and Raspberry Pi

The same app runs on desktop Linux and Raspberry Pi OS. `desktop/voli.py` (Python standard library only) serves the app and the map packs on `127.0.0.1`, downloads packs, and opens Voli in a Chromium app window (or Firefox).

- **Install:** download `voli-linux.tar.gz` from the `app` release, extract it and run `./install.sh`. Voli then appears in the applications menu, or you can run `voli` in a terminal.
- **GPS:** computers and the Raspberry Pi usually have no GPS, so plug in a USB GPS receiver. Voli reads it through gpsd when gpsd is running. Otherwise it reads NMEA directly from `/dev/ttyACM*` or `/dev/ttyUSB*`; the installer offers to add the user to the `dialout` group for this. You can also choose the device yourself, e.g. `voli --gps /dev/ttyACM0`.
- **Voice:** spoken instructions use `espeak-ng` or `speech-dispatcher` when one is installed.
- **Maps:** downloaded maps are stored in `~/.local/share/voli/packs`.

## How "always up to date" works

The app is fully offline, so freshness comes from a weekly rebuild:

1. Every Monday the GitHub Actions workflow `.github/workflows/maps.yml` downloads the latest OpenStreetMap data for Brazil from Geofabrik and rebuilds every state pack. It also creates a `maps` GitHub release on its first run.
2. The packs are published to that `maps` release, together with a `manifest.json` file.
3. When the phone has internet, the app compares installed packs with the manifest and offers updates.
4. The app always shows the date of the data in use.

Voli does **not** copy data from Google Maps or Waze, because their terms forbid it. OpenStreetMap is the open map used by many professional apps, and it can be used commercially with attribution.

## Repository layout

| Path | What it is |
|---|---|
| `web/` | The app UI: HTML, CSS and JS, with MapLibre GL JS and Noto Sans glyphs bundled. It runs inside the Android WebView. |
| `web/js/router-worker.js` | Offline router (time-based A*) with safety-aware costs |
| `web/js/pmtiles.js` | Small PMTiles v3 reader (no dependency) |
| `android/` | Plain Android app (Java, Android SDK only, no third-party libraries) |
| `pipeline/` | Scripts that build a state pack from OpenStreetMap and Copernicus DEM |
| `desktop/` | Linux / Raspberry Pi launcher, local server, GPS reader and installer |
| `.github/workflows/` | `maps.yml` (weekly map packs) and `apk.yml` (builds the APK and the Linux package) |
| `test/` | Synthetic test data, a dev server and a headless browser end-to-end test |

## Getting started

1. Push this repository to GitHub. Public repositories get free Actions minutes and storage.
2. Under **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**.
3. Run **Actions → Build map packs → Run workflow**.
   - Leave "states" empty to build all 27 states, which takes a few hours.
   - Or type a few UFs (e.g. `sp,rj`) to try it first.
4. Run **Actions → Build apps (Android + Linux) → Run workflow**, or simply push to `main`.
   - The APK appears in the `app` release.
   - The APK automatically downloads maps from your repository's `maps` release.
5. Install `voli.apk` on the phone. Open **Mapas**, load the list and download your state over Wi-Fi.

### Signed release builds (optional, needed for Google Play)

Create a keystore and add these repository secrets:

- `VOLI_KEYSTORE_B64`: the `.jks` file, base64-encoded
- `VOLI_KEYSTORE_PASSWORD`
- `VOLI_KEY_ALIAS`
- `VOLI_KEY_PASSWORD`

Without them, the workflow builds an installable debug APK.

### Building locally

- **App:** open `android/` in Android Studio, or run `gradle -p android assembleDebug` with Gradle 8.14 and JDK 17.
- **Map pack:** `pipeline/build_state.sh <uf> <state.osm.pbf> <date> <out>`. It needs osmium-tool, Java 21, Planetiler, GDAL and Python with `osmium`, `pmtiles`, `numpy` and `pillow`.
- **Web UI in a desktop browser:** run `python3 test/make_synthetic.py && python3 test/serve.py`, then open http://127.0.0.1:8765.
- **End-to-end test:** run `python3 test/e2e.py`. It needs Playwright and saves screenshots in `test/shots/`.
- **Linux build test:** run `python3 test/test_desktop.py`. It installs into a temporary home, downloads a pack from a local release and fakes gpsd.

## Third-party data and software

| Component | License | Where it is used |
|---|---|---|
| OpenStreetMap data | ODbL 1.0, attribution required | Map, routing, search |
| OpenMapTiles schema | CC-BY 4.0, attribution required | Vector tile layers |
| Copernicus DEM GLO-90 | Free incl. commercial use, attribution required | Terrain |
| Natural Earth | Public domain | Built-in world map (globe, countries, Brazilian states, cities) in `web/data/world` |
| MapLibre GL JS | BSD-3-Clause | Map rendering (bundled in `web/vendor`) |
| Noto Sans | SIL OFL 1.1 | Map labels (bundled in `web/fonts`) |
| Planetiler | Apache 2.0 | Build-time only (GitHub Actions) |
| gpsd (optional) | BSD-2 | Linux / Raspberry Pi: reads a USB GPS (separate program, runs locally) |
| espeak-ng / speech-dispatcher (optional) | GPL | Linux / Raspberry Pi: spoken instructions (separate programs) |
| Chromium / Firefox | BSD / MPL | Linux / Raspberry Pi: the window Voli opens in |
| osmium-tool / pyosmium | Boost / BSD-2 | Build-time only |
| GDAL | MIT/X | Build-time only |
| pmtiles (Python) | BSD-3-Clause | Build-time only |

Attribution is shown on the map and in **Ajustes → Sobre**.

## Safety notice

Voli is a guide, not an autopilot. Map data can be outdated or wrong. Road signs, authorities and common sense always take priority. Never drive into flooded roads or cross moving water.
