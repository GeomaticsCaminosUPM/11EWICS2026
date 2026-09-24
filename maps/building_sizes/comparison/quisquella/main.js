// Sevilla pilot-region "building sizes" map -- based on maps/relative_position
// (same visual language / no-backend approach), but showing the basic-length
// dimension arrows (L1/L2/a1/a2/b/c) computed by
// footprint_attributes.notebook_utils.basic_length_axis /
// footprint_attributes.visualization.overlays._basic_lengths, written by
// data/prepare_data.py to overlays/basic_lengths.geojson alongside each
// dataset's buildings.geojson. Defaults to a flat 2D view -- the dimension
// arrows read best without extrusion in the way.
const { GeoJsonLayer } = deck;
const { MapboxOverlay } = deck;
const { PathStyleExtension } = deck;

const DATASETS = {
  mata_redonda: { label: "Mata Redonda", dir: "../../../../data/building_sizes/mata_redonda" },
  quisquella: { label: "Quisquella", dir: "../../../../data/building_sizes/quisquella" },
  zona_1: { label: "Zona 1", dir: "../../../../data/building_sizes/zona_1" },
};
const DEFAULT_DATASET = "quisquella";
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

// Comparison mode: only L1/L2, drawn twice -- once from the minimum-rotated
// bounding box (red, solid, from overlays/basic_lengths.geojson) and once
// from the principal-inertia axes (blue, dotted, from
// overlays/inertia_axis.geojson -- footprint_attributes.visualization.
// overlays._inertia_axis) -- same thickness, so only color/pattern tell
// them apart. The inertia features come off the wire with kind "L1"/"L2"
// too (same as bbox), so loadDataset() relabels them "L1_inertia"/
// "L2_inertia" client-side to avoid colliding when merged for rendering.
const ARROW_KIND_COLORS = {
  L1: "#c0392b",
  L2: "#c0392b",
  L1_inertia: "#4299e1",
  L2_inertia: "#4299e1",
};
const ARROW_KIND_WIDTHS = {
  L1: 4,
  L2: 4,
  L1_inertia: 4,
  L2_inertia: 4,
};
// [dash length, gap length] in line-width units; PathStyleExtension leaves
// a kind out of this map undashed (solid) -- bbox L1/L2 stay solid, inertia
// L1/L2 are dotted so both are visible where they overlap.
const ARROW_KIND_DASH = {
  L1_inertia: [1, 2],
  L2_inertia: [1, 2],
};
// Both bbox and inertia L1/L2 draw a real arrowhead at the tip.
const ARROW_KIND_CAPS = { L1: "arrow", L2: "arrow", L1_inertia: "arrow", L2_inertia: "arrow" };
const ARROW_KIND_LABELS = {
  L1: "L1 (bbox, main length)",
  L2: "L2 (bbox, main width)",
  L1_inertia: "L1 (inertia, main length)",
  L2_inertia: "L2 (inertia, main width)",
};
const ARROW_KIND_ORDER = ["L1", "L2", "L1_inertia", "L2_inertia"];
const BUILDING_FILL = "#4a5568";

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
  is3D: false, // building sizes reads best flat -- default to 2D
  selectedBuildingId: null,
  showcaseActive: false,
  arrowsData: null,
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

// This map is about reading individual buildings' dimension arrows, not
// surveying the whole AOI at once -- a plain fitBounds zooms out far enough
// that arrows/buildings turn into illegible specks. Zoom in past the
// bounds-fit level even if that crops some of the AOI off-screen.
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

