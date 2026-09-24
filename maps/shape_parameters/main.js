// Santo Domingo shape-parameters map -- based on maps/template (same visual
// language / no-backend approach). Buildings colored either by the 4-category
// shape index (fsi: regular/shape/eccentricity/slenderness -- see FSI_* below)
// or by one of 15 raw, physical-unit seismic-code shape/plan-irregularity
// metrics (EC8, NTC-23, GNDT-II, ASCE 7, CSCR-2010, slenderness -- see
// data/shape_parameters/prepare_shape_data.py, which computes these directly
// from footprint geometry via code/footprint_attributes, NOT the standardized
// ml_structural_system training features -- those can't be compared to a real
// code limit). Each of the 15 has a NORM_INFO entry (code limit + "good"
// direction, from footprint_attributes/config.py) driving both the building
// color ramp and the norm-exceedance chart.
const { GeoJsonLayer } = deck;
const { MapboxOverlay } = deck;

const DATASETS = {
  mata_redonda: { label: "Mata Redonda", dir: "../../data/shape_parameters/mata_redonda" },
  quisquella: { label: "Quisquella", dir: "../../data/shape_parameters/quisquella" },
  zona_1: { label: "Zona 1", dir: "../../data/shape_parameters/zona_1" },
};
const DEFAULT_DATASET = "mata_redonda";
const DATASET_CYCLE_MS = 10_000;
// Set by per-city copies (see this map's <city>/ subfolders) to lock
// video mode to one dataset instead of cycling through all of them
// every DATASET_CYCLE_MS.
const PINNED_DATASET = null;
const ACTIVE_DEFAULT_DATASET = PINNED_DATASET || DEFAULT_DATASET;
// The browser tab title should reflect whichever city is actually shown,
// not stay fixed at whatever HTML <title> shipped with the page.
const BASE_TITLE = document.title;
function updateTitle(datasetId) {
  document.title = `${DATASETS[datasetId].label} \u2013 ${BASE_TITLE}`;
}

// ---------------------------------------------------------------------------
// Norm limits -- see code/footprint_attributes/src/footprint_attributes/config.py
// for the source of every limit below. `worseIsHigh: false` marks the 4
// inverted-direction parameters (higher value = better): EC8 radiusRatio,
// EC8 compactness, and the two GNDT-II betas that use an inscribed-circle
// "how well does the building fill its own footprint" construction.
const NORM_INFO = {
  slenderness_bbox: { limit: 4.0, worseIsHigh: true, unit: "", criteria: "EC8: slenderness (bbox) ≤ 4.0" },
  slenderness_inertia: { limit: 4.0, worseIsHigh: true, unit: "", criteria: "EC8: slenderness (inertia) ≤ 4.0" },
  GNDTII_beta1_mainShapeSlenderness: { limit: 0.4, worseIsHigh: false, unit: "", criteria: "GNDT-II β1 ≥ 0.8" },
  GNDTII_beta2_setbackRatio: { limit: 0.3, worseIsHigh: true, unit: "", criteria: "GNDT-II β2 ≤ 0.1" },
  GNDTII_beta4_eccentricityRatio: { limit: 0.4, worseIsHigh: true, unit: "", criteria: "GNDT-II β4 ≤ 0.2" },
  GNDTII_beta6_setbackSlenderness: { limit: 0.25, worseIsHigh: false, unit: "", criteria: "GNDT-II β6 ≥ 0.5" },
  ASCE7_setbackRatio: { limit: 0.2, worseIsHigh: true, unit: "", criteria: "ASCE 7: setback ratio ≤ 0.20" },
  ASCE7_holeRatio: { limit: 0.25, worseIsHigh: true, unit: "", criteria: "ASCE 7: hole ratio ≤ 0.25" },
  ASCE7_parallelityAngle: { limit: 10, worseIsHigh: true, unit: "°", criteria: "ASCE 7: angle ≤ 5°" },
  EC8_eccentricityRatio: { limit: 0.3, worseIsHigh: true, unit: "", criteria: "EC8: eccentricity ≤ 0.30" },
  EC8_radiusRatio: { limit: 1.0, worseIsHigh: true, unit: "", criteria: "EC8: radius ratio ≤ 1.00" },
  EC8_compactness: { limit: 0.95, worseIsHigh: false, unit: "", criteria: "EC8: compactness ≥ 0.95" },
  NTC23_setbackRatio: { limit: 0.4, worseIsHigh: true, unit: "", criteria: "NTC-23: setback ratio ≤ 0.40" },
  NTC23_holeRatio: { limit: 0.4, worseIsHigh: true, unit: "", criteria: "NTC-23: hole ratio ≤ 0.40" },
  CSCR2010_eccentricityRatio: { limit: 0.25, worseIsHigh: true, unit: "", criteria: "CSCR-2010: eccentricity ≤ 0.05" },
};

