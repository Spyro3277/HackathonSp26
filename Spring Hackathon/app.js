// Map setup
const map = L.map('map', {
  center: [40.7484, -73.9967],
  zoom: 16,
  zoomControl: true,
});

// Tile layers
const darkTile = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 20,
});

const satelliteTile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; <a href="https://www.esri.com/">Esri</a> &mdash; Source: Esri, USGS, NOAA',
  maxZoom: 20,
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
  btn.disabled = loading;
  text.textContent = loading ? 'Searching...' : 'Outline Buildings';
  spinner.classList.toggle('hidden', !loading);
}

function showResults(count) {
  const el = document.getElementById('results');
  document.getElementById('building-count').textContent = count;
  el.classList.toggle('hidden', count === 0);
}

function clearBuildings() {
  buildingLayers.forEach(layer => map.removeLayer(layer));
  buildingLayers = [];
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
}

async function searchBuildings() {
  const lat = parseFloat(document.getElementById('lat').value);
  const lng = parseFloat(document.getElementById('lng').value);
  const radius = parseInt(document.getElementById('radius').value) || 200;

  if (isNaN(lat) || isNaN(lng)) {
    setStatus('Please enter valid latitude and longitude.', 'error');
    return;
  }
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

  // Overpass API query — fetch all building ways within radius
  const query = `
    [out:json][timeout:25];
    (
      way["building"](around:${radius},${lat},${lng});
      relation["building"](around:${radius},${lat},${lng});
    );
    out body;
    >;
    out skel qt;
  `;

  const overpassUrl = 'https://overpass-api.de/api/interpreter';

  try {
    const response = await fetch(overpassUrl, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const count = renderBuildings(data);

    if (count === 0) {
      setStatus('No buildings found at this location. Try increasing the radius.', '');
    } else {
      setStatus(`Found ${count} building${count !== 1 ? 's' : ''}.`, 'success');
    }
    showResults(count);
  } catch (err) {
    console.error(err);
    setStatus('Failed to fetch building data. Check your connection and try again.', 'error');
  } finally {
    setLoading(false);
  }
}

function renderBuildings(data) {
  // Build a node lookup: id -> [lat, lng]
  const nodes = {};
  data.elements.forEach(el => {
    if (el.type === 'node') {
      nodes[el.id] = [el.lat, el.lon];
    }
  });

  let count = 0;

  data.elements.forEach(el => {
    if (el.type !== 'way' || !el.nodes) return;

    const coords = el.nodes.map(id => nodes[id]).filter(Boolean);
    if (coords.length < 3) return;

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

    polygon.on('mouseover', function () {
      this.setStyle(buildingHoverStyle);
      this.bringToFront();
    });
    polygon.on('mouseout', function () {
      this.setStyle(buildingStyle);
    });

    buildingLayers.push(polygon);
    count++;
  });

  // Fit map to show all buildings
  if (buildingLayers.length > 0) {
    const group = L.featureGroup(buildingLayers);
    map.fitBounds(group.getBounds().pad(0.15));
  }

  return count;
}

// Allow pressing Enter in inputs to trigger search
document.addEventListener('DOMContentLoaded', () => {
  ['lat', 'lng', 'radius'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') searchBuildings();
    });
  });
});