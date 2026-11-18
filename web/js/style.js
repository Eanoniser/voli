// Voli map style (blue + orange), built for the OpenMapTiles schema produced by Planetiler.

export const THEMES = {
  day: {
    bg: "#f3f2ee", residential: "#e2e3e6", wood: "#d3e4d0", grass: "#e1ecd9", farmland: "#eef0df",
    sand: "#f3ead2", wetland: "#d6e6e8", ice: "#ffffff", park: "#d4e9d3",
    water: "#7fb6f5", waterway: "#5c9fee", waterLabel: "#1d5fae",
    building: "#d9dfe8", buildingTop: "#cbd4e1", buildingOutline: "#c2ccda",
    motorway: "#ff7a00", motorwayCase: "#7a3300", trunk: "#ff8a24", trunkCase: "#c25f0b",
    primary: "#ffb35c", primaryCase: "#8a4f12", secondary: "#ffd29c", secondaryCase: "#8a6a3f",
    minor: "#ffffff", minorCase: "#7d8796", service: "#ffffff", unpaved: "#b07a45", track: "#a0703f",
    path: "#7b8ba3", rail: "#8d99ab", ferry: "#2f7de1", boundary: "#5a6fb0",
    text: "#000000", textHalo: "#ffffff", roadText: "#111827", peak: "#6b4b2a",
    hillshadeShadow: "#4a5a72", hillshadeHighlight: "#ffffff", hillshadeAccent: "#6d7d96",
    sky: "#9cc8ff", horizon: "#e8f1ff", fog: "#ffffff",
    worldLand: "#e7e3da", brazilLand: "#fff1dc", brazilBorder: "#e65c00", stateLine: "#8a4f12", countryLine: "#5c6675",
  },
  night: {
    bg: "#0c1828", residential: "#122236", wood: "#10291f", grass: "#132a22", farmland: "#15241f",
    sand: "#2a2619", wetland: "#11283a", ice: "#24384f", park: "#11301f",
    water: "#0f3b6e", waterway: "#1b5aa5", waterLabel: "#8fbcf2",
    building: "#1b2c42", buildingTop: "#22364f", buildingOutline: "#2a3f5a",
    motorway: "#ff7a1a", motorwayCase: "#7a3300", trunk: "#f08a35", trunkCase: "#6b3a10",
    primary: "#d9883f", primaryCase: "#4d3013", secondary: "#9c7a55", secondaryCase: "#3a2c1d",
    minor: "#7f97b8", minorCase: "#05090f", service: "#2b3f5c", unpaved: "#a8784a", track: "#8d6a45",
    path: "#5b6e8c", rail: "#56667f", ferry: "#4b9bff", boundary: "#7f95d6",
    text: "#ffffff", textHalo: "#000000", roadText: "#f1f5fb", peak: "#d9b38c",
    hillshadeShadow: "#000000", hillshadeHighlight: "#3c5578", hillshadeAccent: "#000000",
    sky: "#050b16", horizon: "#16304f", fog: "#0c1828",
    worldLand: "#1b222c", brazilLand: "#2a2217", brazilBorder: "#ff9a3c", stateLine: "#d9a066", countryLine: "#8b97a8",
  },
};

const NAME = ["coalesce", ["get", "name:pt"], ["get", "name:latin"], ["get", "name"]];
const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

function roadWidth(base, extra = 0) {
  const at = (k) => (typeof base === "number" ? base * k + extra : ["+", ["*", base, k], extra]);
  return ["interpolate", ["exponential", 1.5], ["zoom"], 5, at(0.25), 10, at(0.9), 14, at(2.6), 18, at(10)];
}