// Video-cycle order: shape index first (per the brief), then round-robin
// across families (one slenderness, one GNDT, one ASCE7, one EC8, one NTC,
// one Costa Rica, repeat) so two columns from the same code never show back
// to back. This *is* the family order the "Color by" dropdown uses too.
const SHAPE_ATTRIBUTES = [
  { name: "shape_index", label: "Shape index" },
  { name: "slenderness_bbox", label: "Slenderness (bbox)" },
  { name: "GNDTII_beta1_mainShapeSlenderness", label: "GNDT-II β1 (slenderness)" },
  { name: "ASCE7_setbackRatio", label: "ASCE 7 setback ratio" },
  { name: "EC8_eccentricityRatio", label: "EC8 eccentricity ratio" },
  { name: "NTC23_setbackRatio", label: "NTC-23 setback ratio" },
  { name: "CSCR2010_eccentricityRatio", label: "CSCR-2010 eccentricity ratio" },
  { name: "slenderness_inertia", label: "Slenderness (inertia)" },
  { name: "GNDTII_beta2_setbackRatio", label: "GNDT-II β2 (setback ratio)" },
  { name: "ASCE7_holeRatio", label: "ASCE 7 hole ratio" },
  { name: "EC8_radiusRatio", label: "EC8 radius ratio" },
  { name: "NTC23_holeRatio", label: "NTC-23 hole ratio" },
  { name: "GNDTII_beta4_eccentricityRatio", label: "GNDT-II β4 (eccentricity ratio)" },
  { name: "ASCE7_parallelityAngle", label: "ASCE 7 parallelity angle" },
  { name: "EC8_compactness", label: "EC8 compactness" },
  { name: "GNDTII_beta6_setbackSlenderness", label: "GNDT-II β6 (setback slenderness)" },
];

// The "Color by" dropdown lists the same attributes grouped by norm/code
// family (EC8, then ASCE 7, then GNDT-II, then Costa Rica, then NTC-23) --
// a different, easier-to-scan order than the video's family-interleaved
// cycle above (SHAPE_ATTRIBUTES itself stays untouched for that).
const DROPDOWN_FAMILY_ORDER = ["shape_index", "EC8", "slenderness", "ASCE7", "GNDTII", "CSCR2010", "NTC23"];
function attributeFamily(name) {
  if (name === "shape_index") return "shape_index";
  if (name.startsWith("slenderness")) return "slenderness";
  const match = name.match(/^([A-Za-z0-9]+?)_/);
  return match ? match[1] : name;
}
const DROPDOWN_ATTRIBUTES = [...SHAPE_ATTRIBUTES].sort((a, b) => {
  const fa = DROPDOWN_FAMILY_ORDER.indexOf(attributeFamily(a.name));
  const fb = DROPDOWN_FAMILY_ORDER.indexOf(attributeFamily(b.name));
  return fa - fb;
});

// ---------------------------------------------------------------------------
// Shape index (fsi): a 4-category severity classification built from 3 of
// the 15 raw metrics (eccentricity, setback/"shape", slenderness), matching
// the exact thresholds+override order found in the paper's own analysis
// notebooks (Data/Datasets/paper_results.ipynb, validation_relative_position.ipynb):
// start "regular", eccentricity > 0.3 -> "eccentricity", setback ratio > 0.2
// -> "shape" (overrides eccentricity), slenderness > 4.0 -> "slenderness"
// (overrides everything) -- so slenderness always wins if triggered
// (worst), eccentricity is overridden by either of the other two (mildest).
const FSI_COLORS = { regular: "#4fbf8f", shape: "#e2793f", eccentricity: "#e2c23f", slenderness: "#c0392b" };
const FSI_ORDER = ["regular", "shape", "eccentricity", "slenderness"];
const FSI_LABELS = { regular: "Regular", shape: "Irregular: shape", eccentricity: "Irregular: eccentricity", slenderness: "Irregular: slenderness" };
function shapeIndexOf(feature) {
  const p = feature.properties ?? {};
  let key = "regular";
  if (typeof p.EC8_eccentricityRatio === "number" && p.EC8_eccentricityRatio > 0.3) key = "eccentricity";
  if (typeof p.ASCE7_setbackRatio === "number" && p.ASCE7_setbackRatio > 0.2) key = "shape";
  if (typeof p.slenderness_inertia === "number" && p.slenderness_inertia > 4.0) key = "slenderness";
  return key;
}

const DEFAULT_BUILDING_HEIGHT_M = 8;
const METRES_PER_FLOOR = 3;
const HEIGHT_EXAGGERATION = 2;
const SHOWCASE_PITCH = 55;
const SHOWCASE_ATTRIBUTE_CYCLE_MS = 10_000;
const SHOWCASE_IDLE_RESUME_MS = 30_000;
const SHOWCASE_ROTATE_DEG_PER_SEC = 2.2;

function hexToRgb(hex) {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function lerpColor(c1, c2, t) {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}
const UNLABELED_COLOR = hexToRgb("#9e9d94");
const GREEN = hexToRgb("#2ca02c");
const YELLOW = hexToRgb("#e2c23f");
const RED = hexToRgb("#c0392b");
const DEEP_RED = hexToRgb("#5c1a10");

const state = {
  datasetId: ACTIVE_DEFAULT_DATASET,
  data: { type: "FeatureCollection", features: [] },
  datasetCenter: null,
  attribute: SHAPE_ATTRIBUTES[0],
  normRanges: {}, // attribute name -> { good, bad, worst } raw values, recomputed per dataset
  is3D: true,
  selectedBuildingId: null,
  showcaseActive: false,
};

const URL_PARAMS = new URLSearchParams(location.search);
const DARK_THEME = URL_PARAMS.get("theme") === "dark";
if (DARK_THEME) document.body.classList.add("theme-dark");
const MAP_STYLE = DARK_THEME
  ? "https://tiles.openfreemap.org/styles/dark"
  : "https://tiles.openfreemap.org/styles/positron";
const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: [-69.94, 18.46],
  zoom: 15,
  pitch: SHOWCASE_PITCH,
  bearing: 0,
  attributionControl: false,
});

