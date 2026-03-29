// ── Single source of truth for zoom ──────────────────────────────────────────
// Every tile fetch in this program — the map layer AND captureBuilding —
// uses this constant so imagery is always consistent.

const MAPBOX_TOKEN = window.APP_CONFIG?.mapboxToken ?? '';
const CAPTURE_ZOOM = 20; // z20 = highest detail Mapbox satellite offers

// ── Roboflow config ───────────────────────────────────────────────────────────
const ROBOFLOW_API_KEY = window.APP_CONFIG?.roboflowApiKey ?? '';
const ROBOFLOW_ENDPOINT = window.APP_CONFIG?.roboflowEndpoint ?? '';



// Map setup
const map = L.map('map', {
  center: [40.7484, -73.9967],
  zoom: 16,
  minZoom: 3,
  maxZoom: CAPTURE_ZOOM,
  zoomControl: true,
});

// Tile layers
const darkTile = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  minZoom: 3,
  maxZoom: CAPTURE_ZOOM,
});

// mapbox.satellite served via the Raster Tiles v4 API.
// This endpoint actually serves tiles (unlike the style URL which needs GL JS).
// @2x tiles are 512px but map to 256px tile-grid cells → tileSize:512, zoomOffset:-1.
const satelliteTile = L.tileLayer(
  `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`,
  {
    attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="https://www.maxar.com/">Maxar</a>',
    tileSize: 512,
    zoomOffset: -1,
    minZoom: 3,
    maxZoom: CAPTURE_ZOOM,
    crossOrigin: true,
  }
);

let isSatellite = false;
darkTile.addTo(map);

function toggleSatellite() {
  isSatellite = !isSatellite;
  if (isSatellite) {
    map.removeLayer(darkTile);
    satelliteTile.addTo(map);
    satelliteTile.bringToBack();
  } else {
    map.removeLayer(satelliteTile);
    darkTile.addTo(map);
    darkTile.bringToBack();
  }
  const btn = document.getElementById('satellite-btn');
  btn.textContent = isSatellite ? 'Dark Map' : 'Satellite';
  btn.classList.toggle('active', isSatellite);
}

// State
let buildingLayers = [];
let searchMarker = null;
let searchCircle = null;

// Storage: OSM ID -> { coords, tags, osmId }
const storedBuildings = new Map();

// ── Overpass fetch with fallback mirrors ──────────────────────────────────────

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Active search controller — lets cancelSearch() abort in-flight requests
let searchAbortController = null;

// ── Output log ────────────────────────────────────────────────────────────────

