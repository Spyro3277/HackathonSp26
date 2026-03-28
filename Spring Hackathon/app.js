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

    const details = [use, levels, addr].filter(Boolean).join(' &bull; ');
    const popupHtml = `
      <div class="popup-title">${name || 'Building'}</div>
      <div class="popup-detail">${details || 'No additional info'}</div>
      <div class="popup-detail" style="margin-top:4px;color:#4b5563">OSM ID: ${el.id}</div>
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