// Black & white palettes (default look of the app). Roads and areas differ by lightness and
// line pattern, so the map stays readable for every kind of vision, including colour blindness.
THEMES.monoDay = {
  bg: "#f4f4f2", residential: "#e8e8e6", wood: "#d6d6d3", grass: "#e2e2df", farmland: "#ededeb",
  sand: "#f0f0ee", wetland: "#dcdcda", ice: "#ffffff", park: "#dadad7",
  water: "#bfc0c2", waterway: "#8a8b8e", waterLabel: "#2a2a2a",
  building: "#d4d4d2", buildingTop: "#c6c6c4", buildingOutline: "#a9a9a7",
  motorway: "#1a1a1a", motorwayCase: "#000000", trunk: "#333333", trunkCase: "#000000",
  primary: "#5c5c5c", primaryCase: "#111111", secondary: "#8c8c8c", secondaryCase: "#2a2a2a",
  minor: "#ffffff", minorCase: "#6e6e6e", service: "#ffffff", unpaved: "#4a4a4a", track: "#555555",
  path: "#666666", rail: "#777777", ferry: "#333333", boundary: "#444444",
  text: "#000000", textHalo: "#ffffff", roadText: "#111111", peak: "#222222",
  hillshadeShadow: "#3a3a3a", hillshadeHighlight: "#ffffff", hillshadeAccent: "#5a5a5a",
  sky: "#d9d9d9", horizon: "#f2f2f2", fog: "#ffffff",
  worldLand: "#e6e6e3", brazilLand: "#ffffff", brazilBorder: "#000000", stateLine: "#333333", countryLine: "#6a6a6a",
};
THEMES.monoNight = {
  bg: "#101010", residential: "#1b1b1b", wood: "#222222", grass: "#1e1e1e", farmland: "#181818",
  sand: "#1d1d1d", wetland: "#202020", ice: "#2a2a2a", park: "#232323",
  water: "#3a3a3a", waterway: "#6a6a6a", waterLabel: "#d9d9d9",
  building: "#262626", buildingTop: "#303030", buildingOutline: "#3a3a3a",
  motorway: "#f2f2f2", motorwayCase: "#000000", trunk: "#d6d6d6", trunkCase: "#000000",
  primary: "#b0b0b0", primaryCase: "#000000", secondary: "#8a8a8a", secondaryCase: "#000000",
  minor: "#6a6a6a", minorCase: "#000000", service: "#555555", unpaved: "#bdbdbd", track: "#9a9a9a",
  path: "#8a8a8a", rail: "#777777", ferry: "#cccccc", boundary: "#aaaaaa",
  text: "#ffffff", textHalo: "#000000", roadText: "#f2f2f2", peak: "#e0e0e0",
  hillshadeShadow: "#000000", hillshadeHighlight: "#3a3a3a", hillshadeAccent: "#000000",
  sky: "#050505", horizon: "#1e1e1e", fog: "#101010",
  worldLand: "#1c1c1c", brazilLand: "#2c2c2c", brazilBorder: "#ffffff", stateLine: "#bdbdbd", countryLine: "#8a8a8a",
};