function log(msg, type = 'info') {
  const out = document.getElementById('log-output');
  if (!out) return;
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  line.textContent = `[${ts}] ${msg}`;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function clearLog() {
  const out = document.getElementById('log-output');
  if (out) out.innerHTML = '';
}

function toggleLog() {
  const panel = document.getElementById('log-panel');
  const icon  = document.getElementById('log-toggle-icon');
  const open  = panel.classList.toggle('hidden');
  icon.textContent = open ? '▶' : '▼';
}

/**
 * Race all Overpass mirrors in parallel; return the first successful JSON response.
 * Passes the caller's AbortSignal so cancel propagates to every in-flight request.
 */
async function overpassFetch(query, callerSignal, timeoutMs = 25000) {
  const controllers = OVERPASS_ENDPOINTS.map(() => new AbortController());

  const abortAll = () => controllers.forEach(c => c.abort());

  if (callerSignal) {
    callerSignal.addEventListener('abort', abortAll, { once: true });
  }

  const racePromises = OVERPASS_ENDPOINTS.map((endpoint, i) => {
    const host = new URL(endpoint).hostname;
    const t0 = performance.now();
    log(`Trying ${host}…`);
    const timer = setTimeout(() => {
      log(`Timeout after ${timeoutMs}ms — ${host}`, 'warn');
      controllers[i].abort();
    }, timeoutMs);

    return fetch(endpoint, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controllers[i].signal,
    }).then(r => {
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then(data => {
      const ms = Math.round(performance.now() - t0);
      log(`✓ ${host} responded in ${ms}ms (${data.elements?.length ?? 0} elements)`, 'success');
      abortAll();
      return data;
    }).catch(err => {
      clearTimeout(timer);
      if (err.name !== 'AbortError') {
        log(`✗ ${host}: ${err.message}`, 'error');
      }
      throw err;
    });
  });

  return Promise.any(racePromises);
}

/**
 * Captures the satellite image for a building footprint.
 * Returns { blob, base64 } so callers can download OR send to Roboflow.
 * Pass download=true (default) to also trigger the browser Save-As dialog.
 */
async function captureBuilding(osmId, { download = true } = {}) {
  const building = storedBuildings.get(osmId);
  if (!building) return null;

  const Z       = CAPTURE_ZOOM;
  const N       = Math.pow(2, Z);
  const GRID_PX = 256;
  const TILE_PX = 512;

  function tileCol(lng) {
    return Math.floor((lng + 180) / 360 * N);
  }
  function tileRow(lat) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N);
  }

  function toStitchPx([lat, lng]) {
    const worldX = (lng + 180) / 360 * N * GRID_PX;
    const r      = lat * Math.PI / 180;
    const worldY = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N * GRID_PX;
    return [
      (worldX - txMin * GRID_PX) * 2,
      (worldY - tyMin * GRID_PX) * 2,
    ];
  }

  const lats = building.coords.map(c => c[0]);
  const lngs = building.coords.map(c => c[1]);
  const txMin = tileCol(Math.min(...lngs));
  const txMax = tileCol(Math.max(...lngs));
  const tyMin = tileRow(Math.max(...lats));
  const tyMax = tileRow(Math.min(...lats));

  const cols = txMax - txMin + 1;
  const rows = tyMax - tyMin + 1;

  const tileImages = new Map();

  await Promise.all(
    Array.from({ length: cols }, (_, ci) => txMin + ci).flatMap(tx =>
      Array.from({ length: rows }, (_, ri) => tyMin + ri).map(ty =>
        new Promise(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload  = () => { tileImages.set(`${tx},${ty}`, img); resolve(); };
          img.onerror = () => resolve();
          img.src = `https://api.mapbox.com/v4/mapbox.satellite/${Z}/${tx}/${ty}@2x.jpg90?access_token=${MAPBOX_TOKEN}`;
        })
      )
    )
  );

  const stitchW = cols * TILE_PX;
  const stitchH = rows * TILE_PX;

  const stitchCanvas = document.createElement('canvas');
  stitchCanvas.width  = stitchW;
  stitchCanvas.height = stitchH;
  const stitchCtx = stitchCanvas.getContext('2d');

  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      const img = tileImages.get(`${tx},${ty}`);
      if (img) stitchCtx.drawImage(img, (tx - txMin) * TILE_PX, (ty - tyMin) * TILE_PX);
    }
  }

  const stitchPolyPts = building.coords.map(toStitchPx);

  const clippedCanvas = document.createElement('canvas');
  clippedCanvas.width  = stitchW;
  clippedCanvas.height = stitchH;
  const clippedCtx = clippedCanvas.getContext('2d');

  clippedCtx.beginPath();
  clippedCtx.moveTo(stitchPolyPts[0][0], stitchPolyPts[0][1]);
  for (let i = 1; i < stitchPolyPts.length; i++) {
    clippedCtx.lineTo(stitchPolyPts[i][0], stitchPolyPts[i][1]);
  }
  clippedCtx.closePath();
  clippedCtx.clip();
  clippedCtx.drawImage(stitchCanvas, 0, 0);

  const pxs = stitchPolyPts.map(p => p[0]);
  const pys = stitchPolyPts.map(p => p[1]);
  const PAD  = 24;
  const cropX = Math.max(0, Math.floor(Math.min(...pxs)) - PAD);
  const cropY = Math.max(0, Math.floor(Math.min(...pys)) - PAD);
  const cropW = Math.min(stitchW - cropX, Math.ceil(Math.max(...pxs)) - cropX + PAD);
  const cropH = Math.min(stitchH - cropY, Math.ceil(Math.max(...pys)) - cropY + PAD);

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width  = cropW;
  cropCanvas.height = cropH;
  cropCanvas.getContext('2d').drawImage(clippedCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  return new Promise(resolve => {
    cropCanvas.toBlob(blob => {
      if (!blob) { resolve(null); return; }

      if (download) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `building_${osmId}_z${Z}_stitched.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve({ blob, base64 });
      };
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

// Building polygon style
const buildingStyle = {
  color: '#7c83ff',
  weight: 2,
  opacity: 0.9,
  fillColor: '#7c83ff',
  fillOpacity: 0.15,
};

const buildingHoverStyle = {
  color: '#a5b4fc',
  weight: 2.5,
  fillOpacity: 0.35,
};

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type;
}

function setLoading(loading) {
  const btn = document.getElementById('search-btn');
  const text = document.getElementById('btn-text');
  const spinner = document.getElementById('btn-spinner');
  const cancelBtn = document.getElementById('cancel-btn');
  btn.disabled = loading;
  text.textContent = loading ? 'Searching...' : 'Outline Buildings';
  spinner.classList.toggle('hidden', !loading);
  cancelBtn.classList.toggle('hidden', !loading);
}

function showResults(count) {
  const el = document.getElementById('results');
  document.getElementById('building-count').textContent = count;
  el.classList.toggle('hidden', count === 0);
}

function clearBuildings() {
  buildingLayers.forEach(layer => map.removeLayer(layer));
  buildingLayers = [];
  selectedLayer = null;
  storedBuildings.clear();
  if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
  if (searchCircle) { map.removeLayer(searchCircle); searchCircle = null; }
  showResults(0);
  document.getElementById('results').classList.add('hidden');
  setStatus('');
}

function setExample(lat, lng) {
  document.getElementById('lat').value = lat;
  document.getElementById('lng').value = lng;
  document.getElementById('combined-coords').value = `${lat}, ${lng}`;
}

// ── Coordinate input mode toggle ─────────────────────────────────────────────

function toggleCoordMode() {
  const mode = document.getElementById('coord-mode').value;
  document.getElementById('separate-inputs').classList.toggle('hidden', mode === 'combined');
  document.getElementById('combined-input').classList.toggle('hidden', mode === 'separate');
}

/** Parse lat/lng from whichever input mode is active. Returns { lat, lng } or null. */
function parseCoords() {
  const mode = document.getElementById('coord-mode').value;
  if (mode === 'combined') {
    const raw = document.getElementById('combined-coords').value.trim();
    const parts = raw.split(/[\s,]+/);
    if (parts.length < 2) return null;
    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);
    return isNaN(lat) || isNaN(lng) ? null : { lat, lng };
  }
  const lat = parseFloat(document.getElementById('lat').value);
  const lng = parseFloat(document.getElementById('lng').value);
  return isNaN(lat) || isNaN(lng) ? null : { lat, lng };
}

// ── Highlight mode ────────────────────────────────────────────────────────────

let selectedLayer = null;

const highlightedStyle = {
  color: '#f59e0b',
  weight: 3,
  opacity: 1,
  fillColor: '#f59e0b',
  fillOpacity: 0.35,
};

const dimmedStyle = {
  color: '#7c83ff',
  weight: 1.5,
  opacity: 0.35,
  fillColor: '#7c83ff',
  fillOpacity: 0.05,
};

function applyHighlightMode() {
  const mode = document.getElementById('highlight-mode').value;
  if (mode === 'all') {
    // Reset all layers to normal style, clear selection
    selectedLayer = null;
    buildingLayers.forEach(l => l.setStyle(buildingStyle));
  } else {
    // Dim all; wait for user click
    buildingLayers.forEach(l => l.setStyle(dimmedStyle));
  }
}

function handleBuildingClick(layer) {
  const mode = document.getElementById('highlight-mode').value;
  if (mode !== 'one') return;

  if (selectedLayer && selectedLayer !== layer) {
    selectedLayer.setStyle(dimmedStyle);
  }
  selectedLayer = layer;
  layer.setStyle(highlightedStyle);
  layer.bringToFront();

  // Find the OSM ID for this layer so we can open its popup
  let osmId = null;
  for (const [id, building] of storedBuildings) {
    if (building._layer === layer) { osmId = id; break; }
  }
  if (osmId !== null) layer.openPopup();
}

// ── Roboflow: calculateHvac ───────────────────────────────────────────────────
async function calculateHvac(osmId) {
  const btn        = document.getElementById(`hvac-btn-${osmId}`);
  const resultWrap = document.getElementById(`hvac-result-${osmId}`);
  const imgEl      = document.getElementById(`hvac-img-${osmId}`);
  const countEl    = document.getElementById(`hvac-count-${osmId}`);

  if (btn) { btn.textContent = 'Capturing image\u2026'; btn.disabled = true; }

  try {
    const captured = await captureBuilding(osmId, { download: false });
    if (!captured) throw new Error('Image capture returned nothing \u2014 building may not be stored.');

    log(`Captured base64 image for OSM ${osmId} (${Math.round(captured.base64.length / 1024)} KB)`, 'info');
    if (btn) btn.textContent = 'Running detection\u2026';

    const response = await fetch(ROBOFLOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: ROBOFLOW_API_KEY,
        inputs: {
          image: { type: 'base64', value: captured.base64 },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Roboflow HTTP ${response.status}: ${errText}`);
    }

    const result = await response.json();
    log(`Roboflow response received for OSM ${osmId}`, 'success');
    console.log('[Roboflow raw response]', JSON.stringify(result, null, 2));

    const output = result?.outputs?.[0] ?? {};

    const detectionCount =
      output?.count ??
      output?.count_objects ??
      output?.object_count ??
      output?.predictions?.predictions?.length ??
      output?.predictions?.length ??
      result?.count ??
      '?';

    const annotatedB64 =
      output?.output_image?.value ??
      output?.visualization?.value ??
      output?.annotated_image?.value ??
      null;

    if (annotatedB64 && imgEl) {
      imgEl.src = `data:image/jpeg;base64,${annotatedB64}`;
      imgEl.style.display = 'block';
    }

    if (countEl) countEl.textContent = detectionCount;
    if (resultWrap) resultWrap.style.display = 'block';
    if (btn) btn.textContent = '\u2713 Done';

  } catch (err) {
    log(`calculateHvac error (OSM ${osmId}): ${err.message}`, 'error');
    if (btn) { btn.textContent = '\u26A0 Error \u2014 retry?'; btn.disabled = false; }
    if (resultWrap) {
      resultWrap.style.display = 'block';
      resultWrap.innerHTML = `<p style="color:#f87171;font-size:12px;">Error: ${err.message}</p>`;
    }
  }
}

async function searchBuildings() {
  const coords = parseCoords();
  if (!coords) {
    setStatus('Please enter valid latitude and longitude.', 'error');
    return;
  }
  const { lat, lng } = coords;
  const radius = parseInt(document.getElementById('radius').value) || 200;

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    setStatus('Coordinates out of range.', 'error');
    return;
  }

  clearBuildings();
  setLoading(true);
  setStatus('Querying building data...');
  log(`── Search started ──────────────────`);
  log(`Coords: ${lat.toFixed(6)}, ${lng.toFixed(6)}  radius: ${radius}m  mode: ${document.getElementById('highlight-mode').value}`);

  // Pan map to coordinates
  map.setView([lat, lng], 17);

  // Show search point and radius circle
  searchMarker = L.circleMarker([lat, lng], {
    radius: 6,
    color: '#f59e0b',
    fillColor: '#f59e0b',
    fillOpacity: 1,
    weight: 2,
  }).addTo(map).bindPopup(`<div class="popup-title">Search Point</div><div class="popup-detail">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>`);

  searchCircle = L.circle([lat, lng], {
    radius,
    color: '#f59e0b',
    weight: 1,
    fillOpacity: 0.04,
    dashArray: '5,5',
  }).addTo(map);

  const highlightMode = document.getElementById('highlight-mode').value;

  // Create a controller for this search so cancel works
  searchAbortController = new AbortController();
  const signal = searchAbortController.signal;

  // Both modes use the same query — "one" mode just highlights the closest result
  // Optimised query: `out geom` returns geometry inline so the server does ONE
  // pass instead of the expensive `out body; >; out skel qt;` two-pass pattern.
  // `qt` (quadtile) sort is fastest for the server to produce.
  const query = `
    [out:json][timeout:25];
    (
      way["building"](around:${radius},${lat},${lng});
      relation["building"](around:${radius},${lat},${lng});
    );
    out geom qt;
  `;

  try {
    const data = await overpassFetch(query, signal, 25000);
    const count = renderBuildings(data, highlightMode, lat, lng);

    if (count === 0) {
      log('No buildings found within radius.', 'warn');
      setStatus('No buildings found at this location. Try increasing the radius.', '');
    } else {
      log(`Rendered ${count} building${count !== 1 ? 's' : ''}.`, 'success');
      setStatus(`Found ${count} building${count !== 1 ? 's' : ''}.`, 'success');
    }
    showResults(count);
  } catch (err) {
    if (err.name === 'AbortError' || (err instanceof AggregateError && err.errors.every(e => e.name === 'AbortError'))) {
      log('Search cancelled by user.', 'warn');
      setStatus('Search cancelled.', '');
    } else {
      const detail = err instanceof AggregateError
        ? err.errors.map(e => e.message).join(' | ')
        : err.message;
      log(`All mirrors failed: ${detail}`, 'error');
      console.error(err);
      setStatus('Failed to fetch building data. Check your connection and try again.', 'error');
    }
  } finally {
    searchAbortController = null;
    setLoading(false);
    log(`── Search complete ─────────────────`);
  }
}

