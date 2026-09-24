// Sevilla pilot-region "relative position -- force arrows" map. Identical
// data and controls to maps/relative_position, but dedicated to the
// contact-force overlay: defaults to a flat 2D view with the force arrows
// already on (2D reads the vectors far better than an extruded 3D view),
// and its video mode holds that 2D+arrows view still rather than orbiting
// (see maps/relative_position for the plain 3D orbiting video mode).
const { GeoJsonLayer } = deck;
const { MapboxOverlay } = deck;
const { PathStyleExtension } = deck;

const DATASETS = {
  mata_redonda: { label: "Mata Redonda", dir: "../../../../data/relative_position/mata_redonda" },
  quisquella: { label: "Quisquella", dir: "../../../../data/relative_position/quisquella" },
  zona_1: { label: "Zona 1", dir: "../../../../data/relative_position/zona_1" },
};
const DEFAULT_DATASET = "mata_redonda";
const DATASET_CYCLE_MS = 10_000;
// Set by per-city copies (see this map's <city>/ subfolders) to lock
// video mode to one dataset instead of cycling through all of them
// every DATASET_CYCLE_MS.
const PINNED_DATASET = "quisquella";
const ACTIVE_DEFAULT_DATASET = PINNED_DATASET || DEFAULT_DATASET;
// The browser tab title should reflect whichever city is actually shown,
// not stay fixed at whatever HTML <title> shipped with the page.
const BASE_TITLE = document.title;
function updateTitle(datasetId) {
  document.title = `${DATASETS[datasetId].label} \u2013 ${BASE_TITLE}`;
}

// Force-arrows overlay: per-wall contact-force vectors ("contact_force_edge")
// plus the net resultant per building ("contact_force_resultant"), both from
// footprint_attributes.position.contact_force_vectors, written by
// data/prepare_data.py to overlays/position_arrows.geojson alongside each
// dataset's buildings.geojson (see footprint_attributes' own
// examples/position.ipynb, which draws the same two layers). The resultant
// is the thicker, solid, black arrow (its length is also pre-shortened in
// data/prepare_data.py so it doesn't dwarf the building); each individual
// wall's force is an even thicker dotted black line -- at the old thin
// width these were nearly invisible next to the resultant.
const FORCE_ARROWS_COLOR = "#111111";
const FORCE_ARROWS_EDGE_WIDTH = 2.5;
const FORCE_ARROWS_RESULTANT_WIDTH = 5;

const POSITION_COLORS = {
  isolated: "#4299e1",
  lateral: "#e2a33f",
  corner: "#4fbf8f",
  confined: "#8744ad",
  torque: "#c0392b",
  unlabeled: "#6b7280",
};
const POSITION_ORDER = ["isolated", "lateral", "corner", "confined", "torque", "unlabeled"];
const POSITION_LABELS = {
  isolated: "Isolated",
  lateral: "Lateral",
  corner: "Corner",
  confined: "Confined",
  torque: "Torque",
  unlabeled: "Unlabeled",
};

const DEFAULT_BUILDING_HEIGHT_M = 8;
const METRES_PER_FLOOR = 3;
const HEIGHT_EXAGGERATION = 2;
const SHOWCASE_PITCH = 55;
const SHOWCASE_IDLE_RESUME_MS = 30_000;
const SHOWCASE_ROTATE_DEG_PER_SEC = 2.2;