map.addControl(new maplibregl.AttributionControl({ compact: true }));
// MapLibre's compact attribution starts expanded (<details open>) on
// initial load regardless of the compact flag -- force it closed so the
// "i" button is always collapsed on startup.
(() => {
  const attribEl = document.querySelector(".maplibregl-ctrl-attrib");
  if (!attribEl) return;
  attribEl.removeAttribute("open");
  const observer = new MutationObserver(() => attribEl.removeAttribute("open"));
  observer.observe(attribEl, { attributes: true, attributeFilter: ["open"] });
  setTimeout(() => observer.disconnect(), 5000);
})();

const overlay = new MapboxOverlay({ layers: [] });
map.addControl(overlay);

map.setMaxPitch(85); // MapLibre's default 60 is too flat for a presentation "look straight down the street" shot

// Middle-button drag: does exactly what right-button drag does (MapLibre's
// own dragRotate -- horizontal movement changes bearing, vertical movement
// changes pitch), so rotate/tilt is reachable from either button, not
// right-only. preventDefault stops the browser's auto-scroll on a bare
// middle-click.
map.getCanvas().addEventListener("mousedown", (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  registerUserInteraction();
  let lastX = event.clientX;
  let lastY = event.clientY;
  const onMouseMove = (moveEvent) => {
    const dx = moveEvent.clientX - lastX;
    const dy = moveEvent.clientY - lastY;
    lastX = moveEvent.clientX;
    lastY = moveEvent.clientY;
    map.setBearing((map.getBearing() - dx * 0.5) % 360);
    const nextPitch = Math.min(85, Math.max(0, map.getPitch() - dy * 0.5));
    map.setPitch(nextPitch);
  };
  const onMouseUp = () => {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
});

function computeBbox(collection) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords) => {
    if (Array.isArray(coords) && typeof coords[0] === "number") {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    } else if (Array.isArray(coords)) {
      coords.forEach(visit);
    }
  };
  for (const f of collection.features) {
    if (f.geometry && "coordinates" in f.geometry) visit(f.geometry.coordinates);
  }
  return [[minX, minY], [maxX, maxY]];
}

function isSelected(feature) {
  return feature.properties?.building_uid === state.selectedBuildingId;
}
function rawHeightMetres(feature) {
  const p = feature.properties ?? {};
  if (typeof p.height === "number") return p.height;
  if (typeof p.n_floors === "number") return p.n_floors * METRES_PER_FLOOR;
  return DEFAULT_BUILDING_HEIGHT_M;
}
let elevationClamp = Infinity;
function elevationClampFor(data) {
  if (data.features.length === 0) return Infinity;
  const heights = data.features.map(rawHeightMetres).sort((a, b) => a - b);
  return heights[Math.floor(0.95 * (heights.length - 1))];
}
function getElevation(feature) {
  return Math.min(rawHeightMetres(feature), elevationClamp) * HEIGHT_EXAGGERATION;
}