export function buildStyle({ theme = "day", origin, terrain = true, buildings3d = true, exaggeration = 1.35, attribution }) {
  const c = THEMES[theme] || THEMES.day;
  const unpaved = ["==", ["get", "surface"], "unpaved"];
  const cls = (...v) => ["match", ["get", "class"], v, true, false];
  const layers = [
    // Below z8 the background is sea and the built-in world map draws the land; from z9 the
    // detailed packs take over (their "water" layer draws the sea), so the background becomes land.
    { id: "bg", type: "background", paint: { "background-color": ["interpolate", ["linear"], ["zoom"], 7.5, c.water, 9, c.bg] } },
    // ---- Built-in world map (Natural Earth, public domain): always available, fades out as detail appears
    {
      id: "world-land", type: "fill", source: "world-countries", maxzoom: 10,
      paint: {
        "fill-color": ["case", ["==", ["get", "a3"], "BRA"], c.brazilLand, c.worldLand],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7.5, 1, 9, 0],
      },
    },
    { id: "world-lakes", type: "fill", source: "world-lakes", maxzoom: 9.5, paint: { "fill-color": c.water, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7.5, 1, 9, 0] } },
    {
      id: "landcover", type: "fill", source: "vt", "source-layer": "landcover",
      paint: {
        "fill-color": ["match", ["get", "class"],
          "wood", c.wood, "forest", c.wood, "grass", c.grass, "farmland", c.farmland,
          "sand", c.sand, "wetland", c.wetland, "ice", c.ice, "rock", c.residential, c.grass],
        "fill-opacity": 0.9,
      },
    },
    {
      id: "landuse", type: "fill", source: "vt", "source-layer": "landuse",
      filter: cls("residential", "suburb", "neighbourhood", "commercial", "industrial", "retail", "quarry"),
      paint: { "fill-color": c.residential, "fill-opacity": 0.8 },
    },
    { id: "park", type: "fill", source: "vt", "source-layer": "park", paint: { "fill-color": c.park, "fill-opacity": 0.7 } },
    { id: "water", type: "fill", source: "vt", "source-layer": "water", paint: { "fill-color": c.water } },
    {
      id: "waterway", type: "line", source: "vt", "source-layer": "waterway",
      paint: {
        "line-color": c.waterway,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, ["match", ["get", "class"], "river", 1, 0.3], 14, ["match", ["get", "class"], "river", 4, 1.5]],
      },
    },
    {
      id: "hillshade", type: "hillshade", source: "dem-hs",
      paint: {
        "hillshade-shadow-color": c.hillshadeShadow, "hillshade-highlight-color": c.hillshadeHighlight,
        "hillshade-accent-color": c.hillshadeAccent, "hillshade-exaggeration": theme === "day" ? 0.45 : 0.6,
      },
    },
    {
      id: "aeroway", type: "fill", source: "vt", "source-layer": "aeroway", filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": c.residential, "fill-opacity": 0.8 },
    },
    {
      id: "world-rivers", type: "line", source: "world-rivers", maxzoom: 9,
      paint: { "line-color": c.waterway, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 8, 1.6], "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 1, 9, 0] },
    },
    {
      id: "world-br-states", type: "line", source: "world-br-states", minzoom: 3, maxzoom: 10,
      paint: { "line-color": c.stateLine, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 8, 2], "line-dasharray": [3, 2], "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.9, 10, 0] },
    },
    {
      id: "world-borders", type: "line", source: "world-countries", maxzoom: 10,
      paint: { "line-color": c.countryLine, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 6, 1.4], "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 1, 10, 0] },
    },
    {
      id: "world-brazil", type: "line", source: "world-countries", filter: ["==", ["get", "a3"], "BRA"], maxzoom: 10,
      paint: { "line-color": c.brazilBorder, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.2, 5, 3, 8, 4], "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 1, 10, 0] },
    },
    {
      id: "boundary", type: "line", source: "vt", "source-layer": "boundary",
      filter: ["all", ["<=", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
      paint: { "line-color": c.boundary, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 10, 1.6], "line-dasharray": [3, 2], "line-opacity": 0.7 },
    },
    // Roads: casings first, then fills.
    {
      id: "road-minor-case", type: "line", source: "vt", "source-layer": "transportation", minzoom: 12,
      filter: ["all", cls("minor", "service"), ["!", unpaved]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.minorCase, "line-width": roadWidth(1.1, 1.5) },
    },
    {
      id: "road-tertiary-case", type: "line", source: "vt", "source-layer": "transportation", minzoom: 9,
      filter: ["all", cls("tertiary"), ["!", unpaved]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.minorCase, "line-width": roadWidth(1.4, 1.5) },
    },
    {
      id: "road-major-case", type: "line", source: "vt", "source-layer": "transportation", minzoom: 6,
      filter: ["all", cls("motorway", "trunk", "primary", "secondary"), ["!", unpaved]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "class"], "motorway", c.motorwayCase, "trunk", c.trunkCase, "primary", c.primaryCase, c.secondaryCase],
        "line-width": roadWidth(["match", ["get", "class"], "motorway", 2.2, "trunk", 2, "primary", 1.8, 1.6], 2),
      },
    },
    {
      id: "path", type: "line", source: "vt", "source-layer": "transportation", minzoom: 13, filter: cls("path"),
      paint: { "line-color": c.path, "line-width": 1.2, "line-dasharray": [1.5, 1.5] },
    },
    {
      id: "track", type: "line", source: "vt", "source-layer": "transportation", minzoom: 11, filter: cls("track"),
      paint: { "line-color": c.track, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 16, 2.5], "line-dasharray": [3, 1.5] },
    },
    {
      id: "road-unpaved", type: "line", source: "vt", "source-layer": "transportation", minzoom: 9,
      filter: ["all", cls("motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"), unpaved],
      layout: { "line-join": "round" },
      paint: { "line-color": c.unpaved, "line-width": roadWidth(1.3), "line-dasharray": [2, 1] },
    },
    {
      id: "road-minor", type: "line", source: "vt", "source-layer": "transportation", minzoom: 12,
      filter: ["all", cls("minor", "service"), ["!", unpaved]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.minor, "line-width": roadWidth(1.1) },
    },
    {
      id: "road-tertiary", type: "line", source: "vt", "source-layer": "transportation", minzoom: 9,
      filter: ["all", cls("tertiary"), ["!", unpaved]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.minor, "line-width": roadWidth(1.4) },
    },
    {
      id: "road-major", type: "line", source: "vt", "source-layer": "transportation", minzoom: 4,
      filter: ["all", cls("motorway", "trunk", "primary", "secondary"), ["!", unpaved]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "class"], "motorway", c.motorway, "trunk", c.trunk, "primary", c.primary, c.secondary],
        "line-width": roadWidth(["match", ["get", "class"], "motorway", 2.2, "trunk", 2, "primary", 1.8, 1.6]),
      },
    },
    {
      id: "rail", type: "line", source: "vt", "source-layer": "transportation", minzoom: 10, filter: cls("rail", "transit"),
      paint: { "line-color": c.rail, "line-width": 1.4, "line-dasharray": [4, 2] },
    },
    {
      id: "ferry", type: "line", source: "vt", "source-layer": "transportation", filter: cls("ferry"),
      paint: { "line-color": c.ferry, "line-width": 1.6, "line-dasharray": [2, 2] },
    },
    {
      id: "building", type: "fill", source: "vt", "source-layer": "building", minzoom: 14,
      paint: { "fill-color": c.building, "fill-outline-color": c.buildingOutline },
    },
  ];
  if (buildings3d) {
    layers.push({
      id: "building-3d", type: "fill-extrusion", source: "vt", "source-layer": "building", minzoom: 15,
      paint: {
        "fill-extrusion-color": c.buildingTop,
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.85,
      },
    });
  }
  layers.push(
    {
      id: "water-name", type: "symbol", source: "vt", "source-layer": "water_name",
      layout: { "text-field": NAME, "text-font": ["Noto Sans Regular"], "text-size": 12 },
      paint: { "text-color": c.waterLabel, "text-halo-color": c.textHalo, "text-halo-width": 1.2 },
    },
    {
      id: "road-name", type: "symbol", source: "vt", "source-layer": "transportation_name", minzoom: 13,
      layout: { "symbol-placement": "line", "text-field": NAME, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 13, 12, 17, 16], "text-max-angle": 30 },
      paint: { "text-color": c.roadText, "text-halo-color": c.textHalo, "text-halo-width": 2.2 },
    },
    {
      id: "road-shield", type: "symbol", source: "vt", "source-layer": "transportation_name", minzoom: 7,
      filter: ["all", ["has", "ref"], cls("motorway", "trunk", "primary")],
      layout: { "symbol-placement": "line", "symbol-spacing": 400, "text-field": ["get", "ref"], "text-font": FONT_BOLD, "text-size": 10.5, "text-rotation-alignment": "viewport" },
      paint: { "text-color": "#ffffff", "text-halo-color": c.motorwayCase, "text-halo-width": 3 },
    },
    {
      id: "peak", type: "symbol", source: "vt", "source-layer": "mountain_peak", minzoom: 10,
      layout: {
        "text-field": ["concat", "▲ ", NAME, ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", "ele"]], " m"], ""]],
        "text-font": FONT, "text-size": 11, "text-anchor": "top",
      },
      paint: { "text-color": c.peak, "text-halo-color": c.textHalo, "text-halo-width": 1.2 },
    },
    {
      id: "place-minor", type: "symbol", source: "vt", "source-layer": "place",
      filter: ["match", ["get", "class"], ["village", "hamlet", "suburb", "neighbourhood", "quarter", "isolated_dwelling", "locality"], true, false],
      minzoom: 11,
      layout: { "text-field": NAME, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 16, 14] },
      paint: { "text-color": c.text, "text-halo-color": c.textHalo, "text-halo-width": 1.5 },
    },
    {
      id: "place-town", type: "symbol", source: "vt", "source-layer": "place",
      filter: ["==", ["get", "class"], "town"], minzoom: 8,
      layout: { "text-field": NAME, "text-font": FONT_BOLD, "text-size": ["interpolate", ["linear"], ["zoom"], 8, 11, 14, 16] },
      paint: { "text-color": c.text, "text-halo-color": c.textHalo, "text-halo-width": 2.2 },
    },
    {
      id: "place-city", type: "symbol", source: "vt", "source-layer": "place",
      filter: ["==", ["get", "class"], "city"],
      layout: { "text-field": NAME, "text-font": FONT_BOLD, "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11, 12, 20] },
      paint: { "text-color": c.text, "text-halo-color": c.textHalo, "text-halo-width": 2.4 },
    },
    {
      id: "place-state", type: "symbol", source: "vt", "source-layer": "place",
      filter: ["==", ["get", "class"], "state"], maxzoom: 8,
      layout: { "text-field": NAME, "text-font": FONT_BOLD, "text-size": 13, "text-transform": "uppercase", "text-letter-spacing": 0.15 },
      paint: { "text-color": c.boundary, "text-halo-color": c.textHalo, "text-halo-width": 1.5 },
    },
  );

  layers.push(
    {
      id: "world-cities-dot", type: "circle", source: "world-cities", maxzoom: 9,
      filter: ["any", [">=", ["get", "cap"], 2], ["all", ["==", ["get", "br"], 1], [">=", ["get", "cap"], 1]], [">=", ["zoom"], 4.5]],
      paint: {
        "circle-radius": ["case", [">=", ["get", "cap"], 1], 4, 3], "circle-color": c.text,
        "circle-stroke-color": c.textHalo, "circle-stroke-width": 1.5,
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 7.5, 1, 8.5, 0], "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 7.5, 1, 8.5, 0],
      },
    },
    {
      id: "world-cities", type: "symbol", source: "world-cities", maxzoom: 8.5,
      filter: ["any", ["all", ["==", ["get", "br"], 1], ["any", [">=", ["get", "cap"], 1], [">=", ["zoom"], 5]]], ["all", [">=", ["zoom"], 3], [">=", ["get", "cap"], 2]], [">=", ["zoom"], 5]],
      layout: {
        "text-field": ["get", "name"], "text-font": ["case", [">=", ["get", "cap"], 1], ["literal", FONT_BOLD], ["literal", FONT]],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 12, 8, 16], "text-anchor": "left", "text-offset": [0.6, 0],
        "symbol-sort-key": ["-", 0, ["get", "pop"]],
      },
      paint: { "text-color": c.text, "text-halo-color": c.textHalo, "text-halo-width": 2.2 },
    },
    {
      id: "world-state-names", type: "symbol", source: "world-labels", filter: ["==", ["get", "state"], 1], minzoom: 4.2, maxzoom: 7.5,
      layout: { "text-field": ["get", "name"], "text-font": FONT_BOLD, "text-size": 13, "text-transform": "uppercase", "text-letter-spacing": 0.08, "text-max-width": 7 },
      paint: { "text-color": c.stateLine, "text-halo-color": c.textHalo, "text-halo-width": 2 },
    },
    {
      id: "world-country-names", type: "symbol", source: "world-labels", maxzoom: 7,
      filter: ["all", ["!=", ["get", "state"], 1], ["<=", ["get", "rank"], ["+", 2, ["*", ["zoom"], 1.2]]]],
      layout: {
        "text-field": ["get", "name"], "text-font": FONT_BOLD, "text-max-width": 8,
        "text-size": ["interpolate", ["linear"], ["zoom"], 1, ["case", ["==", ["get", "a3"], "BRA"], 15, 11], 5, ["case", ["==", ["get", "a3"], "BRA"], 24, 15]],
        "text-letter-spacing": ["case", ["==", ["get", "a3"], "BRA"], 0.2, 0.05], "text-transform": "uppercase",
        "symbol-sort-key": ["case", ["==", ["get", "a3"], "BRA"], 0, ["get", "rank"]],
      },
      paint: { "text-color": ["case", ["==", ["get", "a3"], "BRA"], c.brazilBorder, c.text], "text-halo-color": c.textHalo, "text-halo-width": 2.4,
        "text-opacity": ["step", ["zoom"], 1, 4.2, ["case", ["==", ["get", "a3"], "BRA"], 0, 1]] },
    },
  );

  const world = (f) => ({ type: "geojson", data: origin + "/data/world/" + f + ".geojson", tolerance: 0.6 });
  const style = {
    version: 8,
    projection: { type: "globe" },
    name: "Voli " + theme,
    glyphs: origin + "/fonts/{fontstack}/{range}.pbf",
    sources: {
      vt: { type: "vector", tiles: ["vt://vector/{z}/{x}/{y}"], minzoom: 0, maxzoom: 14, attribution },
      "world-countries": { ...world("countries"), attribution: "Natural Earth" },
      "world-lakes": world("lakes"),
      "world-rivers": world("rivers"),
      "world-br-states": world("br_states"),
      "world-cities": world("cities"),
      "world-labels": world("labels"),
      dem: { type: "raster-dem", tiles: ["vt://terrain/{z}/{x}/{y}"], tileSize: 256, encoding: "mapbox", minzoom: 0, maxzoom: 11 },
      "dem-hs": { type: "raster-dem", tiles: ["vt://terrain/{z}/{x}/{y}"], tileSize: 256, encoding: "mapbox", minzoom: 0, maxzoom: 11 },
    },
    sky: {
      "sky-color": c.sky, "horizon-color": c.horizon, "fog-color": c.fog,
      "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.4, "atmosphere-blend": 0.5,
    },
    layers,
  };
  if (terrain) style.terrain = { source: "dem", exaggeration };
  return style;
}