function hexToRgb(hex) {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const state = {
  datasetId: ACTIVE_DEFAULT_DATASET,
  data: { type: "FeatureCollection", features: [] },
  datasetCenter: null,
  is3D: false, // this map is about reading the force arrows -- 2D by default
  selectedBuildingId: null,
  showcaseActive: false,
  forceArrowsActive: true, // on by default, this map's whole purpose
  forceArrowsData: null,
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
  pitch: 0,
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

// This map is about reading the force arrows on individual buildings, not
// surveying the whole AOI at once -- a plain fitBounds zooms out far enough
// that the arrows turn into illegible specks. Zoom in past the bounds-fit
// level even if that crops some of the AOI off-screen.
const EXTRA_ZOOM = 1.6;
function fitBoundsCloser(bounds, { duration = 0 } = {}) {
  const camera = map.cameraForBounds(bounds, { padding: 60 });
  if (!camera) {
    map.fitBounds(bounds, { padding: 60, duration });
    return;
  }
  map.easeTo({ center: camera.center, zoom: camera.zoom + EXTRA_ZOOM, duration });
}

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

function positionKey(feature) {
  const value = feature.properties?.relativePosition;
  return value && POSITION_COLORS[value] ? value : "unlabeled";
}

function getFillColor(feature) {
  return [...hexToRgb(POSITION_COLORS[positionKey(feature)]), 210];
}
function getLineColor(feature) {
  return isSelected(feature) ? [...hexToRgb("#e2a33f"), 255] : [30, 30, 30, 170];
}
function getLineWidth(feature) {
  return isSelected(feature) ? 3 : 1;
}

let onBuildingClick = () => {};

function buildingTooltip({ object, layer }) {
  if (!object || !layer?.id?.startsWith("buildings-")) return null;
  const label = POSITION_LABELS[positionKey(object)];
  return { html: `<div><strong>Relative position:</strong> ${label}</div><div class="hint" style="margin-top:4px">Click for full details</div>`, className: "deck-tooltip" };
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
      getLineColor: [state.selectedBuildingId],
      getLineWidth: [state.selectedBuildingId],
      getElevation: [state.is3D],
    },
    onClick: (info) => {
      const id = info.object?.properties?.building_uid;
      if (id !== undefined && id !== null) onBuildingClick(String(id), info.object.properties);
    },
  });

  const layers = [buildings];
  if (state.forceArrowsActive && state.forceArrowsData) {
    const byPart = (kind, part) =>
      state.forceArrowsData.features.filter((f) => f.properties?.kind === kind && f.properties?.part === part);
    const edgeShaftFeatures = byPart("contact_force_edge", "shaft");
    const edgeHeadFeatures = byPart("contact_force_edge", "head");
    const resultantShaftFeatures = byPart("contact_force_resultant", "shaft");
    const resultantHeadFeatures = byPart("contact_force_resultant", "head");
    // Arrowheads are filled triangle polygons (built in data/prepare_data.py
    // from arrow_gdf's own barb endpoints), not two thin diverging strokes
    // -- a solid shape stays recognizably triangular at any zoom, where two
    // parallel hairlines blur into a formless smudge once the whole arrow
    // is only a few screen pixels long (exactly the "look bad at low zoom"
    // failure mode a stroked head has).
    const headLayer = (id, features, color) =>
      new GeoJsonLayer({
        id,
        data: { type: "FeatureCollection", features },
        filled: true,
        stroked: true,
        pickable: false,
        extruded: false,
        getFillColor: color,
        getLineColor: color,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: 1.5,
      });
    layers.push(
      // Individual per-wall contact force, shaft: thin, dotted.
      new GeoJsonLayer({
        id: `overlay-force-arrows-edge-shaft-${state.datasetId}`,
        data: { type: "FeatureCollection", features: edgeShaftFeatures },
        filled: false,
        stroked: true,
        pickable: false,
        extruded: false,
        getLineColor: [...hexToRgb(FORCE_ARROWS_COLOR), 200],
        getLineWidth: FORCE_ARROWS_EDGE_WIDTH,
        lineWidthUnits: "meters",
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: FORCE_ARROWS_EDGE_WIDTH,
        extensions: [new PathStyleExtension({ dash: true })],
        getDashArray: [2, 1.4],
        dashJustified: true,
      }),
      headLayer(`overlay-force-arrows-edge-head-${state.datasetId}`, edgeHeadFeatures, [...hexToRgb(FORCE_ARROWS_COLOR), 200]),
      // Net resultant force per building: thicker, solid, black. World-unit
      // (not pixel-unit) width so it thins out at low zoom instead of
      // staying a fixed pixel thickness on an ever-shorter-looking line
      // (which is what made it look like a blob when zoomed out).
      new GeoJsonLayer({
        id: `overlay-force-arrows-resultant-shaft-${state.datasetId}`,
        data: { type: "FeatureCollection", features: resultantShaftFeatures },
        filled: false,
        stroked: true,
        pickable: false,
        extruded: false,
        getLineColor: [...hexToRgb(FORCE_ARROWS_COLOR), 255],
        getLineWidth: FORCE_ARROWS_RESULTANT_WIDTH,
        lineWidthUnits: "meters",
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: FORCE_ARROWS_RESULTANT_WIDTH,
      }),
      headLayer(`overlay-force-arrows-resultant-head-${state.datasetId}`, resultantHeadFeatures, [...hexToRgb(FORCE_ARROWS_COLOR), 255]),
    );
  }
  overlay.setProps({ layers, getTooltip: buildingTooltip });
}

// ---------------------------------------------------------------------------
// Legend + chart.