// ---------------------------------------------------------------------------
// Norm-based good/bad percentiles + coloring. "Badness" is the value put in
// a direction-agnostic form (higher badness always = worse), so both normal
// and inverted-direction params share the same math.
function badnessOf(value, info) {
  return info.worseIsHigh ? value : -value;
}
function valueAtBadness(badness, info) {
  return info.worseIsHigh ? badness : -badness;
}
function percentileOf(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(p * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

// Computes, for one attribute in the current dataset, the color anchors:
// - "good": among buildings that COMPLY with the norm limit, the value at
//   the 5th percentile of badness (i.e. the cutoff separating the best 5%
//   of compliant buildings from the rest) -- pure GREEN at or better than
//   this.
// - "bad": among buildings that FAIL the limit, the value at the 70th
//   percentile of badness (the cutoff for the worst 30% of failing
//   buildings) -- or the limit itself if nobody fails. DEEP_RED at or worse
//   than this.
// Compliant buildings ramp GREEN -> YELLOW approaching the limit; anything
// past the limit is immediately RED, ramping to DEEP_RED at "bad" -- so
// "worse than the limit" always reads as red, never yellow/orange, no
// matter how the fixed limit value happens to sit relative to the
// population (the previous "mediocre"-anchored scheme could stretch the
// yellow zone across the whole practical range for a very strict or very
// lax norm).
function computeNormRange(data, name) {
  const info = NORM_INFO[name];
  const values = data.features.map((f) => f.properties?.[name]).filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (values.length === 0 || !info) return null;
  const limitBadness = badnessOf(info.limit, info);
  const badnesses = values.map((v) => badnessOf(v, info)).sort((a, b) => a - b);
  const compliant = badnesses.filter((b) => b <= limitBadness);
  const failing = badnesses.filter((b) => b > limitBadness);
  const goodBadness = compliant.length > 0 ? percentileOf(compliant, 0.05) : limitBadness;
  const badBadness = failing.length > 0 ? percentileOf(failing, 0.7) : limitBadness;
  const worstBadness = badnesses[badnesses.length - 1];
  const anyExceeds = failing.length > 0;
  // The chart's axis must always reach at least as far as the norm limit
  // (otherwise the limit marker/line has nowhere to sit and disappears).
  const axisEndBadness = anyExceeds ? Math.max(badBadness, limitBadness) : limitBadness;
  return {
    good: valueAtBadness(goodBadness, info),
    bad: valueAtBadness(badBadness, info),
    worst: valueAtBadness(worstBadness, info),
    axisEnd: valueAtBadness(axisEndBadness, info),
    anyExceeds,
  };
}
function computeAllNormRanges(data) {
  for (const name of Object.keys(NORM_INFO)) state.normRanges[name] = computeNormRange(data, name);
}

// The 4 badness breakpoints (good/mid/limit/bad) driving both the building
// color ramp and the chart's fill gradient -- a smooth green -> yellow ->
// light-red -> deep-red gradient, with light red landing right at the norm
// limit (not deep into the failing zone), so "worse than the limit" reads
// as clearly red rather than lingering in yellow/orange. `mid` (yellow) sits
// halfway between good and the limit, entirely within the compliant range.
// `good` and `bad` are already guaranteed on the correct side of `limit` by
// construction (computed from the compliant/failing subsets respectively).
function normBreakpoints(info, range) {
  const bGood = badnessOf(range.good, info);
  const bLimit = Math.max(badnessOf(info.limit, info), bGood);
  const bMid = bGood + (bLimit - bGood) / 2;
  const bBad = Math.max(badnessOf(range.bad, info), bLimit + 1e-9);
  return { bGood, bMid, bLimit, bBad };
}

function colorForNormValue(value, info, range) {
  if (typeof value !== "number" || Number.isNaN(value) || !range) return UNLABELED_COLOR;
  const b = badnessOf(value, info);
  const { bGood, bMid, bLimit, bBad } = normBreakpoints(info, range);
  if (b <= bGood) return GREEN;
  if (b <= bMid) return lerpColor(GREEN, YELLOW, (b - bGood) / Math.max(1e-9, bMid - bGood));
  if (b <= bLimit) return lerpColor(YELLOW, RED, (b - bMid) / Math.max(1e-9, bLimit - bMid));
  if (b >= bBad) return DEEP_RED;
  return lerpColor(RED, DEEP_RED, (b - bLimit) / Math.max(1e-9, bBad - bLimit));
}

function getFillColor(feature) {
  if (state.attribute.name === "shape_index") {
    return [...hexToRgb(FSI_COLORS[shapeIndexOf(feature)]), 210];
  }
  const info = NORM_INFO[state.attribute.name];
  const range = state.normRanges[state.attribute.name];
  const value = feature.properties?.[state.attribute.name];
  return [...colorForNormValue(value, info, range), 210];
}
function getLineColor(feature) {
  return isSelected(feature) ? [...hexToRgb("#e2a33f"), 255] : [235, 235, 235, 90];
}
function getLineWidth(feature) {
  return isSelected(feature) ? 3 : 1;
}

let onBuildingClick = () => {};

function buildingTooltip({ object, layer }) {
  if (!object || !layer?.id?.startsWith("buildings-")) return null;
  if (state.attribute.name === "shape_index") {
    return { html: `<div><strong>Shape index:</strong> ${FSI_LABELS[shapeIndexOf(object)]}</div><div class="hint" style="margin-top:4px">Click for full details</div>`, className: "deck-tooltip" };
  }
  const value = object.properties?.[state.attribute.name];
  const info = NORM_INFO[state.attribute.name];
  const shown = typeof value === "number" ? `${value.toFixed(3)}${info?.unit ?? ""}` : "n/a";
  return { html: `<div><strong>${state.attribute.label}:</strong> ${shown}</div><div class="hint" style="margin-top:4px">Click for full details</div>`, className: "deck-tooltip" };
}

function renderLayer() {
  const buildings = new GeoJsonLayer({
    id: `buildings-${state.datasetId}`,
    data: state.data,
    filled: true,
    stroked: true,
    pickable: true,
    extruded: state.is3D,
    getElevation,
    getFillColor,
    getLineColor,
    getLineWidth,
    lineWidthUnits: "pixels",
    lineWidthMinPixels: 1,
    updateTriggers: {
      getFillColor: [state.attribute.name],
      getLineColor: [state.selectedBuildingId],
      getLineWidth: [state.selectedBuildingId],
      getElevation: [state.is3D],
    },
    onClick: (info) => {
      const id = info.object?.properties?.building_uid;
      if (id !== undefined && id !== null) onBuildingClick(String(id), info.object.properties);
    },
  });
  overlay.setProps({ layers: [buildings], getTooltip: buildingTooltip });
}

// ---------------------------------------------------------------------------
// Legend -- shape index: 4 categorical swatches. Norm params: a green-yellow-
// red gradient bar with good/limit/bad tick labels.
function renderLegend() {
  const container = document.getElementById("legend");
  container.innerHTML = "";
  const heading = document.createElement("h2");
  heading.textContent = state.attribute.label;
  container.appendChild(heading);

  if (state.attribute.name === "shape_index") {
    const list = document.createElement("ul");
    list.className = "legend-list";
    for (const key of FSI_ORDER) {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = FSI_COLORS[key];
      const label = document.createElement("span");
      label.textContent = FSI_LABELS[key];
      item.append(swatch, label);
      list.appendChild(item);
    }
    container.appendChild(list);
    return;
  }

  const info = NORM_INFO[state.attribute.name];
  const range = state.normRanges[state.attribute.name];
  const fmt = (v) => (typeof v === "number" ? `${v.toFixed(2)}${info.unit ?? ""}` : "–");
  if (!range) {
    container.innerHTML += '<p class="hint">No data.</p>';
    return;
  }
  const { bGood, bMid, bLimit, bBad } = normBreakpoints(info, range);
  const pct = (b) => (bBad === bGood ? 0 : ((b - bGood) / (bBad - bGood)) * 100);
  const gradient = document.createElement("div");
  gradient.className = "norm-gradient";
  gradient.style.background = `linear-gradient(90deg, #2ca02c 0%, #e2c23f ${pct(bMid).toFixed(0)}%, #c0392b ${pct(bLimit).toFixed(0)}%, #5c1a10 100%)`;
  container.appendChild(gradient);
  const ticks = document.createElement("div");
  ticks.className = "norm-gradient-ticks";
  ticks.innerHTML = `<span>Good: ${fmt(range.good)}</span><span>Limit: ${fmt(info.limit)}</span><span>Bad: ${fmt(range.bad)}</span>`;
  container.appendChild(ticks);
}

// ---------------------------------------------------------------------------
// Norm-exceedance chart: x-axis from the "good" end to the norm limit (or,
// if some buildings exceed it, out to the "bad" 90th-badness-percentile
// value instead, so the exceeding tail stays visible). The line is the % of
// buildings "that value or worse", read left (near 100%) to right (near 0%).
const CHART_WIDTH = 280;
const CHART_HEIGHT = 165;
const CHART_MARGIN = { top: 14, right: 10, bottom: 26, left: 34 };
const CHART_STEPS = 40;

function renderNormChart() {
  const container = document.getElementById("norm-chart");
  const belowText = document.getElementById("norm-chart-caption");
  const card = document.getElementById("norm-chart-card");
  if (state.attribute.name === "shape_index") {
    card.classList.add("hidden");
    container.innerHTML = "";
    belowText.textContent = "";
    return;
  }
  card.classList.remove("hidden");
  document.getElementById("chart-title").textContent = state.attribute.label;
  const info = NORM_INFO[state.attribute.name];
  const range = state.normRanges[state.attribute.name];
  const values = state.data.features.map((f) => f.properties?.[state.attribute.name]).filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!info || !range || values.length === 0) {
    container.innerHTML = '<p class="hint">No data.</p>';
    belowText.textContent = "";
    return;
  }
  const total = values.length;
  const badnesses = values.map((v) => badnessOf(v, info));

  const xStart = range.good; // good end
  const xEnd = range.axisEnd; // limit, or bad percentile if some exceed it
  const bStart = badnessOf(xStart, info);
  const bEnd = badnessOf(xEnd, info);

  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const plotBottom = CHART_HEIGHT - CHART_MARGIN.top;

  // % of buildings with badness >= b(x), for x stepped from good to bad.
  const points = [];
  for (let i = 0; i <= CHART_STEPS; i++) {
    const t = i / CHART_STEPS;
    const b = lerp(bStart, bEnd, t);
    const worseOrEqualCount = badnesses.filter((bb) => bb >= b).length;
    const pct = (worseOrEqualCount / total) * 100;
    const x = CHART_MARGIN.left + t * plotWidth;
    const y = CHART_MARGIN.top + (1 - pct / 100) * plotHeight;
    points.push([x, y]);
  }

  // Filled area under the curve, colored by a per-x smooth green-yellow-red
  // gradient (an SVG gradient along x, anchored at good/mid/limit/bad --
  // same breakpoints as the building color ramp, see normBreakpoints/
  // colorForNormValue). The limit is a fixed code value that can land
  // outside the axis's own [good, axisEnd] domain for a very strict or very
  // lax norm -- clamp it to bStart so the gradient stops stay monotonic.
  const bLimitRaw = badnessOf(info.limit, info);
  const bLimit = Math.max(bLimitRaw, bStart);
  const bMid = bStart + (bLimit - bStart) / 2;
  const denom = bEnd - bStart;
  const pct2 = (b) => (denom === 0 ? 0 : Math.max(0, Math.min(100, ((b - bStart) / denom) * 100)));
  const gradId = `normGrad-${state.attribute.name}`;
  // Green -> yellow across the compliant range, with light red landing
  // right at the limit (not deep into the failing zone), darkening toward
  // deep red beyond it.
  const gradientDef = `<linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#2ca02c"></stop>
    <stop offset="${pct2(bMid)}%" stop-color="#e2c23f"></stop>
    <stop offset="${pct2(bLimit)}%" stop-color="#c0392b"></stop>
    <stop offset="100%" stop-color="#5c1a10"></stop>
  </linearGradient>`;

  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${plotBottom} L${points[0][0].toFixed(1)},${plotBottom} Z`;

  // Vertical red marker at the true norm limit (if it falls within the
  // axis) -- uses the real, unclamped limit badness, since the fill
  // gradient's clamping above is a color-scale rendering concern only and
  // must not affect the actual compliance count/position shown here.
  let limitMarker = "";
  const worseThanLimitCount = badnesses.filter((bb) => bb >= bLimitRaw).length;
  const worseThanLimitPct = ((worseThanLimitCount / total) * 100).toFixed(1);
  if (bLimitRaw >= Math.min(bStart, bEnd) && bLimitRaw <= Math.max(bStart, bEnd)) {
    const t = denom === 0 ? 0 : (bLimitRaw - bStart) / denom;
    const lx = CHART_MARGIN.left + t * plotWidth;
    limitMarker = `<line x1="${lx.toFixed(1)}" y1="${CHART_MARGIN.top}" x2="${lx.toFixed(1)}" y2="${plotBottom}" stroke="#c0392b" stroke-width="3"></line>
      <text x="${lx.toFixed(1)}" y="${CHART_MARGIN.top - 4}" text-anchor="${t > 0.7 ? "end" : "start"}" class="chart-axis-label" fill="#e2938a">${worseThanLimitCount} (${worseThanLimitPct}%) worse</text>`;
  }

  let yAxisLabels = "";
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const y = plotBottom - t * plotHeight;
    yAxisLabels += `<text x="${CHART_MARGIN.left - 6}" y="${y + 3}" text-anchor="end" class="chart-axis-label">${Math.round(t * 100)}%</text>`;
  }
  // At least 4 x-axis ticks, showing the actual parameter value at each
  // point (not just the "Good"/"Bad" end labels).
  const fmt = (v) => `${v.toFixed(2)}${info.unit ?? ""}`;
  let xAxisLabels = "";
  const TICK_COUNT = 5;
  for (let i = 0; i < TICK_COUNT; i++) {
    const t = i / (TICK_COUNT - 1);
    const tickValue = valueAtBadness(lerp(bStart, bEnd, t), info);
    const x = CHART_MARGIN.left + t * plotWidth;
    const anchor = i === 0 ? "start" : i === TICK_COUNT - 1 ? "end" : "middle";
    xAxisLabels += `<text x="${x.toFixed(1)}" y="${plotBottom + 16}" text-anchor="${anchor}" class="chart-axis-label">${fmt(tickValue)}</text>`;
  }

  container.innerHTML = `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}">
    <defs>${gradientDef}</defs>
    <path d="${areaPath}" fill="url(#${gradId})" opacity="0.55"></path>
    <path d="${linePath}" fill="none" stroke="#edf1f3" stroke-width="1.6"></path>
    <line x1="${CHART_MARGIN.left}" y1="${plotBottom}" x2="${CHART_WIDTH - CHART_MARGIN.right}" y2="${plotBottom}" stroke="rgba(255,255,255,0.18)"></line>
    <line x1="${CHART_MARGIN.left}" y1="${CHART_MARGIN.top}" x2="${CHART_MARGIN.left}" y2="${plotBottom}" stroke="rgba(255,255,255,0.18)"></line>
    ${yAxisLabels}
    ${xAxisLabels}
    ${limitMarker}
  </svg>`;

  const compliantCount = total - worseThanLimitCount;
  const compliantPct = (100 - Number(worseThanLimitPct)).toFixed(1);
  belowText.innerHTML = `${info.criteria}<br>Compliance: ${compliantCount} of ${total} (${compliantPct}%)`;
}

// ---------------------------------------------------------------------------
// Shape index chart -- always visible below whatever norm chart is active.
const FSI_CHART_MARGIN = { top: 36, right: 10, bottom: 46, left: 34 };

function renderShapeIndexChart() {
  const container = document.getElementById("shape-index-chart");
  const counts = { regular: 0, shape: 0, eccentricity: 0, slenderness: 0 };
  for (const f of state.data.features) counts[shapeIndexOf(f)] += 1;
  const total = state.data.features.length || 1;

  const plotWidth = CHART_WIDTH - FSI_CHART_MARGIN.left - FSI_CHART_MARGIN.right;
  const plotHeight = CHART_HEIGHT - FSI_CHART_MARGIN.top - FSI_CHART_MARGIN.bottom;
  const maxCount = Math.max(1, ...FSI_ORDER.map((k) => counts[k]));
  const barGap = 10;
  const barWidth = (plotWidth - barGap * (FSI_ORDER.length - 1)) / FSI_ORDER.length;
  const plotBottom = FSI_CHART_MARGIN.top + plotHeight;

  let bars = "";
  let labels = "";
  FSI_ORDER.forEach((key, i) => {
    const count = counts[key];
    const barHeight = (count / maxCount) * plotHeight;
    const x = FSI_CHART_MARGIN.left + i * (barWidth + barGap);
    const y = plotBottom - barHeight;
    const pct = ((count / total) * 100).toFixed(1);
    const cx = x + barWidth / 2;
    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${FSI_COLORS[key]}" rx="3"></rect>`;
    bars += `<text x="${cx}" y="${y - 24}" text-anchor="middle" class="chart-bar-label"><tspan x="${cx}" dy="0">${count}</tspan><tspan x="${cx}" dy="14">${pct}%</tspan></text>`;
    labels += `<text x="${cx + 4}" y="${plotBottom + 12}" text-anchor="end" class="chart-axis-label" transform="rotate(-40 ${cx + 4} ${plotBottom + 12})">${FSI_LABELS[key].replace("Irregular: ", "")}</text>`;
  });

  let yAxisLabels = "";
  for (const t of [0, 0.5, 1]) {
    const y = plotBottom - t * plotHeight;
    yAxisLabels += `<text x="${FSI_CHART_MARGIN.left - 6}" y="${y + 3}" text-anchor="end" class="chart-axis-label">${Math.round(maxCount * t)}</text>`;
  }

  container.innerHTML = `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}">
    <line x1="${FSI_CHART_MARGIN.left}" y1="${plotBottom}" x2="${CHART_WIDTH - FSI_CHART_MARGIN.right}" y2="${plotBottom}" stroke="rgba(255,255,255,0.18)"></line>
    <line x1="${FSI_CHART_MARGIN.left}" y1="${FSI_CHART_MARGIN.top}" x2="${FSI_CHART_MARGIN.left}" y2="${plotBottom}" stroke="rgba(255,255,255,0.18)"></line>
    ${yAxisLabels}
    ${bars}
    ${labels}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Building popup -- every shape metric for this building (not just the
// currently-selected "Color by" one), plus its shape-index category.
function renderBuildingPanel(id, properties) {
  const panel = document.getElementById("building-panel");
  const content = document.getElementById("building-panel-content");
  content.innerHTML = "";
  const heading = document.createElement("h2");
  heading.textContent = `Building ${id}`;
  content.appendChild(heading);

  const table = document.createElement("table");
  table.className = "building-summary";
  const tbody = document.createElement("tbody");

  const fsiRow = document.createElement("tr");
  const fsiTh = document.createElement("th");
  fsiTh.textContent = "Shape index";
  const fsiTd = document.createElement("td");
  fsiTd.textContent = FSI_LABELS[shapeIndexOf({ properties })];
  fsiRow.append(fsiTh, fsiTd);
  tbody.appendChild(fsiRow);

  for (const { name, label } of SHAPE_ATTRIBUTES) {
    if (name === "shape_index") continue;
    const value = properties[name];
    if (typeof value !== "number") continue;
    const info = NORM_INFO[name];
    const row = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = label;
    const td = document.createElement("td");
    td.textContent = `${value.toFixed(3)}${info?.unit ?? ""}`;
    const isNonCompliant = info && badnessOf(value, info) > badnessOf(info.limit, info);
    if (isNonCompliant) {
      th.classList.add("non-compliant");
      td.classList.add("non-compliant");
    }
    row.append(th, td);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  content.appendChild(table);
  panel.classList.remove("hidden");
}
function closeBuildingPanel() {
  document.getElementById("building-panel").classList.add("hidden");
  state.selectedBuildingId = null;
  renderLayer();
}
function selectBuilding(id, properties) {
  state.selectedBuildingId = id;
  renderLayer();
  renderBuildingPanel(id, properties);
}
onBuildingClick = selectBuilding;

// ---------------------------------------------------------------------------
// Attribute (color-by) switching.
let attributeDropdown = null;
function setAttribute(attribute, { fromShowcase = false } = {}) {
  state.attribute = attribute;
  attributeDropdown?.setValue(attribute.name);
  renderLegend();
  renderNormChart();
  renderLayer();
  if (!fromShowcase) stopShowcase({ resumeAfterIdle: true });
}

// ---------------------------------------------------------------------------
// Dataset switching.
let datasetDropdown = null;

async function loadDataset(datasetId) {
  const dir = DATASETS[datasetId].dir;
  const buildings = await fetch(`${dir}/buildings.geojson`).then((r) => r.json());
  state.datasetId = datasetId;
  state.data = buildings;
  elevationClamp = elevationClampFor(buildings);
  computeAllNormRanges(buildings);

  const [[minX, minY], [maxX, maxY]] = computeBbox(buildings);
  state.datasetCenter = { lng: (minX + maxX) / 2, lat: (minY + maxY) / 2 };

  renderLegend();
  renderNormChart();
  renderShapeIndexChart();
  renderLayer();
}

async function setDataset(datasetId, { fromShowcase = false } = {}) {
  await loadDataset(datasetId);
  var __h1 = document.querySelector(".subtitle"); if (__h1) __h1.textContent = DATASETS[datasetId].label;
  updateTitle(datasetId);
  datasetDropdown?.setValue(datasetId);
  const [[minX, minY], [maxX, maxY]] = computeBbox(state.data);
  map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 60, duration: fromShowcase ? 0 : 500 });
  if (!fromShowcase) stopShowcase({ resumeAfterIdle: true });
}

function createDropdown(container, options, onChange) {
  container.innerHTML = "";
  container.classList.add("dropdown");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dropdown-toggle";
  const valueEl = document.createElement("span");
  valueEl.className = "dropdown-value";
  toggle.appendChild(valueEl);
  const caret = document.createElement("span");
  caret.className = "dropdown-caret";
  caret.textContent = "▾";
  toggle.appendChild(caret);

  const list = document.createElement("ul");
  list.className = "dropdown-list";
  list.hidden = true;

  function renderOptions(current) {
    list.innerHTML = "";
    for (const option of options) {
      const item = document.createElement("li");
      item.textContent = option.label;
      if (option.value === current) item.classList.add("selected");
      item.addEventListener("click", () => {
        onChange(option.value);
        close();
      });
      list.appendChild(item);
    }
  }
  function close() {
    list.hidden = true;
    container.removeAttribute("data-open");
  }
  function open() {
    list.hidden = false;
    container.setAttribute("data-open", "");
  }
  toggle.addEventListener("click", () => (list.hidden ? open() : close()));
  document.addEventListener("click", (event) => {
    if (!container.contains(event.target)) close();
  });

  container.append(toggle, list);
  renderOptions(options[0]?.value);

  return {
    setValue(value) {
      const option = options.find((o) => o.value === value);
      if (option) valueEl.textContent = option.label;
      renderOptions(value);
    },
  };
}

// ---------------------------------------------------------------------------
// Showcase mode: orbit the dataset center in 3D; every 10s advance to the
// next attribute in SHAPE_ATTRIBUTES's own order (shape index first, then
// family-interleaved).
let showcaseRotateFrame = null;
let showcaseAttributeTimer = null;
let showcaseIdleTimer = null;

let showcaseDatasetTimer = null;

function scheduleDatasetCycle() {
  if (PINNED_DATASET) return; // this page is locked to one city
  const ids = Object.keys(DATASETS);
  if (ids.length < 2) return;
  showcaseDatasetTimer = setTimeout(() => {
    if (!state.showcaseActive) return;
    const next = ids[(ids.indexOf(state.datasetId) + 1) % ids.length];
    setDataset(next, { fromShowcase: true }).then(scheduleDatasetCycle);
  }, DATASET_CYCLE_MS);
}
function stopDatasetCycle() {
  if (showcaseDatasetTimer !== null) clearTimeout(showcaseDatasetTimer);
  showcaseDatasetTimer = null;
}

let showcaseAttributeIndex = 0;

function startShowcase() {
  if (state.showcaseActive) return;
  state.showcaseActive = true;
  scheduleDatasetCycle();

  if (state.is3D) {
    const [[minX, minY], [maxX, maxY]] = computeBbox(state.data);
    map.jumpTo({ center: [(minX + maxX) / 2, (minY + maxY) / 2] });
    let lastFrameTime = performance.now();
    const rotate = (now) => {
      const dt = (now - lastFrameTime) / 1000;
      lastFrameTime = now;
      map.setBearing((map.getBearing() + SHOWCASE_ROTATE_DEG_PER_SEC * dt) % 360);
      showcaseRotateFrame = requestAnimationFrame(rotate);
    };
    showcaseRotateFrame = requestAnimationFrame(rotate);
  }

  setAttribute(SHAPE_ATTRIBUTES[showcaseAttributeIndex], { fromShowcase: true });
  showcaseAttributeTimer = setInterval(() => {
    showcaseAttributeIndex = (showcaseAttributeIndex + 1) % SHAPE_ATTRIBUTES.length;
    setAttribute(SHAPE_ATTRIBUTES[showcaseAttributeIndex], { fromShowcase: true });
  }, SHOWCASE_ATTRIBUTE_CYCLE_MS);
}

function stopShowcase({ resumeAfterIdle = true } = {}) {
  stopDatasetCycle();
  if (showcaseRotateFrame !== null) cancelAnimationFrame(showcaseRotateFrame);
  if (showcaseAttributeTimer !== null) clearInterval(showcaseAttributeTimer);
  showcaseRotateFrame = null;
  showcaseAttributeTimer = null;
  state.showcaseActive = false;

  if (showcaseIdleTimer !== null) clearTimeout(showcaseIdleTimer);
  if (resumeAfterIdle) showcaseIdleTimer = setTimeout(startShowcase, SHOWCASE_IDLE_RESUME_MS);
}
function registerUserInteraction() {
  stopShowcase({ resumeAfterIdle: true });
}
["dragstart", "zoomstart", "rotatestart", "pitchstart"].forEach((event) => {
  map.on(event, (e) => {
    if (e.originalEvent) registerUserInteraction();
  });
});
map.on("click", () => registerUserInteraction());

function toggle3D(forceOn) {
  state.is3D = forceOn ?? !state.is3D;
  const nextPitch = state.is3D ? (map.getPitch() > 0 ? map.getPitch() : SHOWCASE_PITCH) : 0;
  map.easeTo({ pitch: nextPitch, duration: 500 });
  document.getElementById("view-3d-toggle").classList.toggle("active", state.is3D);
  renderLayer();
}
function resetOrientation() {
  map.easeTo({ bearing: 0, pitch: state.is3D ? SHOWCASE_PITCH : 0, duration: 500 });
}

async function bootstrap() {
  datasetDropdown = createDropdown(
    document.getElementById("dataset-select"),
    Object.entries(DATASETS).map(([value, { label }]) => ({ value, label })),
    (value) => setDataset(value),
  );
  attributeDropdown = createDropdown(
    document.getElementById("attribute-select"),
    DROPDOWN_ATTRIBUTES.map((a) => ({ value: a.name, label: a.label })),
    (value) => setAttribute(SHAPE_ATTRIBUTES.find((a) => a.name === value)),
  );
  attributeDropdown.setValue(state.attribute.name);

  await loadDataset(ACTIVE_DEFAULT_DATASET);
  { const __h1 = document.querySelector(".subtitle"); if (__h1) __h1.textContent = DATASETS[ACTIVE_DEFAULT_DATASET].label; }
  updateTitle(ACTIVE_DEFAULT_DATASET);
  datasetDropdown.setValue(ACTIVE_DEFAULT_DATASET);
  const [[minX, minY], [maxX, maxY]] = computeBbox(state.data);
  map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 60, duration: 0 });

  document.getElementById("controls-toggle").addEventListener("click", (event) => {
    document.getElementById("controls-fields").classList.toggle("hidden");
    event.currentTarget.classList.toggle("collapsed");
  });
  document.getElementById("legend-toggle").addEventListener("click", (event) => {
    document.getElementById("legend").classList.toggle("hidden");
    event.currentTarget.classList.toggle("active");
  });
  document.getElementById("charts-toggle").addEventListener("click", (event) => {
    document.getElementById("charts-panel").classList.toggle("hidden");
    event.currentTarget.classList.toggle("active");
  });
  document.getElementById("view-3d-toggle").addEventListener("click", () => {
    toggle3D();
    registerUserInteraction();
  });
  document.getElementById("reorient-toggle").addEventListener("click", () => {
    resetOrientation();
    registerUserInteraction();
  });
  document.getElementById("resume-showcase-toggle").addEventListener("click", () => {
    if (state.showcaseActive) stopShowcase({ resumeAfterIdle: false });
    else startShowcase();
  });
  document.getElementById("settings-toggle").addEventListener("click", () => {
    document.getElementById("settings-panel").classList.toggle("hidden");
  });
  document.getElementById("settings-panel-close").addEventListener("click", () => {
    document.getElementById("settings-panel").classList.add("hidden");
  });
  document.getElementById("building-panel-close").addEventListener("click", closeBuildingPanel);

  startShowcase();
}

map.on("load", () => {
  bootstrap().catch((error) => {
    console.error(error);
    const controls = document.getElementById("controls-body");
    const message = document.createElement("p");
    message.className = "error";
    message.textContent = `Failed to load: ${error.message}. Serve this folder over HTTP so fetch() can read the data files.`;
    controls.appendChild(message);
  });
});