function getFillColor() {
  return [...hexToRgb(BUILDING_FILL), 160];
}
function getLineColor(feature) {
  return isSelected(feature) ? [...hexToRgb("#e2a33f"), 255] : [45, 55, 72, 190];
}
function getLineWidth(feature) {
  return isSelected(feature) ? 3 : 1;
}
function arrowKind(feature) {
  return feature.properties?.kind;
}
function getArrowColor(feature) {
  const color = ARROW_KIND_COLORS[arrowKind(feature)] ?? "#111111";
  return [...hexToRgb(color), 235];
}
function getArrowWidth(feature) {
  return ARROW_KIND_WIDTHS[arrowKind(feature)] ?? 1.5;
}
function getArrowDash(feature) {
  return ARROW_KIND_DASH[arrowKind(feature)] ?? [0, 0];
}

let onBuildingClick = () => {};

function buildingTooltip({ object, layer }) {
  if (!object || !layer?.id?.startsWith("buildings-")) return null;
  return { html: `<div><strong>Building ${object.properties?.building_uid}</strong></div><div class="hint" style="margin-top:4px">Click for full details</div>`, className: "deck-tooltip" };
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
  if (state.arrowsData) {
    const solidFeatures = state.arrowsData.features.filter((f) => !ARROW_KIND_DASH[f.properties?.kind]);
    const dashedFeatures = state.arrowsData.features.filter((f) => ARROW_KIND_DASH[f.properties?.kind]);
    layers.push(
      // L1/L2: solid, thicker.
      new GeoJsonLayer({
        id: `overlay-basic-lengths-solid-${state.datasetId}`,
        data: { type: "FeatureCollection", features: solidFeatures },
        filled: false,
        stroked: true,
        pickable: false,
        extruded: false,
        getLineColor: getArrowColor,
        getLineWidth: getArrowWidth,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1,
      }),
      // a1/a2: dotted. b/c: dashed.
      new GeoJsonLayer({
        id: `overlay-basic-lengths-dashed-${state.datasetId}`,
        data: { type: "FeatureCollection", features: dashedFeatures },
        filled: false,
        stroked: true,
        pickable: false,
        extruded: false,
        getLineColor: getArrowColor,
        getLineWidth: getArrowWidth,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1,
        extensions: [new PathStyleExtension({ dash: true })],
        getDashArray: getArrowDash,
        dashJustified: true,
      }),
    );
  }
  overlay.setProps({ layers, getTooltip: buildingTooltip });
}

// ---------------------------------------------------------------------------
// Legend -- one line preview per kind (color, line weight, dash pattern and
// arrow/bar cap), not just a plain color swatch, so the legend actually
// shows what's drawn on the map instead of just its color.
const LEGEND_ICON_WIDTH = 44;
const LEGEND_ICON_HEIGHT = 18;
function legendIconSvg(key) {
  const color = ARROW_KIND_COLORS[key];
  const width = ARROW_KIND_WIDTHS[key] ?? 2;
  const dash = ARROW_KIND_DASH[key];
  const caps = ARROW_KIND_CAPS[key];
  const y = LEGEND_ICON_HEIGHT / 2;
  const x1 = 3;
  const x2 = LEGEND_ICON_WIDTH - 3;
  const dashAttr = dash ? ` stroke-dasharray="${dash.join(",")}"` : "";
  let extra = "";
  if (caps === "arrow") {
    const headLen = 8;
    const headHalf = 4;
    extra = `<polygon points="${x2},${y} ${x2 - headLen},${y - headHalf} ${x2 - headLen},${y + headHalf}" fill="${color}"></polygon>`;
  } else {
    const tick = 5;
    extra = `<line x1="${x1}" y1="${y - tick}" x2="${x1}" y2="${y + tick}" stroke="${color}" stroke-width="2"></line>
      <line x1="${x2}" y1="${y - tick}" x2="${x2}" y2="${y + tick}" stroke="${color}" stroke-width="2"></line>`;
  }
  return `<svg viewBox="0 0 ${LEGEND_ICON_WIDTH} ${LEGEND_ICON_HEIGHT}" width="${LEGEND_ICON_WIDTH}" height="${LEGEND_ICON_HEIGHT}" class="legend-line-icon">
    <line x1="${x1}" y1="${y}" x2="${caps === "arrow" ? x2 - 8 : x2}" y2="${y}" stroke="${color}" stroke-width="${width}"${dashAttr}></line>
    ${extra}
  </svg>`;
}
function renderLegend() {
  const container = document.getElementById("legend");
  container.innerHTML = "";
  const heading = document.createElement("h2");
  heading.textContent = "L1/L2: bbox vs inertia";
  container.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "legend-list";
  for (const key of ARROW_KIND_ORDER) {
    const item = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "legend-line";
    icon.innerHTML = legendIconSvg(key);
    const label = document.createElement("span");
    label.textContent = ARROW_KIND_LABELS[key];
    item.append(icon, label);
    list.appendChild(item);
  }
  container.appendChild(list);
}