// Force-arrow legend entries -- shown only while the overlay is active, as
// actual line/arrow previews (not a plain color swatch) so the legend shows
// what's really drawn: a thick solid arrow for the resultant, a thicker
// dotted arrow for each individual wall's force.
const FORCE_ARROW_LEGEND = [
  { key: "resultant", label: "Resultant force (net, per building)", width: FORCE_ARROWS_RESULTANT_WIDTH, dash: null },
  { key: "edge", label: "Individual wall force", width: FORCE_ARROWS_EDGE_WIDTH, dash: [2, 1.4] },
];
const LEGEND_ICON_WIDTH = 44;
const LEGEND_ICON_HEIGHT = 18;
function forceArrowLegendIconSvg(entry) {
  const color = FORCE_ARROWS_COLOR;
  const y = LEGEND_ICON_HEIGHT / 2;
  const x1 = 3;
  const x2 = LEGEND_ICON_WIDTH - 3;
  const headLen = 8;
  const headHalf = 4;
  const dashAttr = entry.dash ? ` stroke-dasharray="${entry.dash.join(",")}"` : "";
  return `<svg viewBox="0 0 ${LEGEND_ICON_WIDTH} ${LEGEND_ICON_HEIGHT}" width="${LEGEND_ICON_WIDTH}" height="${LEGEND_ICON_HEIGHT}" class="legend-line-icon">
    <line x1="${x1}" y1="${y}" x2="${x2 - headLen}" y2="${y}" stroke="${color}" stroke-width="${entry.width}"${dashAttr}></line>
    <polygon points="${x2},${y} ${x2 - headLen},${y - headHalf} ${x2 - headLen},${y + headHalf}" fill="${color}"></polygon>
  </svg>`;
}

function renderLegend() {
  const container = document.getElementById("legend");
  container.innerHTML = "";
  const heading = document.createElement("h2");
  heading.textContent = "Relative position";
  container.appendChild(heading);

  const counts = {};
  for (const f of state.data.features) counts[positionKey(f)] = (counts[positionKey(f)] ?? 0) + 1;

  const list = document.createElement("ul");
  list.className = "legend-list";
  for (const key of POSITION_ORDER) {
    if (!counts[key]) continue;
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = POSITION_COLORS[key];
    const label = document.createElement("span");
    label.textContent = `${POSITION_LABELS[key]} (${counts[key]})`;
    item.append(swatch, label);
    list.appendChild(item);
  }
  container.appendChild(list);

  if (state.forceArrowsActive) {
    const forceHeading = document.createElement("h2");
    forceHeading.style.marginTop = "14px";
    forceHeading.textContent = "Force arrows";
    container.appendChild(forceHeading);

    const forceList = document.createElement("ul");
    forceList.className = "legend-list";
    for (const entry of FORCE_ARROW_LEGEND) {
      const item = document.createElement("li");
      const icon = document.createElement("span");
      icon.className = "legend-line";
      icon.innerHTML = forceArrowLegendIconSvg(entry);
      const label = document.createElement("span");
      label.textContent = entry.label;
      item.append(icon, label);
      forceList.appendChild(item);
    }
    container.appendChild(forceList);
  }
}

const CHART_WIDTH = 280;
const CHART_HEIGHT = 220;
const CHART_MARGIN = { top: 26, right: 6, bottom: 46, left: 34 };

