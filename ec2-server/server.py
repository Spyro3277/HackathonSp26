import os, json, base64, time
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_from_directory, render_template_string
from flask_cors import CORS

#server join http://52.14.28.204:5000
app = Flask(__name__)
CORS(app)

DATA_DIR  = os.path.join(os.path.dirname(__file__), "images")
DB_FILE   = os.path.join(os.path.dirname(__file__), "results.json")

os.makedirs(DATA_DIR, exist_ok=True)

def load_db():
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r") as f:
            return json.load(f)
    return []

def save_db(records):
    with open(DB_FILE, "w") as f:
        json.dump(records, f, indent=2)


# ── Dashboard HTML ────────────────────────────────────────────────────────────

DASHBOARD_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HVAC Finder — Dashboard</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      min-height: 100vh;
      background: #0f1117;
      color: #e2e8f0;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    }

    /* ── Header ── */
    .header {
      background: #1a1d27;
      border-bottom: 1px solid #2d3148;
      padding: 20px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(12px);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .logo-icon {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #7c83ff, #6366f1);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
    }

    .logo-text {
      font-size: 1.3rem;
      font-weight: 700;
      color: #e2e8f0;
      letter-spacing: -0.3px;
    }

    .logo-sub {
      font-size: 0.72rem;
      color: #6b7280;
      margin-top: 1px;
    }

    .header-stats {
      display: flex;
      gap: 24px;
    }

    .stat-card {
      background: #0f1117;
      border: 1px solid #2d3148;
      border-radius: 10px;
      padding: 10px 18px;
      text-align: center;
    }

    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: #7c83ff;
    }

    .stat-label {
      font-size: 0.68rem;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 2px;
    }

    /* ── Main ── */
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 28px 32px;
    }

    .section-title {
      font-size: 0.78rem;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 16px;
    }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      color: #4b5563;
    }

    .empty-state .icon { font-size: 3rem; margin-bottom: 16px; opacity: 0.4; }
    .empty-state h2 { font-size: 1.1rem; color: #6b7280; margin-bottom: 8px; }
    .empty-state p { font-size: 0.85rem; }

    /* ── Table ── */
    .table-wrap {
      background: #1a1d27;
      border: 1px solid #2d3148;
      border-radius: 12px;
      max-height: calc(100vh - 180px);
      overflow: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      background: #14161e;
      padding: 12px 16px;
      font-size: 0.72rem;
      font-weight: 600;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      text-align: left;
      border-bottom: 1px solid #2d3148;
      position: sticky;
      top: 0;
      z-index: 10;
    }

    tbody tr {
      border-bottom: 1px solid #1f2233;
      transition: background 0.15s;
    }

    tbody tr:hover {
      background: #1f2233;
    }

    tbody tr:last-child {
      border-bottom: none;
    }

    td {
      padding: 14px 16px;
      font-size: 0.85rem;
      color: #c9d1d9;
      vertical-align: middle;
    }

    .td-osm { font-family: 'Consolas', monospace; color: #7c83ff; font-weight: 600; }

    .td-count {
      font-size: 1.2rem;
      font-weight: 700;
    }

    .td-count.high { color: #f87171; }
    .td-count.medium { color: #f59e0b; }
    .td-count.low { color: #34d399; }

    .td-coords {
      font-family: 'Consolas', monospace;
      font-size: 0.78rem;
      color: #9ca3af;
    }

    .td-tags {
      font-size: 0.75rem;
      color: #6b7280;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .td-time {
      font-size: 0.78rem;
      color: #6b7280;
      white-space: nowrap;
    }

    /* ── Thumbnails ── */
    .thumb-wrap {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .thumb {
      width: 56px;
      height: 56px;
      border-radius: 6px;
      border: 1px solid #2d3148;
      object-fit: cover;
      background: #0a0c10;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .thumb:hover {
      transform: scale(1.08);
      box-shadow: 0 4px 16px rgba(124, 131, 255, 0.25);
    }

    .thumb-label {
      font-size: 0.6rem;
      color: #4b5563;
      text-align: center;
      margin-top: 2px;
    }

    .thumb-col {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .no-img {
      width: 56px;
      height: 56px;
      border-radius: 6px;
      border: 1px dashed #2d3148;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.6rem;
      color: #4b5563;
    }

    /* ── Lightbox ── */
    .lightbox {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.88);
      backdrop-filter: blur(8px);
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
      animation: fadeIn 0.2s ease;
    }

    .lightbox.active { display: flex; }

    .lightbox img {
      max-width: 90vw;
      max-height: 90vh;
      border-radius: 10px;
      border: 1px solid #2d3148;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
    }

    .lightbox-title {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #1a1d27;
      border: 1px solid #2d3148;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 0.8rem;
      color: #9ca3af;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    /* ── Delete button ── */
    .btn-delete {
      background: transparent;
      border: 1px solid #374151;
      border-radius: 6px;
      color: #6b7280;
      font-size: 0.75rem;
      padding: 5px 10px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-delete:hover {
      border-color: #f87171;
      color: #f87171;
      background: rgba(248, 113, 113, 0.08);
    }

    /* ── Responsive ── */
    @media (max-width: 900px) {
      .header { flex-direction: column; gap: 14px; padding: 16px; }
      .container { padding: 16px; }
      td, th { padding: 10px 8px; font-size: 0.78rem; }
      .thumb { width: 44px; height: 44px; }
    }
  </style>
</head>
<body>

  <div class="header">
    <div class="header-left">
      <div class="logo-icon">&#x2B21;</div>
      <div>
        <div class="logo-text">HVAC Finder</div>
        <div class="logo-sub">Detection Results Dashboard</div>
      </div>
    </div>
    <div class="header-stats">
      <div class="stat-card">
        <div class="stat-value" id="total-scans">-</div>
        <div class="stat-label">Total Scans</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="total-units">-</div>
        <div class="stat-label">HVAC Units Found</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="avg-count">-</div>
        <div class="stat-label">Avg / Building</div>
      </div>
    </div>
  </div>

  <div class="container">
    <div class="section-title">Detection History</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>OSM ID</th>
            <th>HVAC Count</th>
            <th>Images</th>
            <th>Coordinates</th>
            <th>Building Info</th>
            <th>Timestamp</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="results-body">
        </tbody>
      </table>
    </div>
    <div class="empty-state" id="empty-state" style="display:none;">
      <div class="icon">&#x1F3D7;</div>
      <h2>No detections yet</h2>
      <p>Run an HVAC detection from the Building Outliner app to see results here.</p>
    </div>
  </div>

  <!-- Lightbox -->
  <div class="lightbox" id="lightbox" onclick="closeLightbox()">
    <img id="lightbox-img" src="" alt="Full size" />
    <div class="lightbox-title" id="lightbox-title"></div>
  </div>

  <script>
    const API = window.location.origin;

    function openLightbox(src, title) {
      document.getElementById('lightbox-img').src = src;
      document.getElementById('lightbox-title').textContent = title;
      document.getElementById('lightbox').classList.add('active');
    }

    function closeLightbox() {
      document.getElementById('lightbox').classList.remove('active');
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeLightbox();
    });

    function countClass(n) {
      if (typeof n !== 'number') return '';
      if (n >= 10) return 'high';
      if (n >= 4) return 'medium';
      return 'low';
    }

    function formatTime(ts) {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    function buildTags(tags) {
      if (!tags || Object.keys(tags).length === 0) return '<span style="color:#374151">-</span>';
      const parts = [];
      if (tags.name) parts.push(tags.name);
      const use = tags.building && tags.building !== 'yes' ? tags.building : '';
      if (use) parts.push(use);
      if (tags['building:levels']) parts.push(tags['building:levels'] + ' floors');
      const addr = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
      if (addr) parts.push(addr);
      return parts.join(' &bull; ') || '<span style="color:#374151">-</span>';
    }

    async function deleteRecord(id) {
      if (!confirm('Delete this record?')) return;
      await fetch(API + '/api/hvac-results/' + id, { method: 'DELETE' });
      loadResults();
    }

    async function loadResults() {
      const res = await fetch(API + '/api/hvac-results');
      const data = await res.json();

      // Stats
      document.getElementById('total-scans').textContent = data.length;
      const counts = data.map(r => typeof r.count === 'number' ? r.count : 0);
      const totalUnits = counts.reduce((a, b) => a + b, 0);
      document.getElementById('total-units').textContent = totalUnits;
      document.getElementById('avg-count').textContent = data.length > 0
        ? (totalUnits / data.length).toFixed(1)
        : '-';

      const tbody = document.getElementById('results-body');
      const empty = document.getElementById('empty-state');

      if (data.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        return;
      }

      empty.style.display = 'none';

      // Sort newest first
      data.sort((a, b) => b.timestamp - a.timestamp);

      tbody.innerHTML = data.map(r => {
        const annotatedThumb = r.annotatedImage
          ? `<div class="thumb-col">
               <img class="thumb" src="${API}/images/${r.annotatedImage}"
                    onclick="event.stopPropagation();openLightbox('${API}/images/${r.annotatedImage}', 'Annotated — OSM ${r.osmId}')"
                    alt="annotated" />
               <div class="thumb-label">Annotated</div>
             </div>`
          : `<div class="thumb-col"><div class="no-img">N/A</div><div class="thumb-label">Annotated</div></div>`;

        const rawThumb = r.rawImage
          ? `<div class="thumb-col">
               <img class="thumb" src="${API}/images/${r.rawImage}"
                    onclick="event.stopPropagation();openLightbox('${API}/images/${r.rawImage}', 'Satellite — OSM ${r.osmId}')"
                    alt="satellite" />
               <div class="thumb-label">Satellite</div>
             </div>`
          : `<div class="thumb-col"><div class="no-img">N/A</div><div class="thumb-label">Satellite</div></div>`;

        const coords = (r.lat != null && r.lng != null)
          ? `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`
          : '-';

        return `<tr>
          <td class="td-osm">${r.osmId}</td>
          <td class="td-count ${countClass(r.count)}">${r.count ?? '?'}</td>
          <td><div class="thumb-wrap">${annotatedThumb}${rawThumb}</div></td>
          <td class="td-coords">${coords}</td>
          <td class="td-tags" title="${JSON.stringify(r.tags || {}).replace(/"/g, '&quot;')}">${buildTags(r.tags)}</td>
          <td class="td-time">${formatTime(r.timestamp)}</td>
          <td><button class="btn-delete" onclick="deleteRecord('${r.id}')">Delete</button></td>
        </tr>`;
      }).join('');
    }

    loadResults();
    // Auto-refresh every 15 seconds
    setInterval(loadResults, 15000);
  </script>
</body>
</html>
"""


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def dashboard():
    return render_template_string(DASHBOARD_HTML)


@app.route("/api/hvac-results", methods=["POST"])
def store_result():
    data = request.get_json(force=True)

    osm_id     = data.get("osmId")
    count      = data.get("count")
    image_b64  = data.get("image")
    raw_b64    = data.get("rawImage")
    lat        = data.get("lat")
    lng        = data.get("lng")
    tags       = data.get("tags", {})

    if osm_id is None:
        return jsonify({"error": "osmId is required"}), 400

    ts = int(time.time())

    annotated_path = None
    if image_b64:
        fname = f"{osm_id}_{ts}_annotated.jpg"
        with open(os.path.join(DATA_DIR, fname), "wb") as f:
            f.write(base64.b64decode(image_b64))
        annotated_path = fname

    raw_path = None
    if raw_b64:
        fname = f"{osm_id}_{ts}_raw.png"
        with open(os.path.join(DATA_DIR, fname), "wb") as f:
            f.write(base64.b64decode(raw_b64))
        raw_path = fname

    record = {
        "id":             f"{osm_id}_{ts}",
        "osmId":          osm_id,
        "count":          count,
        "annotatedImage": annotated_path,
        "rawImage":       raw_path,
        "lat":            lat,
        "lng":            lng,
        "tags":           tags,
        "timestamp":      ts,
    }

    db = load_db()
    db.append(record)
    save_db(db)

    return jsonify({"status": "ok", "record": record}), 201


@app.route("/api/hvac-results", methods=["GET"])
def list_results():
    return jsonify(load_db())


@app.route("/api/hvac-results/<record_id>", methods=["GET"])
def get_result(record_id):
    for r in load_db():
        if r["id"] == record_id:
            return jsonify(r)
    return jsonify({"error": "not found"}), 404


@app.route("/api/hvac-results/<record_id>", methods=["DELETE"])
def delete_result(record_id):
    db = load_db()
    new_db = [r for r in db if r["id"] != record_id]
    if len(new_db) == len(db):
        return jsonify({"error": "not found"}), 404
    save_db(new_db)
    return jsonify({"status": "deleted"})


@app.route("/images/<path:filename>")
def serve_image(filename):
    return send_from_directory(DATA_DIR, filename)


@app.route("/health")
def health():
    return jsonify({"status": "ok", "results_count": len(load_db())})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