// ---------------------------------------------------------------------------
// Building popup -- basic attributes plus the building's own L1/L2/a1/a2/b/c
// values (looked up from the arrows layer since arrow_gdf's geometry, not
// buildings.geojson, carries the "value" column).
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

  const basics = [
    ["Height", typeof properties.height === "number" ? `${properties.height.toFixed(1)} m` : "n/a"],
    ["Floors", properties.n_floors ?? "n/a"],
    ["Structural system", properties.structural_system ?? "n/a"],
  ];
  for (const [label, value] of basics) {
    const row = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = label;
    const td = document.createElement("td");
    td.textContent = value;
    row.append(th, td);
    tbody.appendChild(row);
  }

  const arrowValues = (state.arrowsData?.features ?? [])
    .filter((f) => f.properties?.building_uid === id)
    .sort((a, b) => ARROW_KIND_ORDER.indexOf(a.properties.kind) - ARROW_KIND_ORDER.indexOf(b.properties.kind));
  for (const f of arrowValues) {
    const row = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = ARROW_KIND_LABELS[f.properties.kind] ?? f.properties.kind;
    const td = document.createElement("td");
    const value = f.properties?.value;
    td.textContent = typeof value === "number" ? `${value.toFixed(2)} m` : "n/a";
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
// Dataset switching.
let datasetDropdown = null;

async function loadDataset(datasetId) {
  const dir = DATASETS[datasetId].dir;
  const buildings = await fetch(`${dir}/buildings.geojson`).then((r) => r.json());
  state.datasetId = datasetId;
  state.data = buildings;
  elevationClamp = elevationClampFor(buildings);

  try {
    const [bboxData, inertiaData] = await Promise.all([
      fetch(`${dir}/overlays/basic_lengths.geojson`).then((r) => r.json()),
      fetch(`${dir}/overlays/inertia_axis.geojson`).then((r) => r.json()),
    ]);
    const bboxL1L2 = bboxData.features.filter((f) => f.properties?.kind === "L1" || f.properties?.kind === "L2");
    const inertiaL1L2 = inertiaData.features.map((f) => ({
      ...f,
      properties: { ...f.properties, kind: `${f.properties.kind}_inertia` },
    }));
    state.arrowsData = { type: "FeatureCollection", features: [...bboxL1L2, ...inertiaL1L2] };
  } catch {
    state.arrowsData = null;
  }

  const [[minX, minY], [maxX, maxY]] = computeBbox(buildings);
  state.datasetCenter = { lng: (minX + maxX) / 2, lat: (minY + maxY) / 2 };

  renderLegend();
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
// Showcase mode: orbit the dataset center, but only while in 3D -- a flat 2D
// view (this map's default) reads best held still, since orbiting a
// top-down view just spins the whole page with no depth cue to justify it.
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
  document.getElementById("view-3d-toggle").classList.toggle("active", state.is3D);

  document.getElementById("controls-toggle").addEventListener("click", (event) => {
    document.getElementById("controls-fields").classList.toggle("hidden");
    event.currentTarget.classList.toggle("collapsed");
  });
  document.getElementById("legend-toggle").addEventListener("click", (event) => {
    document.getElementById("legend").classList.toggle("hidden");
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
