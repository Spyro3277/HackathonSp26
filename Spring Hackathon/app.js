// ── Single source of truth for zoom ──────────────────────────────────────────
// Every tile fetch in this program — the map layer AND captureBuilding —
// uses this constant so imagery is always consistent.
const MAPBOX_TOKEN = 'pk.eyJ1Ijoic3B5cm8zMjc3IiwiYSI6ImNtbmF0M2c5NDBteXYycHByaXZ6aWd1aWsifQ.CQVZB3H72RVaYzITHLvOww';
const CAPTURE_ZOOM = 20; // z19 = highest detail Mapbox satellite offers (~30cm/px)

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
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Active search controller — lets cancelSearch() abort in-flight requests
let searchAbortController = null;

/**
 * Race all Overpass mirrors in parallel; return the first successful JSON response.
 * Passes the caller's AbortSignal so cancel propagates to every in-flight request.
 */
async function overpassFetch(query, callerSignal, timeoutMs = 25000) {
  const controllers = OVERPASS_ENDPOINTS.map(() => new AbortController());

  const abortAll = () => controllers.forEach(c => c.abort());

  // Propagate caller cancel to every in-flight request
  if (callerSignal) {
    callerSignal.addEventListener('abort', abortAll, { once: true });
  }

  const racePromises = OVERPASS_ENDPOINTS.map((endpoint, i) => {
    const timer = setTimeout(() => controllers[i].abort(), timeoutMs);
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
      // Cancel all other in-flight requests as soon as one returns data —
      // prevents ghost connections from piling up across consecutive searches
      abortAll();
      return data;
    }).catch(err => {
      clearTimeout(timer);
      throw err;
    });
  });

  // First mirror to return valid data wins
  return Promise.any(racePromises);
}

/**
 * For each Mapbox satellite tile that intersects the building's footprint at
 * CAPTURE_ZOOM, emit a separate PNG — 512×512px, clipped to the polygon.
 *
 * This gives the maximum zoom level (z19 ≈ 30cm/px) for every output image.
 * A building spanning N tiles produces N downloads, each a full-resolution tile
 * with only the building pixels visible (transparent outside the footprint).
 */
async function captureBuilding(osmId) {
  const building = storedBuildings.get(osmId);
  if (!building) return;

  const Z       = CAPTURE_ZOOM;
  const N       = Math.pow(2, Z);
  const GRID_PX = 256;   // logical tile-grid cell size used for all coordinate math
  const TILE_PX = 512;   // @2x tile image is 512×512 rendered pixels

  // ── Mercator helpers ──────────────────────────────────────────────────────

  function tileCol(lng) {
    return Math.floor((lng + 180) / 360 * N);
  }
  function tileRow(lat) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N);
  }

  /**
   * Convert [lat, lng] → pixel coords within a specific tile's 512×512 canvas.
   * tx, ty are the tile column/row of that tile.
   */
  function toTilePx([lat, lng], tx, ty) {
    const worldX = (lng + 180) / 360 * N * GRID_PX;
    const r      = lat * Math.PI / 180;
    const worldY = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N * GRID_PX;
    // Subtract the tile's NW world-pixel origin, then scale ×2 for @2x
    return [
      (worldX - tx * GRID_PX) * 2,
      (worldY - ty * GRID_PX) * 2,
    ];
  }

  // ── Derive tile range from footprint bounding box ─────────────────────────

  const lats = building.coords.map(c => c[0]);
  const lngs = building.coords.map(c => c[1]);
  const txMin = tileCol(Math.min(...lngs));
  const txMax = tileCol(Math.max(...lngs));
  const tyMin = tileRow(Math.max(...lats));   // maxLat → smallest row index (NW)
  const tyMax = tileRow(Math.min(...lats));

  const totalTiles = (txMax - txMin + 1) * (tyMax - tyMin + 1);

  // ── Fetch all tiles in parallel, then emit one PNG per tile ──────────────

  // Pre-load all tile images so we can reuse them across the per-tile canvases
  const tileImages = new Map(); // key: `${tx},${ty}` → HTMLImageElement

  await Promise.all(
    Array.from({ length: txMax - txMin + 1 }, (_, ci) => txMin + ci).flatMap(tx =>
      Array.from({ length: tyMax - tyMin + 1 }, (_, ri) => tyMin + ri).map(ty =>
        new Promise(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload  = () => { tileImages.set(`${tx},${ty}`, img); resolve(); };
          img.onerror = () => resolve(); // missing tile → just skip
          img.src = `https://api.mapbox.com/v4/mapbox.satellite/${Z}/${tx}/${ty}@2x.jpg90?access_token=${MAPBOX_TOKEN}`;
        })
      )
    )
  );

  // Emit one PNG per tile, staggered slightly so the browser doesn't block
  let tileIndex = 0;
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      const tileImg = tileImages.get(`${tx},${ty}`);
      if (!tileImg) continue; // tile failed to load — skip silently

      // Project the full building polygon into this tile's pixel space
      const polyPoints = building.coords.map(c => toTilePx(c, tx, ty));

      // Quick reject: if every polygon vertex is outside this 512×512 tile,
      // the building doesn't actually touch it — skip without emitting a file.
      const anyInside = polyPoints.some(
        ([px, py]) => px >= 0 && px <= TILE_PX && py >= 0 && py <= TILE_PX
      );
      if (!anyInside) continue;

      // Draw tile, clip to polygon, export
      const canvas = document.createElement('canvas');
      canvas.width  = TILE_PX;
      canvas.height = TILE_PX;
      const ctx = canvas.getContext('2d');

      // Clip path = building polygon projected into this tile
      ctx.beginPath();
      ctx.moveTo(polyPoints[0][0], polyPoints[0][1]);
      for (let i = 1; i < polyPoints.length; i++) {
        ctx.lineTo(polyPoints[i][0], polyPoints[i][1]);
      }
      ctx.closePath();
      ctx.clip();

      ctx.drawImage(tileImg, 0, 0);

      // Stagger downloads by 80ms each so browsers don't throttle them
      await new Promise(resolve => {
        canvas.toBlob(blob => {
          if (!blob) { resolve(); return; }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `building_${osmId}_z${Z}_tile_${tx}_${ty}.png`;
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); resolve(); }, 80);
        }, 'image/png');
      });

      tileIndex++;
    }
  }
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
      setStatus('No buildings found at this location. Try increasing the radius.', '');
    } else {
      setStatus(`Found ${count} building${count !== 1 ? 's' : ''}.`, 'success');
    }
    showResults(count);
  } catch (err) {
    if (err.name === 'AbortError' || (err instanceof AggregateError && err.errors.every(e => e.name === 'AbortError'))) {
      setStatus('Search cancelled.', '');
    } else {
      console.error(err);
      setStatus('Failed to fetch building data. Check your connection and try again.', 'error');
    }
  } finally {
    searchAbortController = null;
    setLoading(false);
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