function renderPositionChart() {
  const container = document.getElementById("position-count-chart");
  const counts = {};
  for (const f of state.data.features) counts[positionKey(f)] = (counts[positionKey(f)] ?? 0) + 1;
  const total = state.data.features.length;
  const entries = POSITION_ORDER.filter((k) => counts[k]).map((k) => ({ key: k, count: counts[k] }));

  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const maxCount = Math.max(1, ...entries.map((e) => e.count));
  const barGap = 8;
  const barWidth = (plotWidth - barGap * (entries.length - 1)) / entries.length;
  const plotBottom = CHART_HEIGHT - CHART_MARGIN.bottom;

  let bars = "";
  let labels = "";
  entries.forEach((entry, i) => {
    const barHeight = (entry.count / maxCount) * plotHeight;
    const x = CHART_MARGIN.left + i * (barWidth + barGap);
    const y = plotBottom - barHeight;
    const pct = ((entry.count / total) * 100).toFixed(1);
    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${POSITION_COLORS[entry.key]}" rx="3"></rect>`;
    bars += `<text x="${x + barWidth / 2}" y="${y - 22}" text-anchor="middle" class="chart-bar-label"><tspan x="${x + barWidth / 2}" dy="0">${entry.count}</tspan><tspan x="${x + barWidth / 2}" dy="14">${pct}%</tspan></text>`;
    labels += `<text x="${x + barWidth / 2 + 4}" y="${plotBottom + 12}" text-anchor="end" class="chart-axis-label" transform="rotate(-40 ${x + barWidth / 2 + 4} ${plotBottom + 12})">${POSITION_LABELS[entry.key]}</text>`;
  });

  let yAxisLabels = "";
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const y = plotBottom - t * plotHeight;
    yAxisLabels += `<text x="${CHART_MARGIN.left - 6}" y="${y + 3}" text-anchor="end" class="chart-axis-label">${Math.round(maxCount * t)}</text>`;
  }

  container.innerHTML = `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}">
    <line x1="${CHART_MARGIN.left}" y1="${plotBottom}" x2="${CHART_WIDTH - CHART_MARGIN.right}" y2="${plotBottom}" stroke="rgba(255,255,255,0.18)"></line>
    <line x1="${CHART_MARGIN.left}" y1="${CHART_MARGIN.top}" x2="${CHART_MARGIN.left}" y2="${plotBottom}" stroke="rgba(255,255,255,0.18)"></line>
    ${yAxisLabels}
    ${bars}
    ${labels}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Building popup -- this map is about relative_position, so that's the only
// column shown.
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
  const row = document.createElement("tr");
  const th = document.createElement("th");
  th.textContent = "Relative position";
  const td = document.createElement("td");
  td.textContent = POSITION_LABELS[positionKey({ properties })];
  row.append(th, td);
  tbody.appendChild(row);
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
// Dataset switching.
let datasetDropdown = null;

async function loadDataset(datasetId) {
  const dir = DATASETS[datasetId].dir;
  const buildings = await fetch(`${dir}/buildings.geojson`).then((r) => r.json());
  state.datasetId = datasetId;
  state.data = buildings;
  elevationClamp = elevationClampFor(buildings);

  try {
    state.forceArrowsData = await fetch(`${dir}/overlays/position_arrows.geojson`).then((r) => r.json());
  } catch {
    state.forceArrowsData = null;
  }

  const [[minX, minY], [maxX, maxY]] = computeBbox(buildings);
  state.datasetCenter = { lng: (minX + maxX) / 2, lat: (minY + maxY) / 2 };

  renderLegend();
  renderPositionChart();
  renderLayer();
}

async function setDataset(datasetId, { fromShowcase = false } = {}) {
  await loadDataset(datasetId);
  var __h1 = document.querySelector(".subtitle"); if (__h1) __h1.textContent = DATASETS[datasetId].label;
  updateTitle(datasetId);
  datasetDropdown?.setValue(datasetId);
  const [[minX, minY], [maxX, maxY]] = computeBbox(state.data);
  fitBoundsCloser([[minX, minY], [maxX, maxY]], { duration: fromShowcase ? 0 : 500 });
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
// Showcase mode: this map's video mode is the 2D force-arrows view itself
// (default state) held still -- a flat top-down view has no depth cue to
// justify orbiting, so bearing only rotates if the viewer manually switches
// to 3D (mirrors maps/building_sizes's own 2D-default showcase).
let showcaseRotateFrame = null;
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


function startShowcase() {
  if (state.showcaseActive) return;
  state.showcaseActive = true;
  scheduleDatasetCycle();

  const [[minX, minY], [maxX, maxY]] = computeBbox(state.data);
  map.jumpTo({ center: [(minX + maxX) / 2, (minY + maxY) / 2] });
  let lastFrameTime = performance.now();
  const rotate = (now) => {
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (state.is3D) map.setBearing((map.getBearing() + SHOWCASE_ROTATE_DEG_PER_SEC * dt) % 360);
    showcaseRotateFrame = requestAnimationFrame(rotate);
  };
  showcaseRotateFrame = requestAnimationFrame(rotate);
}

function stopShowcase({ resumeAfterIdle = true } = {}) {
  stopDatasetCycle();
  if (showcaseRotateFrame !== null) cancelAnimationFrame(showcaseRotateFrame);
  showcaseRotateFrame = null;
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

function setForceArrows(active) {
  state.forceArrowsActive = active;
  document.getElementById("force-arrows-toggle")?.classList.toggle("active", active);
  const checkbox = document.getElementById("force-arrows-checkbox");
  if (checkbox) checkbox.checked = active;
  renderLayer();
  renderLegend();
}

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

  await loadDataset(ACTIVE_DEFAULT_DATASET);
  { const __h1 = document.querySelector(".subtitle"); if (__h1) __h1.textContent = DATASETS[ACTIVE_DEFAULT_DATASET].label; }
  updateTitle(ACTIVE_DEFAULT_DATASET);
  datasetDropdown.setValue(ACTIVE_DEFAULT_DATASET);
  const [[minX, minY], [maxX, maxY]] = computeBbox(state.data);
  fitBoundsCloser([[minX, minY], [maxX, maxY]], { duration: 0 });

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
  document.getElementById("force-arrows-checkbox")?.addEventListener("change", (event) => {
    setForceArrows(event.target.checked);
    registerUserInteraction();
  });

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