function cancelSearch() {
  if (searchAbortController) {
    searchAbortController.abort();
  }
}

function renderBuildings(data, highlightMode = 'all', searchLat = null, searchLng = null) {
  // Build a node lookup for the out body / out skel format
  const nodes = {};
  data.elements.forEach(el => {
    if (el.type === 'node') nodes[el.id] = [el.lat, el.lon];
  });

  let count = 0;
  let closestLayer = null;
  let closestDist = Infinity;

  for (const el of data.elements) {
    if (el.type !== 'way') continue;

    let coords;
    if (el.geometry && el.geometry.length) {
      coords = el.geometry.map(p => [p.lat, p.lon]);
    } else if (el.nodes) {
      coords = el.nodes.map(id => nodes[id]).filter(Boolean);
    } else {
      continue;
    }

    if (coords.length < 3) continue;

    const polygon = L.polygon(coords, buildingStyle).addTo(map);

    // Build popup content from OSM tags
    const tags = el.tags || {};
    const name = tags.name || tags['addr:housename'] || '';
    const levels = tags['building:levels'] ? `${tags['building:levels']} floors` : '';
    const use = tags.building !== 'yes' ? tags.building : '';
    const addr = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');

    // Store building data keyed by OSM ID (include layer ref for click → panel lookup)
    storedBuildings.set(el.id, { coords, tags, osmId: el.id, _layer: polygon });

    const details = [use, levels, addr].filter(Boolean).join(' &bull; ');
    const popupHtml = `
      <div class="popup-title">${name || 'Building'}</div>
      <div class="popup-detail">${details || 'No additional info'}</div>
      <div class="popup-detail" style="margin-top:4px;color:#4b5563">OSM ID: ${el.id}</div>

      <button
        onclick="this.textContent='Fetching\u2026';this.disabled=true;captureBuilding(${el.id}).finally(()=>{this.textContent='\u2B07 Save as PNG';this.disabled=false;})"
        style="margin-top:8px;padding:4px 10px;background:#7c83ff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;"
      >\u2B07 Save as PNG</button>

      <div class="popup-hvac">
        <div class="popup-hvac-row">
          <button
            id="hvac-btn-${el.id}"
            class="popup-hvac-btn"
            onclick="calculateHvac(${el.id})"
          >
            Calculate HVAC Amount
          </button>
        </div>

        <div id="hvac-result-${el.id}" style="display:none;margin-top:8px;">
          <div style="font-size:11px;color:#9ca3af;margin-bottom:4px;">
            Detections: <strong><span id="hvac-count-${el.id}">\u2014</span></strong>
          </div>
          <img
            id="hvac-img-${el.id}"
            src=""
            alt="HVAC detection output"
            style="display:none;width:100%;min-width:380px;max-width:480px;border-radius:4px;border:1px solid #374151;margin-top:4px;"
          />
        </div>
      </div>
    `;

    polygon.bindPopup(popupHtml);

    polygon.on('click', function () {
      handleBuildingClick(this);
    });

    polygon.on('mouseover', function () {
      const mode = document.getElementById('highlight-mode').value;
      if (mode === 'one' && this === selectedLayer) return; // keep highlight
      this.setStyle(buildingHoverStyle);
      this.bringToFront();
    });
    polygon.on('mouseout', function () {
      const mode = document.getElementById('highlight-mode').value;
      if (mode === 'one' && this === selectedLayer) return; // keep highlight
      if (mode === 'one') {
        this.setStyle(dimmedStyle);
      } else {
        this.setStyle(buildingStyle);
      }
    });

    // Track closest building to the search point for "one" mode
    if (highlightMode === 'one' && searchLat !== null && searchLng !== null) {
      const centroid = coords.reduce(
        (acc, c) => [acc[0] + c[0], acc[1] + c[1]],
        [0, 0]
      ).map(v => v / coords.length);
      const dLat = centroid[0] - searchLat;
      const dLng = centroid[1] - searchLng;
      const dist = dLat * dLat + dLng * dLng;
      if (dist < closestDist) {
        closestDist = dist;
        closestLayer = polygon;
      }
    }

    buildingLayers.push(polygon);
    count++;
  }

  // Fit map to show all buildings
  if (buildingLayers.length > 0) {
    const group = L.featureGroup(buildingLayers);
    map.fitBounds(group.getBounds().pad(0.15));
  }

  if (highlightMode === 'one' && closestLayer) {
    // Dim everything, then highlight just the closest building
    buildingLayers.forEach(l => l.setStyle(dimmedStyle));
    closestLayer.setStyle(highlightedStyle);
    closestLayer.bringToFront();
    selectedLayer = closestLayer;
  } else {
    applyHighlightMode();
  }

  return count;
}

// Allow pressing Enter in inputs to trigger search
document.addEventListener('DOMContentLoaded', () => {
  ['lat', 'lng', 'radius', 'combined-coords'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') searchBuildings();
    });
  });

  // ── Local clock ──────────────────────────────────────────────────────────
  function updateClock() {
    const now = new Date();
    document.getElementById('local-time').textContent = now.toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
  updateClock();
  setInterval(updateClock, 1000);

  // ── Ping indicator ───────────────────────────────────────────────────────
  const pingDot   = document.getElementById('ping-dot');
  const pingLabel = document.getElementById('ping-label');

  async function runPing() {
    pingDot.className = 'pinging';
    const t0 = performance.now();
    try {
      // Use a lightweight CORS-friendly endpoint instead of Overpass HEAD (blocked by CORS)
      await fetch('https://dns.google/resolve?name=overpass-api.de&type=A', { cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      pingDot.className = ms < 300 ? 'good' : ms < 700 ? 'medium' : 'bad';
      pingLabel.textContent = `${ms} ms`;
    } catch {
      pingDot.className = 'bad';
      pingLabel.textContent = 'Offline';
    }
  }

  runPing();
  setInterval(runPing, 30000); // every 30s — avoids hammering the network
});