// Map setup
const map = L.map('map', {
  center: [40.7484, -73.9967],
  zoom: 16,
  minZoom: 3,
  maxZoom: 19,
  zoomControl: true,
});

// Tile layers
const darkTile = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  minZoom: 3,
  maxZoom: 19,
});

const satelliteTile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; <a href="https://www.esri.com/">Esri</a> &mdash; Source: Esri, USGS, NOAA',
  minZoom: 3,
  maxZoom: 19,
});

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
 * Capture a satellite image clipped precisely to a single building's footprint.
 *
 * Strategy:
 *  1. Pick a zoom level that fits the building footprint at ~512px.
 *  2. Calculate which Esri World Imagery tiles cover the bounding box at that zoom.
 *  3. Fetch every tile (CORS-friendly via a proxy-less fetch — Esri tiles allow
 *     cross-origin reads), stitch them onto an offscreen canvas.
 *  4. Use the building polygon as a canvas clip path so only pixels inside the
 *     footprint are kept (outside becomes transparent).
 *  5. Crop to the tight bounding box of the footprint and download as PNG.
 *
 * @param {number} osmId - The OSM way ID used as the storage key.
 */
async function captureBuilding(osmId) {
  const building = storedBuildings.get(osmId);
  if (!building) return;

  // ── Mercator helpers ──────────────────────────────────────────────────────

  /** Degrees → tile column at zoom z */
  function lngToTileX(lng, z) {
    return Math.floor((lng + 180) / 360 * Math.pow(2, z));
  }

  /** Degrees → tile row at zoom z */
  function latToTileY(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }

  /**
   * Lat/lng → fractional pixel offset within the full tile grid at zoom z.
   * Each tile is 256px.
   */
  function latLngToPixel(lat, lng, z) {
    const n = Math.pow(2, z);
    const x = (lng + 180) / 360 * n * 256;
    const r = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n * 256;
    return { x, y };
  }

  // ── Bounding box of the building ─────────────────────────────────────────

  const lats = building.coords.map(c => c[0]);
  const lngs = building.coords.map(c => c[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  // ── Choose zoom: aim for ~512px on the longer axis, capped at z=20 ───────

  const TARGET_PX = 512;
  let zoom = 19; // start high and step down if we'd need too many tiles
  for (; zoom >= 14; zoom--) {
    const topLeft = latLngToPixel(maxLat, minLng, zoom);
    const botRight = latLngToPixel(minLat, maxLng, zoom);
    const w = Math.abs(botRight.x - topLeft.x);
    const h = Math.abs(botRight.y - topLeft.y);
    if (Math.max(w, h) <= TARGET_PX * 3) break; // keep tile count sane
  }

  // ── Tile range ───────────────────────────────────────────────────────────

  const txMin = lngToTileX(minLng, zoom);
  const txMax = lngToTileX(maxLng, zoom);
  const tyMin = latToTileY(maxLat, zoom); // NW corner → smallest y
  const tyMax = latToTileY(minLat, zoom);

  const TILE = 256;
  const canvasW = (txMax - txMin + 1) * TILE;
  const canvasH = (tyMax - tyMin + 1) * TILE;

  // ── Stitch tiles onto offscreen canvas ───────────────────────────────────

  const stitchCanvas = document.createElement('canvas');
  stitchCanvas.width = canvasW;
  stitchCanvas.height = canvasH;
  const stitchCtx = stitchCanvas.getContext('2d');

  // Esri World Imagery — tiles are served with permissive CORS headers
  const tileUrlTemplate = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  const tilePromises = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      const url = tileUrlTemplate
        .replace('{z}', zoom)
        .replace('{y}', ty)
        .replace('{x}', tx);

      tilePromises.push(
        new Promise(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const dx = (tx - txMin) * TILE;
            const dy = (ty - tyMin) * TILE;
            stitchCtx.drawImage(img, dx, dy);
            resolve();
          };
          img.onerror = resolve; // skip failed tiles gracefully
          img.src = url;
        })
      );
    }
  }

  await Promise.all(tilePromises);

  // ── Project building polygon into stitched-canvas pixel space ────────────

  /** Converts a lat/lng pair to pixel coords relative to the stitched canvas origin */
  function coordToCanvasPx([lat, lng]) {
    const px = latLngToPixel(lat, lng, zoom);
    return [
      px.x - txMin * TILE,
      px.y - tyMin * TILE,
    ];
  }

  const polyPoints = building.coords.map(coordToCanvasPx);

  // ── Build clipped output canvas (transparent outside footprint) ───────────

  const outCanvas = document.createElement('canvas');
  outCanvas.width = canvasW;
  outCanvas.height = canvasH;
  const outCtx = outCanvas.getContext('2d');

  // Draw clipping path
  outCtx.beginPath();
  outCtx.moveTo(polyPoints[0][0], polyPoints[0][1]);
  for (let i = 1; i < polyPoints.length; i++) {
    outCtx.lineTo(polyPoints[i][0], polyPoints[i][1]);
  }
  outCtx.closePath();
  outCtx.clip();

  // Paint satellite imagery inside the clip
  outCtx.drawImage(stitchCanvas, 0, 0);

  // ── Crop tightly to the footprint bounding box ────────────────────────────

  const pxs = polyPoints.map(p => p[0]);
  const pys = polyPoints.map(p => p[1]);
  const pad = 20; // pixels of satellite context around the building
  const cropX = Math.max(0, Math.floor(Math.min(...pxs)) - pad);
  const cropY = Math.max(0, Math.floor(Math.min(...pys)) - pad);
  const cropW = Math.min(canvasW - cropX, Math.ceil(Math.max(...pxs)) - cropX + pad);
  const cropH = Math.min(canvasH - cropY, Math.ceil(Math.max(...pys)) - cropY + pad);

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(outCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  // ── Download ──────────────────────────────────────────────────────────────

  cropCanvas.toBlob(pngBlob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(pngBlob);
    a.download = `building_${osmId}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
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
  const query = `
    [out:json][timeout:30];
    (
      way["building"](around:${radius},${lat},${lng});
      relation["building"](around:${radius},${lat},${lng});
    );
    out body;
    >;
    out skel qt;
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

    // Store building data keyed by OSM ID
    storedBuildings.set(el.id, { coords, tags, osmId: el.id });

    const details = [use, levels, addr].filter(Boolean).join(' &bull; ');
    const popupHtml = `
      <div class="popup-title">${name || 'Building'}</div>
      <div class="popup-detail">${details || 'No additional info'}</div>
      <div class="popup-detail" style="margin-top:4px;color:#4b5563">OSM ID: ${el.id}</div>
      <button
        onclick="this.textContent='Fetching…';this.disabled=true;captureBuilding(${el.id}).finally(()=>{this.textContent='⬇ Save as PNG';this.disabled=false;})"
        style="margin-top:8px;padding:4px 10px;background:#7c83ff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;"
      >⬇ Save as PNG</button>
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
      await fetch('https://overpass-api.de/api/status', { method: 'HEAD', cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      pingDot.className = ms < 300 ? 'good' : ms < 700 ? 'medium' : 'bad';
      pingLabel.textContent = `${ms} ms`;
    } catch {
      pingDot.className = 'bad';
      pingLabel.textContent = 'Offline';
    }
  }

  runPing();
  setInterval(runPing, 1000);
});