
(() => {
  const mode = localStorage.getItem('tempo-suite-theme') || 'system';
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = mode === 'system' ? (dark ? 'dark' : 'light') : mode;
})();





// Onglets
const tabBtns = document.querySelectorAll('.tab-btn');
const tbPanels = document.querySelectorAll('.tb-panel');
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tbPanels.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    setTimeout(() => { if(map) map.resize(); }, 50);
  });
});

// Menus contextuels : un seul ouvert à la fois. Les actions se referment
// automatiquement après un clic, ce qui évite qu'un menu masque la carte sur
// téléphone. Les listes déroulantes et curseurs restent ouverts pendant le réglage.
const toolbarDetails = [...document.querySelectorAll('details.toolbar-more')];
toolbarDetails.forEach(details => {
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    toolbarDetails.forEach(other => { if (other !== details) other.open = false; });
  });
  details.querySelectorAll('.toolbar-menu button').forEach(button => {
    button.addEventListener('click', () => { setTimeout(() => { details.open = false; }, 0); });
  });
});
tabBtns.forEach(btn => btn.addEventListener('click', () => toolbarDetails.forEach(d => { d.open = false; })));

// MapTiler & Clé
let MAPTILER_KEY = localStorage.getItem('maptiler_api_key') || '';
const keyModal = document.getElementById('keyModal');
const apiKeyInput = document.getElementById('apiKeyInput');
let pendingAction = null;

document.getElementById('closeKeyBtn').addEventListener('click', () => {
  keyModal.classList.add('hidden');
  if (pendingAction === 'style') document.getElementById('mapStyleSelect').value = 'osm';
  pendingAction = null;
});
document.getElementById('btnKey').addEventListener('click', () => {
  pendingAction = null;
  apiKeyInput.value = MAPTILER_KEY;
  keyModal.classList.remove('hidden');
});
document.getElementById('saveKeyBtn').addEventListener('click', () => {
  const val = apiKeyInput.value.trim();
  if (val) {
    MAPTILER_KEY = val;
    localStorage.setItem('maptiler_api_key', val);
    keyModal.classList.add('hidden');
    if (pendingAction === '3d') document.getElementById('btn3D').click();
    else if (pendingAction === 'style') map.setStyle(getStyleUrl(document.getElementById('mapStyleSelect').value));
    else if (pendingAction === 'recalibrate') recalibrateElevation();
    pendingAction = null;
  } else alert('Clé vide.');
});

// Carte & Amortisseurs de Caméra (Lerp)
const ELE_THRESHOLD = 1.5;
let is3DMode = false, map = null;
document.getElementById('cinema-watermark').textContent = 'GPX Compare ' + document.getElementById('appVersion').textContent;
let currentCameraBearing = 0;
let currentSlope = 0;
let currentCameraPitch = 0;
let currentZoomMargin = 0;
let currentCameraZoom = 14;
const SMOOTHING_FACTOR = 0.06; // Ajustement de l'amorti anti-vibration

function lerp(start, end, amount) { return (1 - amount) * start + amount * end; }
function lerpAngle(start, end, amount) {
    let diff = end - start;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return start + diff * amount;
}

const osmStyle = {
  "version": 8,
  "sources": { "osm": { "type": "raster", "tiles": ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], "tileSize": 256, "attribution": "© OpenStreetMap contributors" } },
  "layers": [{ "id": "osm-layer", "type": "raster", "source": "osm" }]
};

function getStyleUrl(styleName) {
  if (styleName === 'osm' || !MAPTILER_KEY) return osmStyle;
  return `https://api.maptiler.com/maps/${styleName}/style.json?key=${MAPTILER_KEY}`;
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: getStyleUrl(document.getElementById('mapStyleSelect').value),
    center: [2.5, 46.6], zoom: 5.5, maxPitch: 85, preserveDrawingBuffer: true,
    transformRequest: (url) => {
      if (url.includes('maptiler.com') && !url.includes('key=')) {
        return { url: url + (url.includes('?') ? '&' : '?') + 'key=' + MAPTILER_KEY };
      }
      return { url };
    }
  });
  map.on('style.load', () => {
    // On restaure d'abord les traces GPX et le curseur : même si l'étape 3D
    // plante plus bas (style sans couche bâtiment exploitable), les traces
    // doivent rester visibles après un changement de fond de carte.
    restoreTracksOnMap();
    initTrackerLayer();
    ensurePlaceLabelLayers();
    if (activeTrackId) setTrackPositionByRatio(currentRatio);
    try {
      if (is3DMode) apply3DTerrain();
      apply3DBuildings();
    } catch (err) {
      console.error('Rendu 3D (terrain/bâtiments) indisponible sur ce fond de carte :', err);
    }
    // Filet de sécurité : une fois le style totalement stabilisé (toutes les
    // tuiles/couches internes chargées), on repasse une fois sur les traces.
    // Sans ça, sur certains changements de fond de carte, la trace pouvait
    // rester invisible tant qu'on n'ouvrait/fermait pas manuellement l'œil
    // dans le panneau Sorties.
    map.once('idle', () => { restoreTracksOnMap(); initTrackerLayer(); ensurePlaceLabelLayers(); schedulePlaceLabelsRefresh(50); });
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
}

function apply3DTerrain() {
  if (!map || !MAPTILER_KEY) return;
  if (!map.getSource('maptiler-dem')) {
    map.addSource('maptiler-dem', { 'type': 'raster-dem', 'url': `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`, 'tileSize': 512, 'maxzoom': 14 });
  }
  map.setTerrain({ 'source': 'maptiler-dem', 'exaggeration': 1.2 });
}

function apply3DBuildings() {
  if (!map || !map.getStyle().layers) return;
  // Cherche une vraie couche vectorielle "building" (avec une source valide),
  // en évitant les couches type "background" qui n'ont pas de source-layer.
  const buildingLayer = map.getStyle().layers.find(l =>
    l.source && (l.id.includes('building') || l['source-layer'] === 'building') && l.type !== 'fill-extrusion'
  );
  if (buildingLayer && !map.getLayer('3d-buildings')) {
    map.addLayer({
      'id': '3d-buildings', 'source': buildingLayer.source, 'source-layer': buildingLayer['source-layer'], 'type': 'fill-extrusion', 'minzoom': 13,
      'paint': {
        'fill-extrusion-color': '#d1d1d1',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 10],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.85
      }
    }, buildingLayer.id);
  }
}

function initTrackerLayer() {
  if (!map) return;
  if (!map.getSource('tracker-source')) {
    map.addSource('tracker-source', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } } });
    map.addLayer({ id: 'tracker-layer', type: 'circle', source: 'tracker-source', paint: { 'circle-radius': 7, 'circle-color': '#00aaff', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
  } else if (map.getLayer('tracker-layer')) map.moveLayer('tracker-layer');
}

document.getElementById('mapStyleSelect').addEventListener('change', (e) => {
  if (e.target.value !== 'osm' && !MAPTILER_KEY) { pendingAction = 'style'; keyModal.classList.remove('hidden'); return; }
  map.setStyle(getStyleUrl(e.target.value));
});

let showPlaceLabels = true;
let placeLabelRefreshTimer = null;
let placeLabelAbortController = null;
const placeLabelCache = new Map();
const PLACE_LABEL_SOURCE_ID = 'tempo-place-labels';

function getTrackBounds() {
  const visibleTracks = tracks.filter(t => t.visible && t.data.points.length);
  if (!visibleTracks.length) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  visibleTracks.forEach(t => t.data.points.forEach(p => {
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }));
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

function expandBbox(bbox) {
  const lonPad = Math.max(0.02, (bbox.east - bbox.west) * 0.18);
  const latPad = Math.max(0.02, (bbox.north - bbox.south) * 0.18);
  return {
    west: Math.max(-180, bbox.west - lonPad),
    south: Math.max(-85, bbox.south - latPad),
    east: Math.min(180, bbox.east + lonPad),
    north: Math.min(85, bbox.north + latPad)
  };
}

function bboxCacheKey(bbox) {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map(v => v.toFixed(3)).join('|');
}

function setPlaceLabelData(fc) {
  if (!map || !map.getSource(PLACE_LABEL_SOURCE_ID)) return;
  map.getSource(PLACE_LABEL_SOURCE_ID).setData(fc);
}

function ensurePlaceLabelLayers() {
  if (!map) return;
  if (!map.getSource(PLACE_LABEL_SOURCE_ID)) {
    map.addSource(PLACE_LABEL_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getLayer('place-labels-major')) {
    map.addLayer({
      id: 'place-labels-major',
      type: 'symbol',
      source: PLACE_LABEL_SOURCE_ID,
      filter: ['match', ['get', 'place'], ['city', 'town', 'village'], true, false],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 7, ['match', ['get', 'place'], 'city', 14, 'town', 13, 12], 12, ['match', ['get', 'place'], 'city', 20, 'town', 17, 15]],
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.55,
        'text-padding': 3,
        'symbol-sort-key': ['get', 'rank'],
        'text-allow-overlap': false,
        'text-ignore-placement': false
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.78)', 'text-halo-width': 1.4 }
    });
  }
  if (!map.getLayer('place-labels-minor')) {
    map.addLayer({
      id: 'place-labels-minor',
      type: 'symbol',
      source: PLACE_LABEL_SOURCE_ID,
      minzoom: 10,
      filter: ['match', ['get', 'place'], ['hamlet', 'suburb', 'neighbourhood', 'locality', 'isolated_dwelling'], true, false],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 13],
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.45,
        'text-padding': 2,
        'symbol-sort-key': ['get', 'rank'],
        'text-allow-overlap': false,
        'text-ignore-placement': false
      },
      paint: { 'text-color': '#eef6ff', 'text-halo-color': 'rgba(0,0,0,0.8)', 'text-halo-width': 1.15 }
    });
  }
  // Garantit que les tracés et le curseur restent au-dessus des toponymes.
  tracks.forEach(t => {
    if (map.getLayer(t.id + '-hit')) map.moveLayer(t.id + '-hit');
    if (map.getLayer(t.id)) map.moveLayer(t.id);
  });
  if (map.getLayer('tracker-layer')) map.moveLayer('tracker-layer');
}

async function fetchPlaceLabelData(bbox) {
  const query = `[out:json][timeout:20];(node["place"~"city|town|village|hamlet|suburb|neighbourhood|locality|isolated_dwelling"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way["place"~"city|town|village|hamlet|suburb|neighbourhood|locality|isolated_dwelling"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});relation["place"~"city|town|village|hamlet|suburb|neighbourhood|locality|isolated_dwelling"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out center;`;
  const urls = [
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
    `https://overpass.kumi.systems/api/interpreter?data=${encodeURIComponent(query)}`
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: placeLabelAbortController?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') throw err;
    }
  }
  throw lastError || new Error('Aucune source Overpass disponible');
}

async function refreshPlaceLabels() {
  if (!map) return;
  ensurePlaceLabelLayers();
  if (!showPlaceLabels || !tracks.some(t => t.visible)) { setPlaceLabelData({ type: 'FeatureCollection', features: [] }); return; }
  const bbox = getTrackBounds();
  if (!bbox) { setPlaceLabelData({ type: 'FeatureCollection', features: [] }); return; }
  const expanded = expandBbox(bbox);
  const key = bboxCacheKey(expanded);
  if (placeLabelCache.has(key)) { setPlaceLabelData(placeLabelCache.get(key)); return; }
  if (placeLabelAbortController) placeLabelAbortController.abort();
  placeLabelAbortController = new AbortController();
  try {
    const data = await fetchPlaceLabelData(expanded);
    const seen = new Set();
    const rankMap = { city: 1, town: 2, village: 3, hamlet: 4, suburb: 5, neighbourhood: 6, locality: 7, isolated_dwelling: 8 };
    const features = (data.elements || []).map(el => {
      const lon = el.lon ?? el.center?.lon;
      const lat = el.lat ?? el.center?.lat;
      const name = el.tags?.name;
      const place = el.tags?.place || 'locality';
      if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      const key = `${place}|${name.toLowerCase()}|${lon.toFixed(4)}|${lat.toFixed(4)}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { name, place, rank: rankMap[place] || 9 }
      };
    }).filter(Boolean);
    const fc = { type: 'FeatureCollection', features };
    placeLabelCache.set(key, fc);
    setPlaceLabelData(fc);
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Toponymes indisponibles :', err);
  }
}

function schedulePlaceLabelsRefresh(delay = 250) {
  clearTimeout(placeLabelRefreshTimer);
  placeLabelRefreshTimer = setTimeout(() => { refreshPlaceLabels(); }, delay);
}

document.getElementById('btnPlaceLabels').addEventListener('click', (e) => {
  showPlaceLabels = !showPlaceLabels;
  e.currentTarget.classList.toggle('active', showPlaceLabels);
  if (showPlaceLabels) refreshPlaceLabels();
  else setPlaceLabelData({ type: 'FeatureCollection', features: [] });
});

const suiteThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
function applySuiteTheme(mode) {
  const selected = ['system','dark','light'].includes(mode) ? mode : 'system';
  const resolved = selected === 'system' ? (suiteThemeMedia.matches ? 'dark' : 'light') : selected;
  document.documentElement.dataset.themeMode = selected;
  document.documentElement.dataset.theme = resolved;
  document.getElementById('themeSelect').value = selected;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#071824' : '#f2f6fa');
}
applySuiteTheme(localStorage.getItem('tempo-suite-theme') || 'system');
document.getElementById('themeSelect').addEventListener('change', (e) => {
  localStorage.setItem('tempo-suite-theme', e.target.value);
  applySuiteTheme(e.target.value);
});
const followSuiteSystemTheme = () => {
  if ((localStorage.getItem('tempo-suite-theme') || 'system') === 'system') applySuiteTheme('system');
};
if (suiteThemeMedia.addEventListener) suiteThemeMedia.addEventListener('change', followSuiteSystemTheme);
else suiteThemeMedia.addListener(followSuiteSystemTheme);

document.getElementById('btn3D').addEventListener('click', () => {
  if (!is3DMode && !MAPTILER_KEY) { pendingAction = '3d'; keyModal.classList.remove('hidden'); return; }
  is3DMode = !is3DMode;
  document.getElementById('btn3D').classList.toggle('active', is3DMode);
  currentCameraPitch = is3DMode ? 60 : 0;
  if (map) {
    if (is3DMode) { apply3DTerrain(); map.easeTo({ pitch: 60, duration: 800 }); }
    else { map.setTerrain(null); map.easeTo({ pitch: 0, duration: 800 }); }
  }
});

// Option : Pente / D+ en direct
let showLiveStats = false;
// Panneau "Sorties" sur mobile : coincé en bas par défaut (poignée visible),
// s'ouvre en cliquant le bouton dédié ou en tapant/glissant sur sa poignée.
const sideEl = document.getElementById('side');
const toggleSideBtn = document.getElementById('toggleSide');
if (toggleSideBtn) toggleSideBtn.addEventListener('click', () => {
  sideEl.classList.toggle('open');
  toggleSideBtn.classList.toggle('active', sideEl.classList.contains('open'));
});
const sideHeaderEl = document.getElementById('sideHeader');
if (sideHeaderEl) sideHeaderEl.addEventListener('click', (e) => {
  if (window.innerWidth > 700) return; // uniquement utile en layout mobile
  sideEl.classList.toggle('open');
  if (toggleSideBtn) toggleSideBtn.classList.toggle('active', sideEl.classList.contains('open'));
});

const btnLiveStats = document.getElementById('btnLiveStats');
const cinemaLiveStats = document.getElementById('cinema-live-stats');

btnLiveStats.addEventListener('click', () => {
  showLiveStats = !showLiveStats;
  btnLiveStats.classList.toggle('active', showLiveStats);
  document.body.classList.toggle('live-stats-on', showLiveStats);
  updateCinemaLiveStatsVisibility();
});

// Option : Mini-carte 2D (bas-gauche / bas-droite)
const minimapWrap = document.getElementById('minimap-wrap');
const minimapCanvas = document.getElementById('minimapCanvas');
const mctx = minimapCanvas.getContext('2d');
let minimapPos = 'off', minimapBounds = null;

// Le badge D+/Pente du mode Cinéma se place dans le coin opposé à la
// mini-carte pour ne jamais se chevaucher avec elle.
function updateCinemaLiveStatsVisibility() {
  cinemaLiveStats.classList.toggle('hidden', !showLiveStats);
  const oppositeCorner = minimapPos === 'left' ? 'right' : 'left'; // 'off' -> bas-gauche par défaut
  cinemaLiveStats.classList.toggle('corner-left', oppositeCorner === 'left');
  cinemaLiveStats.classList.toggle('corner-right', oppositeCorner === 'right');
}

document.getElementById('minimapPosSelect').addEventListener('change', (e) => {
  minimapPos = e.target.value;
  minimapWrap.classList.toggle('hidden', minimapPos === 'off');
  minimapWrap.classList.toggle('pos-left', minimapPos === 'left');
  minimapWrap.classList.toggle('pos-right', minimapPos === 'right');
  if (minimapPos !== 'off') { resizeMinimap(); drawMinimapRoute(); }
  updateCinemaLiveStatsVisibility();
  updateMiniProfileVisibility(); // dépend de l'état de la mini-carte (même coin, masqué si elle l'est)
});

function resizeMinimap() {
  const rect = minimapWrap.getBoundingClientRect();
  if (!rect.width) return;
  minimapCanvas.width = rect.width * window.devicePixelRatio;
  minimapCanvas.height = rect.height * window.devicePixelRatio;
}

// Le tracé statique (potentiellement des milliers de points GPS) est dessiné
// une seule fois sur un canvas hors-écran, plutôt que d'être entièrement
// redessiné à chaque frame d'animation — c'était devenu un vrai goulot
// d'étranglement et une source de saccades une fois la mini-carte ajoutée.
let minimapRouteCanvas = null, minimapRouteCtx = null;

function drawMinimapRoute() {
  if (minimapPos === 'off') return;
  const tr = tracks.find(t => t.id === activeTrackId);
  if (!tr || !tr.data.points.length) { mctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height); minimapBounds = null; return; }
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  tr.data.points.forEach(p => { if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon; if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat; });
  minimapBounds = { minLon, maxLon, minLat, maxLat };

  if (!minimapRouteCanvas) { minimapRouteCanvas = document.createElement('canvas'); minimapRouteCtx = minimapRouteCanvas.getContext('2d'); }
  minimapRouteCanvas.width = minimapCanvas.width; minimapRouteCanvas.height = minimapCanvas.height;
  minimapRouteCtx.clearRect(0, 0, minimapRouteCanvas.width, minimapRouteCanvas.height);
  minimapRouteCtx.beginPath();
  tr.data.points.forEach((p, i) => { const [x, y] = projectMinimap(p.lon, p.lat); i === 0 ? minimapRouteCtx.moveTo(x, y) : minimapRouteCtx.lineTo(x, y); });
  minimapRouteCtx.strokeStyle = tr.color; minimapRouteCtx.lineWidth = 2 * window.devicePixelRatio; minimapRouteCtx.stroke();

  redrawMinimap();
}

function projectMinimap(lon, lat) {
  const w = minimapCanvas.width, h = minimapCanvas.height, pad = 10 * window.devicePixelRatio;
  const { minLon, maxLon, minLat, maxLat } = minimapBounds;
  const lonSpan = (maxLon - minLon) || 0.001, latSpan = (maxLat - minLat) || 0.001;
  // Conserve le ratio pour ne pas déformer le tracé
  const scale = Math.min((w - pad * 2) / lonSpan, (h - pad * 2) / latSpan);
  const drawW = lonSpan * scale, drawH = latSpan * scale;
  const offX = pad + ((w - pad * 2) - drawW) / 2, offY = pad + ((h - pad * 2) - drawH) / 2;
  return [offX + (lon - minLon) * scale, offY + (maxLat - lat) * scale]; // Y inversé (nord en haut)
}

function redrawMinimap() {
  if (minimapPos === 'off' || !minimapBounds || !minimapRouteCanvas) return;
  const tr = tracks.find(t => t.id === activeTrackId);
  if (!tr || !tr.data.points.length) return;
  const pts = tr.data.points;
  mctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  mctx.drawImage(minimapRouteCanvas, 0, 0);

  let p1, p2, f = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    if (currentRatio >= pts[i].fraction && currentRatio <= pts[i+1].fraction) { p1 = pts[i]; p2 = pts[i+1]; f = (currentRatio - p1.fraction) / (p2.fraction - p1.fraction || 1); break; }
  }
  if (!p1) { p1 = pts[pts.length-1]; p2 = p1; }
  const lon = p1.lon + (p2.lon - p1.lon) * f, lat = p1.lat + (p2.lat - p1.lat) * f;
  const [mx, my] = projectMinimap(lon, lat);
  mctx.beginPath(); mctx.arc(mx, my, 4 * window.devicePixelRatio, 0, 2 * Math.PI);
  mctx.fillStyle = '#00aaff'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5 * window.devicePixelRatio; mctx.fill(); mctx.stroke();
}
window.addEventListener('resize', () => { if (minimapPos !== 'off') { resizeMinimap(); drawMinimapRoute(); } if (showMiniProfile) { resizeMiniProfile(); drawMiniProfileRoute(); } });

// Profil de dénivelé (option), au-dessus de la mini-carte — même logique de
// cache que la mini-carte : la courbe statique n'est dessinée qu'une fois,
// seul le repère de position est redessiné à chaque frame.
let showMiniProfile = false;
const miniProfileWrap = document.getElementById('mini-profile-wrap');
const miniProfileCanvas = document.getElementById('miniProfileCanvas');
const mpCtx = miniProfileCanvas.getContext('2d');
let miniProfileRouteCanvas = null, miniProfileRouteCtx = null;
let miniProfileBounds = null; // { minEle, maxEle, minDist, maxDist }

function updateMiniProfileVisibility() {
  // N'a de sens qu'accolé à la mini-carte : pas de mini-carte, pas de profil.
  const visible = showMiniProfile && minimapPos !== 'off';
  miniProfileWrap.classList.toggle('hidden', !visible);
  miniProfileWrap.classList.toggle('pos-left', minimapPos === 'left');
  miniProfileWrap.classList.toggle('pos-right', minimapPos === 'right');
  if (visible) { resizeMiniProfile(); drawMiniProfileRoute(); }
}

document.getElementById('btnMiniProfile').addEventListener('click', () => {
  showMiniProfile = !showMiniProfile;
  document.getElementById('btnMiniProfile').classList.toggle('active', showMiniProfile);
  updateMiniProfileVisibility();
});

function resizeMiniProfile() {
  const rect = miniProfileWrap.getBoundingClientRect();
  if (!rect.width) return;
  miniProfileCanvas.width = rect.width * window.devicePixelRatio;
  miniProfileCanvas.height = rect.height * window.devicePixelRatio;
}

function drawMiniProfileRoute() {
  if (!showMiniProfile || minimapPos === 'off') return;
  const tr = tracks.find(t => t.id === activeTrackId);
  if (!tr || !tr.data.hasElevation || !tr.data.points.length) { mpCtx.clearRect(0, 0, miniProfileCanvas.width, miniProfileCanvas.height); miniProfileBounds = null; return; }
  const pts = tr.data.points;
  miniProfileBounds = { minEle: tr.data.minEle, maxEle: tr.data.maxEle, minDist: pts[0].dist, maxDist: pts[pts.length - 1].dist };

  if (!miniProfileRouteCanvas) { miniProfileRouteCanvas = document.createElement('canvas'); miniProfileRouteCtx = miniProfileRouteCanvas.getContext('2d'); }
  miniProfileRouteCanvas.width = miniProfileCanvas.width; miniProfileRouteCanvas.height = miniProfileCanvas.height;
  const c = miniProfileRouteCtx, w = miniProfileRouteCanvas.width, h = miniProfileRouteCanvas.height;
  const padTop = 4 * window.devicePixelRatio, padBottom = 3 * window.devicePixelRatio;
  const { minEle, maxEle, minDist, maxDist } = miniProfileBounds;
  const eleSpan = (maxEle - minEle) || 1, distSpan = (maxDist - minDist) || 1;
  const px = d => ((d - minDist) / distSpan) * w;
  const py = e => h - padBottom - ((e - minEle) / eleSpan) * (h - padTop - padBottom);

  c.clearRect(0, 0, w, h);
  c.beginPath();
  c.moveTo(px(pts[0].dist), h);
  pts.forEach(p => c.lineTo(px(p.dist), py(p.ele !== null ? p.ele : minEle)));
  c.lineTo(px(pts[pts.length - 1].dist), h);
  c.closePath();
  const grad = c.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,109,0,0.55)'); grad.addColorStop(1, 'rgba(255,109,0,0.08)');
  c.fillStyle = grad; c.fill();
  c.beginPath();
  pts.forEach((p, i) => { const x = px(p.dist), y = py(p.ele !== null ? p.ele : minEle); i === 0 ? c.moveTo(x, y) : c.lineTo(x, y); });
  c.strokeStyle = '#ff6d00'; c.lineWidth = 1.5 * window.devicePixelRatio; c.stroke();

  redrawMiniProfile();
}

function redrawMiniProfile() {
  if (!showMiniProfile || minimapPos === 'off' || !miniProfileBounds || !miniProfileRouteCanvas) return;
  const tr = tracks.find(t => t.id === activeTrackId);
  if (!tr || !tr.data.points.length) return;
  const w = miniProfileCanvas.width, h = miniProfileCanvas.height;
  mpCtx.clearRect(0, 0, w, h);
  mpCtx.drawImage(miniProfileRouteCanvas, 0, 0);

  const pts = tr.data.points;
  let p1, p2, f = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    if (currentRatio >= pts[i].fraction && currentRatio <= pts[i+1].fraction) { p1 = pts[i]; p2 = pts[i+1]; f = (currentRatio - p1.fraction) / (p2.fraction - p1.fraction || 1); break; }
  }
  if (!p1) { p1 = pts[pts.length-1]; p2 = p1; }
  const dist = p1.dist + (p2.dist - p1.dist) * f;
  const { minDist, maxDist } = miniProfileBounds;
  const x = ((dist - minDist) / ((maxDist - minDist) || 1)) * w;
  mpCtx.beginPath(); mpCtx.moveTo(x, 0); mpCtx.lineTo(x, h);
  mpCtx.strokeStyle = '#00aaff'; mpCtx.lineWidth = 2 * window.devicePixelRatio; mpCtx.stroke();
}


// Cinéma & Export Vidéo
const btnCinema = document.getElementById('btnCinema');
const btnCinemaExit = document.getElementById('btnCinemaExit');
let isCinemaMode = false;

function toggleCinemaMode(force = null) {
  isCinemaMode = force !== null ? force : !isCinemaMode;
  document.body.classList.toggle('cinema-mode', isCinemaMode);
  setTimeout(() => { if (map) map.resize(); resizeCanvas(); if (minimapPos !== 'off') { resizeMinimap(); drawMinimapRoute(); } if (showMiniProfile) { resizeMiniProfile(); drawMiniProfileRoute(); } }, 300);
  updateTrackLabels();
  schedulePlaceLabelsRefresh(150);
}
btnCinema.addEventListener('click', () => toggleCinemaMode());
btnCinemaExit.addEventListener('click', () => toggleCinemaMode(false));

const exportModal = document.getElementById('exportModal');
const recordIndicator = document.getElementById('record-indicator');
let isRecording = false, mediaRecorder = null;
let exportCanvas = null, exportCtx = null;

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// captureStream() sur le canvas de la carte ne récupère QUE le rendu WebGL :
// la mini-carte et les stats D+/Pente sont des éléments HTML posés par-dessus
// et n'apparaissaient donc jamais dans la vidéo exportée. On compose ici une
// image finale (carte + mini-carte + stats) sur un canvas séparé, capturé à
// la place — à chaque rendu réel de la carte ('render'), pour rester synchro.
function drawExportFrame() {
  if (!isRecording || !map) return;
  const mc = map.getCanvas();
  // Plafonne la résolution d'export : sur un mobile à haute densité de pixels
  // (DPR 2-3x), le canvas de la carte peut atteindre 1200x2200px ou plus.
  // L'encodage vidéo temps réel (VP9) à cette résolution dépasse largement ce
  // qu'un téléphone peut tenir en continu pendant la phase d'assemblage, et
  // fait perdre silencieusement des frames — d'où une vidéo au final bien
  // moins fluide/nette que prévu, malgré un calcul de frames complet en amont.
  const quality = document.querySelector('input[name="exportQuality"]:checked')?.value || 'standard';
  const qualityMaxDim = ({ standard: 1440, high: 1920, ultra: 1920 })[quality] || 1600;
  const MAX_EXPORT_DIM = qualityMaxDim;
  let targetW = mc.width, targetH = mc.height;
  const longest = Math.max(targetW, targetH);
  if (longest > MAX_EXPORT_DIM) {
    const scale = MAX_EXPORT_DIM / longest;
    targetW = Math.round(targetW * scale);
    targetH = Math.round(targetH * scale);
  }
  if (!exportCanvas) { exportCanvas = document.createElement('canvas'); exportCtx = exportCanvas.getContext('2d'); }
  if (exportCanvas.width !== targetW || exportCanvas.height !== targetH) { exportCanvas.width = targetW; exportCanvas.height = targetH; }
  exportCtx.drawImage(mc, 0, 0, exportCanvas.width, exportCanvas.height);

  const dpr = (window.devicePixelRatio || 1) * (exportCanvas.width / mc.width); // ajuste la taille des éléments UI à la résolution d'export (peut être réduite)

  // Filigrane nom + version, discret, pour identifier la version qui a
  // produit cette vidéo si on la revoit plus tard.
  exportCtx.save();
  exportCtx.font = `${10 * dpr}px -apple-system, sans-serif`;
  exportCtx.fillStyle = 'rgba(0,0,0,0.35)';
  const wmText = document.getElementById('cinema-watermark').textContent;
  const wmPad = 5 * dpr;
  const wmW = exportCtx.measureText(wmText).width + wmPad * 2;
  roundRectPath(exportCtx, 8 * dpr, 8 * dpr, wmW, 16 * dpr, 4 * dpr); exportCtx.fill();
  exportCtx.fillStyle = 'rgba(255,255,255,0.65)'; exportCtx.textBaseline = 'middle'; exportCtx.textAlign = 'left';
  exportCtx.fillText(wmText, 8 * dpr + wmPad, 8 * dpr + 8 * dpr);
  exportCtx.restore();

  const activeTr = tracks.find(t => t.id === activeTrackId);
  if (activeTr) {
    const activity = getTrackActivity(activeTr);
    exportCtx.save();
    exportCtx.font = `600 ${12 * dpr}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const label = `${activity.icon} ${activity.label}`;
    const padX = 8 * dpr, padY = 5 * dpr;
    const bw = exportCtx.measureText(label).width + padX * 2;
    const bx = exportCanvas.width - bw - 10 * dpr;
    const by = 10 * dpr;
    exportCtx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRectPath(exportCtx, bx, by, bw, 22 * dpr, 9 * dpr); exportCtx.fill();
    exportCtx.fillStyle = 'rgba(255,255,255,0.95)';
    exportCtx.textAlign = 'left'; exportCtx.textBaseline = 'middle';
    exportCtx.fillText(label, bx + padX, by + 11 * dpr);
    exportCtx.restore();
  }

  if (minimapPos !== 'off') {
    const w = 150 * dpr, h = 110 * dpr, margin = 12 * dpr;
    const x = minimapPos === 'left' ? margin : exportCanvas.width - w - margin;
    const y = exportCanvas.height - h - margin;
    exportCtx.save();
    exportCtx.fillStyle = 'rgba(30,31,35,0.85)'; exportCtx.strokeStyle = 'rgba(255,255,255,0.25)'; exportCtx.lineWidth = 1;
    roundRectPath(exportCtx, x, y, w, h, 8 * dpr); exportCtx.fill(); exportCtx.stroke();
    exportCtx.clip();
    exportCtx.drawImage(minimapCanvas, x, y, w, h);
    exportCtx.restore();

    if (showMiniProfile && miniProfileBounds) {
      const ph = 52 * dpr, gap = 8 * dpr;
      const py = y - gap - ph;
      exportCtx.save();
      exportCtx.fillStyle = 'rgba(30,31,35,0.85)'; exportCtx.strokeStyle = 'rgba(255,255,255,0.25)'; exportCtx.lineWidth = 1;
      roundRectPath(exportCtx, x, py, w, ph, 8 * dpr); exportCtx.fill(); exportCtx.stroke();
      exportCtx.clip();
      exportCtx.drawImage(miniProfileCanvas, x, py, w, ph);
      exportCtx.restore();
    }
  }

  if (showLiveStats) {
    // Grille 2x3 compacte (comme le badge à l'écran) : Dist/Temps, D+/Pente,
    // Allure/FC.
    const cells = [
      document.getElementById('stDist').textContent, document.getElementById('stTemps').textContent,
      document.getElementById('stDplus').textContent, document.getElementById('stPente').textContent,
      document.getElementById('stAllure').textContent, document.getElementById('stHr').textContent
    ];
    exportCtx.save();
    const fontSize = 13 * dpr;
    exportCtx.font = `600 ${fontSize}px -apple-system, sans-serif`;
    exportCtx.textBaseline = 'middle';
    const padX = 10 * dpr, padY = 6 * dpr, colGap = 10 * dpr, rowH = fontSize + 4 * dpr, margin = 12 * dpr;
    const colW = Math.max(...cells.map(c => exportCtx.measureText(c).width));
    const boxW = padX * 2 + colW * 2 + colGap;
    const boxH = padY * 2 + rowH * 3;
    // Coin opposé à la mini-carte pour ne pas se chevaucher (comme à l'écran)
    const oppositeCorner = minimapPos === 'left' ? 'right' : 'left';
    const bx = oppositeCorner === 'left' ? margin : exportCanvas.width - boxW - margin;
    const by = exportCanvas.height - boxH - margin;
    exportCtx.fillStyle = 'rgba(20,20,20,0.75)';
    roundRectPath(exportCtx, bx, by, boxW, boxH, 8 * dpr); exportCtx.fill();
    exportCtx.fillStyle = '#fff'; exportCtx.textAlign = 'left';
    exportCtx.fillText(cells[0], bx + padX, by + padY + rowH / 2);
    exportCtx.fillText(cells[1], bx + padX + colW + colGap, by + padY + rowH / 2);
    exportCtx.fillText(cells[2], bx + padX, by + padY + rowH + rowH / 2);
    exportCtx.fillText(cells[3], bx + padX + colW + colGap, by + padY + rowH + rowH / 2);
    exportCtx.fillText(cells[4], bx + padX, by + padY + rowH * 2 + rowH / 2);
    exportCtx.fillText(cells[5], bx + padX + colW + colGap, by + padY + rowH * 2 + rowH / 2);
    exportCtx.restore();
  }
}

document.getElementById('btnExportVideoOpen').addEventListener('click', () => {
  if (!activeTrackId) { alert('Charge et sélectionne un tracé d\'abord.'); return; }
  if (isRecording) { stopRecording(); return; }
  exportModal.classList.remove('hidden');
});
document.getElementById('closeExportBtn').addEventListener('click', () => exportModal.classList.add('hidden'));

document.getElementById('startExportBtn').addEventListener('click', () => {
  const mode = document.querySelector('input[name="exportMode"]:checked').value;
  exportModal.classList.add('hidden');
  if (mode === 'cinema' && !isCinemaMode) {
    toggleCinemaMode(true);
    setTimeout(startRecording, 600);
  } else startRecording();
});

document.getElementById('btnStopRecordGlobal').addEventListener('click', stopRecording);
document.getElementById('btnDismissDownloadBanner').addEventListener('click', () => document.getElementById('download-ready-banner').classList.add('hidden'));

// Mesure combien de temps l'appareil met à décoder un JPEG et le dessiner
// sur le canvas d'export — c'est cette étape (pas le calcul de la caméra)
// qui limitait le fps réellement tenable en phase 2 de l'export.
async function benchmarkDecodeCost() {
  try {
    const blob = await new Promise(res => exportCanvas.toBlob(res, 'image/jpeg', 0.88));
    if (!blob) return Infinity;
    const trials = 3;
    let total = 0;
    for (let i = 0; i < trials; i++) {
      const t0 = performance.now();
      const bmp = await createImageBitmap(blob);
      exportCtx.drawImage(bmp, 0, 0, exportCanvas.width, exportCanvas.height);
      bmp.close();
      total += performance.now() - t0;
    }
    return total / trials;
  } catch (e) { return Infinity; } // en cas de doute, on part du principe que c'est lent (repli sûr)
}

// Encode la frame courante en JPEG, avec gestion d'échec (peut arriver sous
// pression mémoire, notamment sur mobile avec un grand canvas).
function captureFrameBlob() {
  return new Promise(res => {
    try { exportCanvas.toBlob(b => res(b || null), 'image/jpeg', 0.96); }
    catch (e) { res(null); }
  });
}

async function startRecording() {
  const activeTr = tracks.find(t => t.id === activeTrackId);
  if (!activeTr || !map) return;

  // Précharge les tuiles 3D/satellite le long du parcours AVANT de démarrer
  // l'enregistrement, pour éviter les gels de plusieurs secondes pendant la
  // capture (visibles dans la vidéo exportée quand la caméra entre dans une
  // zone jamais chargée).
  if (is3DMode) { setStatus('🔄 Préchargement des tuiles avant enregistrement...'); await warmupTiles(activeTr); }
  if (showPlaceLabels) { setStatus('📍 Chargement des noms de lieux...'); await refreshPlaceLabels(); }

  const quality = document.querySelector('input[name="exportQuality"]:checked').value;
  const qualitySettings = {
    standard: { outputFps: 30, bitrate: 6000000, maxDim: 1440, label: 'Standard' },
    high: { outputFps: 30, bitrate: 12000000, maxDim: 1920, label: 'Haute Qualité' },
    ultra: { outputFps: 60, bitrate: 18000000, maxDim: 1920, label: 'Ultra fluide' }
  };
  const exportQuality = qualitySettings[quality] || qualitySettings.standard;
  const outputFps = exportQuality.outputFps; // 30fps par défaut, plus sûr et plus fluide que le faux "haute qualité = 60fps" sur mobile
  const bitrate = exportQuality.bitrate;
  const durationSec = getSelectedAnimationDurationSec(activeTr);

  isRecording = true;
  document.body.classList.add('is-recording');
  document.getElementById('download-ready-banner').classList.add('hidden');
  document.getElementById('recordIndicatorText').textContent = '🔴 Enregistrement en cours...';
  acquireWakeLock();
  recordIndicator.classList.add('active');
  if (!exportCanvas) { exportCanvas = document.createElement('canvas'); exportCtx = exportCanvas.getContext('2d'); }
  drawExportFrame();

  // Le nombre de frames UNIQUES réellement calculées (contentFps) dépend de
  // la vitesse de décodage JPEG de l'appareil, mesurée ici plutôt que
  // supposée : un ordinateur tient généralement du vrai 60fps (60 positions
  // de caméra distinctes par seconde), un mobile souvent pas — décoder plus
  // vite que son budget de 16 ms/frame gonflait la durée réelle de la vidéo
  // (1min de sélection -> 1min46 de rendu). Si l'appareil est trop lent pour
  // le fps choisi, chaque frame calculée est dupliquée en phase 2 pour
  // atteindre quand même le fps de sortie — sans re-décoder, donc sans coût.
  setStatus('🔍 Test de performance de l\'appareil...');
  const avgDecodeMs = await benchmarkDecodeCost();
  const budgetMs = (1000 / outputFps) * 0.55; // marge pour le reste du travail par frame (calcul position, requestFrame...)
  const contentFps = avgDecodeMs <= budgetMs ? outputFps : Math.min(outputFps, 30);
  const repeatPerFrame = Math.round(outputFps / contentFps);
  const totalFrames = Math.max(1, Math.round(durationSec * contentFps));

  currentRatio = 0;
  if (map) { currentCameraZoom = map.getZoom(); currentCameraBearing = map.getBearing(); currentCameraPitch = map.getPitch(); }
  currentSlope = 0; currentZoomMargin = 0;

  // Tout le processus est enveloppé dans un try/finally : si une erreur
  // survient à un moment ou un autre (frame invalide, mémoire...), l'export
  // s'arrête proprement et la vidéo déjà enregistrée est quand même
  // finalisée, au lieu de s'interrompre silencieusement en cours de route
  // (ce qui produisait des vidéos plus courtes que prévu).
  try {
    // PHASE 1 (peut être lente, c'est voulu) : on calcule chaque frame et on
    // la met de côté, en attendant à chaque fois que le relief/les tuiles
    // aient fini de charger. Rien n'est encore enregistré ici — MediaRecorder
    // cale la durée de la vidéo sur le temps réel écoulé PENDANT
    // l'enregistrement, donc tant qu'on n'a pas démarré l'enregistrement,
    // cette phase peut prendre le temps qu'il faut sans jamais rallonger la
    // vidéo finale.
    const frameBlobs = [];
    let skippedCount = 0;
    for (let i = 0; i <= totalFrames && isRecording; i++) {
      currentRatio = i / totalFrames;
      setTrackPositionByRatio(currentRatio);
      await waitForMapSettled(2000);
      drawExportFrame();
      let blob = await captureFrameBlob();
      if (!blob) { blob = await captureFrameBlob(); } // une nouvelle tentative avant d'abandonner la frame
      if (!blob) { skippedCount++; console.error(`Frame ${i}/${totalFrames} ignorée (toBlob a échoué deux fois)`); continue; }
      frameBlobs.push(blob);
      setStatus(`🔄 Calcul de la vidéo… frame ${i}/${totalFrames} (${Math.round((i / totalFrames) * 100)}%)`);
      if (i % 50 === 0) acquireWakeLock(); // renouvelle le verrou périodiquement sur un rendu long, au cas où le navigateur l'aurait relâché silencieusement
    }
    if (skippedCount > 0) console.warn(`Export : ${skippedCount} frame(s) ignorée(s) sur ${totalFrames + 1} calculées (${frameBlobs.length} conservées).`);
    console.log(`Phase 1 terminée : ${frameBlobs.length}/${totalFrames + 1} frames obtenues, dernier ratio=${currentRatio.toFixed(4)}, isRecording=${isRecording}`);
    if (!isRecording || frameBlobs.length === 0) return; // annulé pendant le calcul, ou rien à enregistrer

    // PHASE 2 (rapide, cadence stricte) : on rejoue les frames déjà calculées
    // à intervalle régulier — c'est CETTE phase, et seulement elle, qui
    // détermine la durée de la vidéo finale : elle correspond donc bien à la
    // durée choisie, quel qu'ait été le temps pris par la phase 1.
    const stream = exportCanvas.captureStream(0);
    const videoTrack = stream.getVideoTracks()[0];
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: bitrate });
    } catch(e) {
      mediaRecorder = new MediaRecorder(stream, { videoBitsPerSecond: bitrate });
    }

    const chunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const filename = `${activeTr.name.replace(/\.[^/.]+$/, "")}_3d.webm`;

      // Tentative de téléchargement automatique (fonctionne bien sur la
      // plupart des ordinateurs). Sur mobile, beaucoup de navigateurs
      // bloquent silencieusement un a.click() déclenché hors d'un geste
      // direct de la personne (ce qui est le cas ici, dans ce callback
      // asynchrone) — d'où des comportements différents desktop/mobile.
      try {
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (e) { console.error('Téléchargement automatique impossible :', e); }

      // Solution de repli garantie, quel que soit le navigateur : un vrai
      // lien affiché à l'écran, que la personne tape elle-même. Le compte de
      // frames y est aussi affiché, de façon persistante (pas juste 4s dans
      // la bannière rouge, facile à manquer) — utile pour vérifier si des
      // images ont été perdues en route.
      const frameSummary = `${frameBlobs.length}/${totalFrames + 1} images${skippedCount > 0 ? ` (${skippedCount} ignorée(s))` : ''}`;
      document.getElementById('downloadReadyText').textContent = `✅ Vidéo prête — ${frameSummary}`;
      const dlLink = document.getElementById('downloadReadyLink');
      dlLink.href = url; dlLink.download = filename;
      document.getElementById('download-ready-banner').classList.remove('hidden');
      // L'URL n'est révoquée qu'après un long délai (le temps de taper le
      // lien manuellement si le téléchargement auto a été bloqué), pas
      // immédiatement après le clic auto.
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);

      setStatus(`Export terminé : ${frameSummary}`);
      // Laisse le message final visible quelques secondes avant de rendre la
      // main au mode Cinéma normal (sinon il disparaît instantanément).
      setTimeout(() => document.body.classList.remove('is-recording'), 4000);
    };

    mediaRecorder.start();

    const frameIntervalMs = 1000 / outputFps;
    let nextTime = performance.now();
    for (let i = 0; i < frameBlobs.length && isRecording; i++) {
      let bmp = null;
      try {
        bmp = await createImageBitmap(frameBlobs[i]);
        exportCtx.drawImage(bmp, 0, 0, exportCanvas.width, exportCanvas.height);
      } catch (e) { console.error('Frame ignorée (échec décodage) :', e); } // on garde la cadence même si une frame est illisible
      // Chaque frame décodée est répétée (2x en 60fps) pour atteindre la
      // cadence de sortie sans redécoder — c'est le décodage qui coûtait
      // cher, pas l'affichage répété d'une image déjà en mémoire.
      for (let r = 0; r < repeatPerFrame && isRecording; r++) {
        videoTrack.requestFrame();
        nextTime += frameIntervalMs;
        const delay = nextTime - performance.now();
        if (delay > 0) await new Promise(res => setTimeout(res, delay));
      }
      if (bmp) bmp.close();
      setStatus(`🔴 Assemblage vidéo… frame ${i + 1}/${frameBlobs.length} (${Math.round(((i + 1) / frameBlobs.length) * 100)}%)`);
      if (i % 50 === 0) acquireWakeLock();
    }
    // Laisse l'encodeur digérer la toute dernière frame avant d'arrêter :
    // stopper trop vite après le dernier requestFrame() pouvait tronquer la
    // fin de la vidéo.
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    console.error('Export vidéo interrompu par une erreur :', e);
    setStatus('⚠️ Export interrompu (voir console).');
  } finally {
    stopRecording();
  }
}

// Attend que la carte n'ait plus de tuiles en attente (relief, satellite...)
// avant de considérer une frame "prête", plafonné à maxWaitMs pour ne jamais
// bloquer indéfiniment si une tuile ne charge pas. Si rien n'a besoin de
// charger (cas le plus fréquent grâce au préchargement), on ne perd quasi
// aucun temps : sans ce court-circuit, chaque frame attendrait bêtement le
// délai max même à vide (900 frames × 1,5s = 20+ minutes pour rien).
function waitForMapSettled(maxWaitMs) {
  if (!map) return Promise.resolve();
  return new Promise(resolve => {
    requestAnimationFrame(() => { // laisse jumpTo() déclencher ses requêtes de tuiles avant de vérifier
      if (map.loaded()) { resolve(); return; }
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      map.once('idle', finish);
      setTimeout(finish, maxWaitMs);
    });
  });
}

function stopRecording() {
  const willFireOnStop = mediaRecorder && mediaRecorder.state === 'recording';
  if (willFireOnStop) mediaRecorder.stop();
  pauseTrack();
  isRecording = false;
  releaseWakeLock();
  recordIndicator.classList.remove('active');
  // Si onstop va se déclencher, c'est lui qui retire la classe après avoir
  // affiché le message final ; sinon (annulé avant tout enregistrement), on
  // la retire tout de suite pour ne pas la laisser bloquée.
  if (!willFireOnStop) document.body.classList.remove('is-recording');
}

// Logique GPX & Animation Lissée
const colors = ['#ff1744','#00e5ff','#76ff03','#ffea00','#ff6d00','#d500f9','#f50057','#00e676','#2979ff','#ff3d00'];
let tracks = [], colorIndex = 0, activeTrackId = null;
let isPlaying = false, playAnimationId = null, currentRatio = 0, lastFrameTime = 0;

const canvas = document.getElementById('elevationCanvas');
const ctx = canvas.getContext('2d');
const trackSlider = document.getElementById('trackSlider');
const canvasWrap = document.getElementById('canvas-wrap');

document.getElementById('btnFullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});
document.getElementById('btnMapFocus').addEventListener('click', event => {
  const focused = document.body.classList.toggle('map-focus');
  event.currentTarget.classList.toggle('active', focused);
  event.currentTarget.textContent = focused ? '↕️ Voir le profil' : '↕️ Carte large';
  requestAnimationFrame(() => { map?.resize(); if (!focused) resizeCanvas(); });
});

function resizeCanvas() {
  if (isCinemaMode) return;
  const rect = canvasWrap.getBoundingClientRect();
  if (rect.width === 0) return;
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  drawElevationProfile();
}
window.addEventListener('resize', () => { resizeCanvas(); if(map) map.resize(); });

document.getElementById('fileInput').addEventListener('change', e => { loadFiles([...e.target.files]); e.target.value=''; });
// Glisser-déposer accepté aussi directement sur le panneau "Sorties" — plus
// naturel que de devoir viser la petite zone dédiée sur l'onglet Fichiers.
const sideDropTarget = document.getElementById('side');
sideDropTarget.addEventListener('drop', e => { e.preventDefault(); sideDropTarget.classList.remove('drag'); loadFiles([...e.dataTransfer.files]); });
['dragenter', 'dragover'].forEach(ev => sideDropTarget.addEventListener(ev, e => { e.preventDefault(); sideDropTarget.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => sideDropTarget.addEventListener(ev, e => sideDropTarget.classList.remove('drag')));

function loadFiles(files) {
  files.filter(f => /\.(gpx|fit)$/i.test(f.name)).forEach(file => {
    if (/\.fit$/i.test(file.name)) readFitFile(file);
    else readFile(file);
  });
}
async function readFitFile(file) {
  try {
    setStatus(`Lecture locale du FIT ${file.name}…`);
    const text = fitToGpxBrowser(await file.arrayBuffer(), file.name);
    const track = addGPX(deriveTrackName(file.name, text), text);
    autoRenameTrack(track, text);
    setStatus(`${file.name} chargé localement (FIT d'origine conservé).`);
  } catch (error) {
    console.error('Import FIT impossible :', error);
    setStatus(`Import FIT impossible : ${error.message}`);
  }
}
// Lecteur FIT autonome pour les champs record GPS/altitude/FC/temps. Seules les
// coordonnées sont nécessaires à une trace ; les autres champs sont facultatifs.
function fitToGpxBrowser(buffer, filename) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  if (bytes.length < 14 || String.fromCharCode(...bytes.slice(8, 12)) !== '.FIT')
    throw new Error('fichier FIT invalide');
  const headerSize = view.getUint8(0), dataSize = view.getUint32(4, true);
  const end = headerSize + dataSize;
  if (headerSize < 12 || end > bytes.length || dataSize > 50_000_000)
    throw new Error('fichier FIT incomplet ou trop volumineux');
  const definitions = new Array(16), records = [];
  let offset = headerSize, lastTime = null, sport = null;
  function value(at, size, type, little) {
    const base = type & 31;
    if (size === 1) {
      if (base === 1) { const n = view.getInt8(at); return n === 127 ? null : n; }
      const n = view.getUint8(at); return n === (base === 10 ? 0 : 255) ? null : n;
    }
    if (size === 2 && [3, 4, 11].includes(base)) {
      const n = base === 3 ? view.getInt16(at, little) : view.getUint16(at, little);
      return n === (base === 3 ? 32767 : base === 11 ? 0 : 65535) ? null : n;
    }
    if (size === 4 && [5, 6, 12].includes(base)) {
      const n = base === 5 ? view.getInt32(at, little) : view.getUint32(at, little);
      return n === (base === 5 ? 2147483647 : base === 12 ? 0 : 4294967295) ? null : n;
    }
    return null;
  }
  while (offset < end) {
    const header = view.getUint8(offset++);
    const compressed = !!(header & 0x80);
    const local = compressed ? (header >> 5) & 3 : header & 15;
    if (!compressed && (header & 0x40)) {
      if (offset + 5 > end) throw new Error('définition FIT tronquée');
      offset++; const little = view.getUint8(offset++) === 0;
      const global = view.getUint16(offset, little); offset += 2;
      const count = view.getUint8(offset++), fields = [];
      if (offset + count * 3 > end) throw new Error('définition FIT tronquée');
      for (let i = 0; i < count; i++) {
        fields.push({number:bytes[offset++], size:bytes[offset++], type:bytes[offset++]});
      }
      if (header & 0x20) {
        if (offset >= end) throw new Error('définition FIT tronquée');
        const developerCount = bytes[offset++];
        if (offset + developerCount * 3 > end) throw new Error('définition FIT tronquée');
        for (let i = 0; i < developerCount; i++) fields.push({number:-1,size:bytes[offset + 1 + i * 3],type:0});
        offset += developerCount * 3;
      }
      definitions[local] = {global, little, fields};
      continue;
    }
    const definition = definitions[local];
    if (!definition) throw new Error('message FIT sans définition');
    const fields = {};
    for (const field of definition.fields) {
      if (offset + field.size > end) throw new Error('enregistrement FIT tronqué');
      if ((definition.global === 20 || definition.global === 18) && field.number >= 0)
        fields[field.number] = value(offset, field.size, field.type, definition.little);
      offset += field.size;
    }
    if (definition.global === 18 && fields[5] != null)
      sport = fields[5] === 1 ? 'running' : fields[5] === 2 ? 'cycling' : sport;
    if (definition.global !== 20) continue;
    let timestamp = fields[253];
    if (compressed && timestamp == null && lastTime != null) {
      timestamp = (lastTime & ~31) + (header & 31);
      if (timestamp < lastTime) timestamp += 32;
    }
    if (timestamp != null) lastTime = timestamp;
    const lat = fields[0], lon = fields[1];
    if (lat == null || lon == null) continue;
    const latitude = lat * 180 / 2147483648, longitude = lon * 180 / 2147483648;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const alt = fields[78] != null ? fields[78] : fields[2];
    records.push({latitude, longitude, elevation:alt == null ? null : alt / 5 - 500,
      timestamp, hr:fields[3]});
    if (records.length > 100000) throw new Error('trace FIT trop longue');
  }
  if (records.length < 2) throw new Error('ce FIT ne contient pas de trace GPS exploitable');
  const name = filename.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
  const points = records.map(p => `<trkpt lat="${p.latitude}" lon="${p.longitude}">` +
    (p.elevation == null ? '' : `<ele>${p.elevation}</ele>`) +
    (p.timestamp == null ? '' : `<time>${new Date(631065600000 + p.timestamp * 1000).toISOString()}</time>`) +
    (p.hr == null ? '' : `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`) +
    '</trkpt>').join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="GPX Compare" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>${name}</name>${sport ? `<type>${sport}</type>` : ''}<trkseg>${points}</trkseg></trk></gpx>`;
}
function readFile(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const t = addGPX(deriveTrackName(file.name, r.result), r.result);
      setStatus(file.name + ' chargé.');
      autoRenameTrack(t, r.result); // renomme en arrière-plan une fois date/lieu/sport résolus (réseau)
    } catch (error) {
      console.error('Import GPX impossible :', error);
      setStatus('Import impossible : ' + error.message);
    }
  };
  r.onerror = () => setStatus('Import impossible : lecture du fichier échouée.');
  r.readAsText(file, 'UTF-8');
}

// Les GPX exportés (Strava, etc.) embarquent souvent un vrai titre d'activité
// dans <trk><name> ou <metadata><name>, bien plus lisible que le nom de
// fichier auto-généré (ex: "export_19862333608.gpx"). On le préfère quand il
// existe ; sinon on nettoie un minimum le nom de fichier en repli. Ce nom
// sert de repli immédiat, avant que autoRenameTrack() ne le remplace par le
// format date-lieu-sport une fois le géocodage terminé.
function deriveTrackName(filename, gpxText) {
  try {
    const xml = new DOMParser().parseFromString(gpxText, 'application/xml');
    const trkName = xml.querySelector('trk > name, metadata > name, gpx > name');
    if (trkName && trkName.textContent.trim()) return trkName.textContent.trim();
  } catch (e) { /* pas grave, on retombe sur le nom de fichier */ }
  return filename.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim() || filename;
}

const SPORT_LABELS = {
  running: 'Course', run: 'Course', trail_running: 'Trail', trail: 'Trail',
  cycling: 'Vélo', biking: 'Vélo', road_biking: 'Vélo', bike: 'Vélo', virtual_ride: 'Vélo',
  mountain_biking: 'VTT', mtb: 'VTT', gravel: 'Gravel',
  hiking: 'Rando', hike: 'Rando', walking: 'Marche', walk: 'Marche',
  swimming: 'Natation', swim: 'Natation', ski: 'Ski', skiing: 'Ski', nordic_ski: 'Ski de fond',
  rowing: 'Aviron', kayaking: 'Kayak', canoeing: 'Canoë'
};

function extractSportLabel(gpxText) {
  try {
    const xml = new DOMParser().parseFromString(gpxText, 'application/xml');
    const typeEl = xml.querySelector('trk > type');
    if (typeEl && typeEl.textContent.trim()) {
      const raw = typeEl.textContent.trim();
      const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
      return SPORT_LABELS[key] || raw;
    }
  } catch (e) { /* pas grave */ }
  return null;
}

function normalizeActivityToken(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractRawSportType(gpxText) {
  try {
    const xml = new DOMParser().parseFromString(gpxText, 'application/xml');
    const typeEl = xml.querySelector('trk > type');
    if (typeEl && typeEl.textContent.trim()) return normalizeActivityToken(typeEl.textContent.trim());
  } catch (e) { /* pas grave */ }
  return '';
}

function guessActivityKind(name, gpxText, trackData = null) {
  const title = normalizeActivityToken(name);
  const rawType = extractRawSportType(gpxText);
  const merged = `${rawType}_${title}`;
  const climbingRatio = trackData && trackData.totalDist > 0 ? (trackData.totalDplus / trackData.totalDist) : 0; // m/km
  if (/(cycling|biking|bike|velo|cycl|ride|road_biking|gravel|mtb|vtt)/.test(merged)) {
    return { kind: 'road-bike', icon: '🚴', label: 'Vélo' };
  }
  if (/(trail_running|trail|skyrun|sentier|montagn|nature_run|course_nature)/.test(merged) || climbingRatio >= 35) {
    return { kind: 'trail-run', icon: '🏔️', label: 'Trail' };
  }
  if (/(running|run|course|footing|jog)/.test(merged)) {
    return { kind: 'road-run', icon: '🏃', label: 'Course' };
  }
  return { kind: 'other', icon: '📍', label: extractSportLabel(gpxText) || 'Sortie' };
}

function getTrackActivity(t) {
  return t?.activity || { kind: 'other', icon: '📍', label: 'Sortie' };
}

function applyActivityUI(t) {
  const activity = getTrackActivity(t);
  const icon = activity.icon || '📍';
  const label = activity.label || 'Sortie';
  const activeIconEl = document.getElementById('active-track-icon');
  const cinemaIconEl = document.getElementById('cinema-activity-icon');
  if (activeIconEl) { activeIconEl.textContent = icon; activeIconEl.title = label; }
  if (cinemaIconEl) { cinemaIconEl.textContent = icon; cinemaIconEl.title = label; }
}

const animDurationSelect = document.getElementById('animDurationSelect');
const speedFactorWrap = document.getElementById('speedFactorWrap');
const speedFactorRange = document.getElementById('speedFactorRange');
const speedFactorValue = document.getElementById('speedFactorValue');
const animDurationHint = document.getElementById('animDurationHint');

function formatVideoDurationShort(sec) {
  sec = Math.max(1, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m <= 0) return `${s} s`;
  if (s === 0) return `${m} min`;
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

function getAutoDurationConfig(track) {
  const activity = getTrackActivity(track);
  let kmPerMinute = 10;
  if (activity.kind === 'road-bike') kmPerMinute = 20;
  else if (activity.kind === 'trail-run') kmPerMinute = 8;
  else if (activity.kind === 'road-run') kmPerMinute = 10;
  const timeMinutes = track?.data?.totalElapsedSec ? (track.data.totalElapsedSec / 3600) : 0; // 1h réelle = 1min vidéo
  const distanceMinutes = track?.data?.totalDist ? (track.data.totalDist / kmPerMinute) : 0;
  const baseMinutes = Math.max(timeMinutes, distanceMinutes, 0.25);
  const factor = parseFloat(speedFactorRange?.value || '1') || 1;
  const rawSec = baseMinutes * 60 * factor;
  const durationSec = Math.max(15, Math.min(300, Math.round(rawSec)));
  return { durationSec, factor, kmPerMinute, timeMinutes, distanceMinutes, activity };
}

function getSelectedAnimationDurationSec(track = null) {
  const value = animDurationSelect?.value || '30';
  if (value === 'auto') {
    const tr = track || tracks.find(t => t.id === activeTrackId);
    return getAutoDurationConfig(tr).durationSec;
  }
  const manual = parseFloat(value);
  return Number.isFinite(manual) && manual > 0 ? manual : 30;
}

function updateAnimationDurationUI() {
  if (speedFactorValue) speedFactorValue.textContent = (parseFloat(speedFactorRange?.value || '1') || 1).toFixed(1);
  const autoMode = animDurationSelect?.value === 'auto';
  if (speedFactorWrap) speedFactorWrap.style.opacity = autoMode ? '1' : '0.55';
  const tr = tracks.find(t => t.id === activeTrackId);
  if (!animDurationHint) return;
  if (!tr) { animDurationHint.textContent = autoMode ? 'Auto : charge une sortie pour calculer la durée.' : 'Durée manuelle.'; return; }
  if (!autoMode) { animDurationHint.textContent = `Durée manuelle : ${formatVideoDurationShort(getSelectedAnimationDurationSec(tr))}.`; return; }
  const cfg = getAutoDurationConfig(tr);
  const timeTxt = tr.data.totalElapsedSec ? `temps ${formatDuration(tr.data.totalElapsedSec)} → ${formatVideoDurationShort(cfg.timeMinutes * 60)}` : 'temps indisponible';
  const distTxt = `${tr.data.totalDist.toFixed(1)} km → ${formatVideoDurationShort(cfg.distanceMinutes * 60)}`;
  const baseTxt = cfg.timeMinutes >= cfg.distanceMinutes ? 'temps' : 'distance';
  animDurationHint.textContent = `Auto ${cfg.activity.icon} : max(${timeTxt}, ${distTxt}) = ${formatVideoDurationShort(Math.max(cfg.timeMinutes, cfg.distanceMinutes) * 60)} · facteur ×${cfg.factor.toFixed(1)} → ${formatVideoDurationShort(cfg.durationSec)}.`;
}

animDurationSelect?.addEventListener('change', updateAnimationDurationUI);
speedFactorRange?.addEventListener('input', updateAnimationDurationUI);

function extractFirstDate(gpxText) {
  try {
    const xml = new DOMParser().parseFromString(gpxText, 'application/xml');
    const timeEl = xml.querySelector('metadata > time, trkpt time, time');
    if (timeEl && timeEl.textContent.trim()) {
      const d = new Date(timeEl.textContent.trim());
      if (!isNaN(d)) return d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
  } catch (e) { /* pas grave */ }
  return null;
}

// Géocodage inverse : MapTiler si une clé est configurée (plus fiable, déjà
// utilisée pour les fonds de carte), sinon repli gratuit sur Nominatim/OSM.
async function reverseGeocodeLieu(lat, lon) {
  try {
    if (MAPTILER_KEY) {
      const res = await fetch(`https://api.maptiler.com/geocoding/${lon},${lat}.json?key=${MAPTILER_KEY}&language=fr&types=municipality,village,town,city`);
      if (res.ok) {
        const data = await res.json();
        const f = data.features && data.features[0];
        if (f && f.text) return f.text;
      }
    }
  } catch (e) { /* on retombe sur Nominatim */ }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&accept-language=fr`);
    if (res.ok) {
      const data = await res.json();
      const a = data.address || {};
      return a.village || a.town || a.city || a.municipality || a.suburb || a.county || null;
    }
  } catch (e) { /* pas de réseau / hors-ligne : on garde le nom de repli */ }
  return null;
}

// Renomme au format "date - lieu - sport" une fois les infos disponibles.
// N'écrase le nom de repli que si on obtient au moins une info exploitable
// (pas de réseau ou géocodage en échec -> le nom d'origine est conservé).
async function autoRenameTrack(t, gpxText) {
  const firstPt = t.rawPoints[0];
  if (!firstPt) return;
  const date = extractFirstDate(gpxText);
  const sport = extractSportLabel(gpxText) || 'Sortie';
  const lieu = await reverseGeocodeLieu(firstPt.lat, firstPt.lon);
  const parts = [date, lieu, sport].filter(Boolean);
  if (parts.length < 2) return; // ni date ni lieu trouvés : pas assez d'infos, on garde le nom existant
  t.name = parts.join(' - ');
  t.activity = guessActivityKind(t.name, gpxText, t.data);
  if (t.id === activeTrackId) {
    document.getElementById('active-track-name').textContent = t.name;
    applyActivityUI(t);
    updateAnimationDurationUI();
  }
  sortAndRenderTracks();
}

function parseGPX(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  // Une seule traversée : chercher un enfant dans TOUT le document pour
  // chaque point rendait l'import de longs parcours quadratique.
  const points = [...xml.getElementsByTagName('*')].filter(p => p.localName === 'trkpt' || p.localName === 'rtept');
  return points.map(p => {
    let ele = null, time = null;
    for (const child of p.children) {
      if (child.localName === 'ele') ele = child;
      else if (child.localName === 'time') time = child;
    }
    // Rythme cardiaque : extension standard des montres (Garmin TrackPointExtension
    // et variantes), balise <hr> quel que soit le préfixe de namespace utilisé.
    let hr = null;
    try {
      const hrEl = [...p.getElementsByTagName('*')].find(x => x.localName === 'hr');
      if (hrEl) { const v = parseInt(hrEl.textContent, 10); if (!isNaN(v)) hr = v; }
    } catch (e) { /* pas de FC sur ce point, pas grave */ }
    return { lat: parseFloat(p.getAttribute('lat')), lon: parseFloat(p.getAttribute('lon')), ele: ele ? parseFloat(ele.textContent) : null, time: time ? new Date(time.textContent).getTime() : null, hr };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
}

function calculateTrackData(points) {
  let cumDist = 0, cumDplus = 0, minEle = Infinity, maxEle = -Infinity, hasEle = false, hasHr = false, trackPts = [], lastEle = points[0]?.ele;
  const hasTime = points.length > 0 && points[0].time && points[points.length-1].time;
  const startT = hasTime ? points[0].time : 0, totalT = hasTime ? points[points.length-1].time - startT : 0;
  
  points.forEach((pt, i) => {
    if (i > 0) cumDist += haversine(points[i-1].lat, points[i-1].lon, pt.lat, pt.lon);
    if (pt.ele !== null && !isNaN(pt.ele)) {
      hasEle = true; if (pt.ele < minEle) minEle = pt.ele; if (pt.ele > maxEle) maxEle = pt.ele;
      if (lastEle !== null) {
        const diff = pt.ele - lastEle;
        // On ne déplace la référence que si l'écart dépasse le seuil de bruit
        // (montée OU descente) ; sinon on la laisse en place pour que les
        // petits écarts successifs (montée progressive) finissent par
        // s'additionner au lieu d'être effacés à chaque point.
        if (diff >= ELE_THRESHOLD) { cumDplus += diff; lastEle = pt.ele; }
        else if (diff <= -ELE_THRESHOLD) { lastEle = pt.ele; }
      } else { lastEle = pt.ele; }
    }
    if (pt.hr !== null && pt.hr !== undefined && !isNaN(pt.hr)) hasHr = true;
    trackPts.push({ lat: pt.lat, lon: pt.lon, ele: pt.ele, hr: (pt.hr !== null && pt.hr !== undefined) ? pt.hr : null, dist: cumDist / 1000, cumDplus, elapsedSec: hasTime ? (pt.time - startT) / 1000 : null, fraction: (hasTime && totalT > 0) ? (pt.time - startT)/totalT : cumDist });
  });
  if (!hasTime && cumDist > 0) trackPts.forEach(p => p.fraction /= cumDist);
  return { points: trackPts, totalDist: cumDist / 1000, totalDplus: cumDplus, totalElapsedSec: hasTime ? totalT / 1000 : null, minEle: hasEle ? minEle : 0, maxEle: hasEle ? maxEle : 0, hasElevation: hasEle, hasHr };
}

function addGPX(name, text, deferRecenter = false) {
  const rawPoints = parseGPX(text);
  if (rawPoints.length < 2) throw new Error('ce fichier ne contient pas de trace GPX exploitable');
  // Diagnostic FC : si rien n'a été extrait, on regarde si le fichier brut
  // contient quand même des balises qui ressemblent à du rythme cardiaque —
  // ça permet de savoir si c'est un vrai bug d'extraction (balises présentes
  // mais mal reconnues) ou si le fichier n'en contient simplement pas.
  const hrCount = rawPoints.filter(p => p.hr !== null).length;
  if (hrCount === 0) {
    const hrLikeTags = [...new Set((text.match(/<[a-zA-Z0-9_:]*hr[a-zA-Z0-9_:]*[ >]/gi) || []).map(s => s.trim().replace(/[<>]/g, '')))];
    if (hrLikeTags.length) {
      console.warn('FC : aucune valeur extraite, mais des balises ressemblant à du HR existent dans ce fichier :', hrLikeTags);
      setStatus(`⚠️ FC présente dans le fichier mais non reconnue (balise : ${hrLikeTags[0]}) — signale-le`);
    } else {
      console.log('FC : aucune balise de rythme cardiaque trouvée dans ce GPX.');
    }
  } else {
    console.log(`FC détectée sur ${hrCount}/${rawPoints.length} points de "${name}".`);
  }
  const trackData = calculateTrackData(rawPoints);
  const t = { id: 't-' + Math.random(), name, color: colors[colorIndex++ % colors.length], visible: true, rawPoints, trimStart: 0, trimEnd: 0, data: trackData, activity: guessActivityKind(name, text, trackData) };
  tracks.push(t);
  renderTrackOnMap(t); sortAndRenderTracks();
  if (!activeTrackId) setActiveTrack(t.id); else drawElevationProfile();
  if (!deferRecenter) fitAll();
  return t;
}

// Retire une portion (en %) du début et/ou de la fin de la trace brute — utile
// quand l'enregistrement a démarré avant de bouger ou s'est arrêté en retard.
// Recalcule les stats (distance, D+...) et met à jour tout ce qui dépend du
// tracé (ligne sur la carte, mini-carte, profil, position du curseur).
function applyTrim(t) {
  const n = t.rawPoints.length;
  const startIdx = Math.floor(n * (t.trimStart / 100));
  const endIdx = Math.ceil(n * (1 - t.trimEnd / 100));
  const sliced = t.rawPoints.slice(startIdx, Math.max(startIdx + 2, endIdx));
  t.data = calculateTrackData(sliced);
  if (map && map.getSource(t.id)) {
    map.getSource(t.id).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.data.points.map(p => [p.lon, p.lat]) } });
  }
  if (t.id === activeTrackId) {
    document.getElementById('active-track-stats').textContent = `${t.data.totalDist.toFixed(1)} km · +${Math.round(t.data.totalDplus)}m`;
    updateAnimationDurationUI();
    currentRatio = 0;
    // Resynchronise la caméra sur l'état réel de la carte avant de la
    // recentrer : sinon, tant que la sortie n'a jamais été jouée une fois
    // (playTrack ne l'a donc jamais fait), ces variables gardent le zoom
    // d'AVANT le premier fitAll() et le rognage semble "dézoomer" la carte.
    if (map) { currentCameraZoom = map.getZoom(); currentCameraBearing = map.getBearing(); currentCameraPitch = map.getPitch(); }
    drawMinimapRoute(); drawMiniProfileRoute(); setTrackPositionByRatio(0);
    updateTrackLabels(); // stats recalculées après rognage
  } else {
    sortAndRenderTracks();
  }
}

function updateTrimInfo(t) {
  const el = document.getElementById('trimInfo');
  if ((t.trimStart || 0) === 0 && (t.trimEnd || 0) === 0) { el.textContent = ''; return; }
  el.textContent = `${t.data.totalDist.toFixed(1)} km (rogné)`;
}

const trimStartSlider = document.getElementById('trimStartSlider');
const trimEndSlider = document.getElementById('trimEndSlider');
const trimStartValue = document.getElementById('trimStartValue');
const trimEndValue = document.getElementById('trimEndValue');
function onTrimChange(e) {
  const tr = tracks.find(t => t.id === activeTrackId); if (!tr) return;
  let s = parseInt(trimStartSlider.value, 10), en = parseInt(trimEndSlider.value, 10);
  if (s + en > 90) { // garde au moins 10% de la trace
    if (e.target === trimStartSlider) en = Math.max(0, 90 - s); else s = Math.max(0, 90 - en);
    trimStartSlider.value = s; trimEndSlider.value = en;
  }
  trimStartValue.textContent = s + '%'; trimEndValue.textContent = en + '%';
  tr.trimStart = s; tr.trimEnd = en;
  applyTrim(tr);
  updateTrimInfo(tr);
}
trimStartSlider.addEventListener('input', onTrimChange);
trimEndSlider.addEventListener('input', onTrimChange);

document.getElementById('btnTrimReset').addEventListener('click', () => {
  const tr = tracks.find(t => t.id === activeTrackId); if (!tr) return;
  trimStartSlider.value = 0; trimEndSlider.value = 0;
  trimStartValue.textContent = '0%'; trimEndValue.textContent = '0%';
  tr.trimStart = 0; tr.trimEnd = 0;
  applyTrim(tr);
  updateTrimInfo(tr);
});

const btnTrimToggle = document.getElementById('btnTrimToggle');
const trimControlsPanel = document.getElementById('trim-controls');
btnTrimToggle.addEventListener('click', () => {
  const nowOpen = trimControlsPanel.classList.toggle('hidden') === false;
  btnTrimToggle.classList.toggle('active', nowOpen);
});

// Recale l'altitude (souvent imprécise : capteur de pression barométrique de
// la montre, dérive avec la météo) sur le relief réel de la carte (tuiles
// DEM MapTiler), point par point. Nécessite une clé MapTiler (le relief 3D).
const btnRecalibrateEle = document.getElementById('btnRecalibrateEle');
btnRecalibrateEle.addEventListener('click', () => {
  if (!activeTrackId) { alert('Sélectionne d\'abord une sortie.'); return; }
  if (!MAPTILER_KEY) { pendingAction = 'recalibrate'; keyModal.classList.remove('hidden'); return; }
  recalibrateElevation();
});

async function recalibrateElevation() {
  const tr = tracks.find(t => t.id === activeTrackId);
  if (!tr || !map) return;
  const wasTerrainOn = is3DMode;
  btnRecalibrateEle.disabled = true;
  try {
    setStatus('⛰️ Préparation du relief...');
    apply3DTerrain();
    await warmupTiles(tr); // charge les tuiles DEM le long du parcours, au bon niveau de zoom
    await new Promise(r => { if (map.loaded()) r(); else map.once('idle', r); });

    setStatus('⛰️ Recalage de l\'altitude en cours...');
    // On ne remplace PAS l'altitude par celle du relief (DEM) : le DEM est
    // plus lisse qu'un baromètre et efface les petites variations réelles du
    // terrain (marches, ressauts, murets...), ce qui sous-estimait le D+.
    // On calcule plutôt un biais (DEM - altitude d'origine), lissé sur une
    // fenêtre glissante, et on l'applique en correction : ça corrige la
    // dérive progressive (météo, capteur) tout en gardant les vraies petites
    // variations du profil GPS d'origine.
    const BIAS_WINDOW = 25; // points de part et d'autre pour lisser le biais
    const rawEles = tr.rawPoints.map(p => p.ele);
    const demEles = tr.rawPoints.map(p => {
      const e = map.queryTerrainElevation([p.lon, p.lat]);
      return (e !== null && e !== undefined && isFinite(e)) ? e : null;
    });
    const biasRaw = demEles.map((d, i) => (d !== null && rawEles[i] !== null && isFinite(rawEles[i])) ? d - rawEles[i] : null);
    const biasSmoothed = biasRaw.map((_, i) => {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - BIAS_WINDOW); j <= Math.min(biasRaw.length - 1, i + BIAS_WINDOW); j++) {
        if (biasRaw[j] !== null) { sum += biasRaw[j]; count++; }
      }
      return count > 0 ? sum / count : null;
    });
    let corrected = 0, missing = 0;
    tr.rawPoints = tr.rawPoints.map((p, i) => {
      if (biasSmoothed[i] === null || p.ele === null || !isFinite(p.ele)) { missing++; return p; }
      corrected++;
      return { ...p, ele: p.ele + biasSmoothed[i] };
    });
    applyTrim(tr); // recalcule data/D+/profil/mini-carte en tenant compte du rognage déjà en place

    if (!wasTerrainOn) map.setTerrain(null); // ne laisse le relief 3D actif que si l'utilisateur l'avait déjà activé
    setStatus(`⛰️ Altitude recalée sur ${corrected} points${missing ? ` (${missing} hors couverture, conservés tels quels)` : ''}.`);
  } catch (e) {
    console.error('Recalage altitude échoué :', e);
    setStatus('⚠️ Recalage altitude impossible (voir console).');
  } finally {
    btnRecalibrateEle.disabled = false;
  }
}

function renderTrackOnMap(t) {
  if (!map) return;
  if (!map.getSource(t.id)) {
    map.addSource(t.id, { 'type': 'geojson', 'data': { 'type': 'Feature', 'geometry': { 'type': 'LineString', 'coordinates': t.data.points.map(p => [p.lon, p.lat]) } } });
    // Couche invisible plus large sous la ligne visible : zone de clic plus
    // confortable (5px de ligne, c'est très étroit à viser à la souris/au doigt).
    // Visibilité fixée dès la création (layout), pas dans un setLayoutProperty
    // séparé juste après : sur certains changements de fond de carte, un
    // réglage posé "juste après" un addLayer pouvait être ignoré si le style
    // n'était pas encore tout à fait stabilisé, laissant la trace invisible
    // jusqu'à un désaffiche/réaffiche manuel.
    const vis = t.visible ? 'visible' : 'none';
    map.addLayer({ 'id': t.id + '-hit', 'type': 'line', 'source': t.id, 'layout': { 'visibility': vis }, 'paint': { 'line-color': '#000', 'line-width': 20, 'line-opacity': 0.01 } });
    map.addLayer({ 'id': t.id, 'type': 'line', 'source': t.id, 'layout': { 'visibility': vis }, 'paint': { 'line-color': t.color, 'line-width': 5, 'line-opacity': 0.85 } });
    map.on('click', t.id + '-hit', () => setActiveTrack(t.id));
    map.on('mouseenter', t.id + '-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', t.id + '-hit', () => { map.getCanvas().style.cursor = ''; });
  }
  map.setLayoutProperty(t.id, 'visibility', t.visible ? 'visible' : 'none');
  map.setLayoutProperty(t.id + '-hit', 'visibility', t.visible ? 'visible' : 'none');
  initTrackerLayer();
}
function restoreTracksOnMap() { tracks.forEach(renderTrackOnMap); }

function setActiveTrack(id) {
  activeTrackId = id; const tr = tracks.find(t => t.id === id); if (!tr) return;
  pauseTrack(); currentRatio = 0; trackSlider.disabled = false;
  currentCameraBearing = map ? map.getBearing() : 0;
  currentCameraZoom = map ? map.getZoom() : 14;
  currentCameraPitch = map ? map.getPitch() : (is3DMode ? 60 : 0);
  currentSlope = 0; currentZoomMargin = 0;
  document.getElementById('active-track-name').textContent = tr.name;
  applyActivityUI(tr);
  document.getElementById('active-track-stats').textContent = `${tr.data.totalDist.toFixed(1)} km · +${Math.round(tr.data.totalDplus)}m`;
  updateAnimationDurationUI();
  document.getElementById('trimStartSlider').value = tr.trimStart || 0;
  document.getElementById('trimEndSlider').value = tr.trimEnd || 0;
  document.getElementById('trimStartValue').textContent = (tr.trimStart || 0) + '%';
  document.getElementById('trimEndValue').textContent = (tr.trimEnd || 0) + '%';
  updateTrimInfo(tr);
  updateAnimationDurationUI();
  sortAndRenderTracks(); drawElevationProfile(); drawMinimapRoute(); drawMiniProfileRoute(); setTrackPositionByRatio(0);
}

function drawElevationProfile() {
  if (isCinemaMode || canvas.width === 0) return;
  const w = canvas.width, h = canvas.height; ctx.clearRect(0, 0, w, h);
  const tr = tracks.find(t => t.id === activeTrackId);
  if (!tr || !tr.data.hasElevation || !tr.data.points.length) return;
  const pts = tr.data.points, min = tr.data.minEle, span = (tr.data.maxEle - min) || 50;
  const pad = 15 * window.devicePixelRatio, pw = w - pad * 2, ph = h - pad * 2;
  
  ctx.beginPath(); ctx.moveTo(pad, h - pad);
  pts.forEach(p => ctx.lineTo(pad + p.fraction * pw, h - pad - (((p.ele !== null ? p.ele : min) - min) / span) * ph));
  ctx.lineTo(pad + pw, h - pad); ctx.closePath();
  ctx.fillStyle = tr.color + "44"; ctx.fill(); ctx.strokeStyle = tr.color; ctx.lineWidth = 2 * window.devicePixelRatio; ctx.stroke();

  const cx = pad + currentRatio * pw;
  ctx.beginPath(); ctx.moveTo(cx, pad); ctx.lineTo(cx, h - pad); ctx.strokeStyle = "#fff"; ctx.setLineDash([3,3]); ctx.stroke(); ctx.setLineDash([]);
}

let isPointerDown = false;
canvasWrap.addEventListener('pointerdown', e => { isPointerDown = true; updateScrub(e); });
canvasWrap.addEventListener('pointermove', e => { if(isPointerDown) updateScrub(e); });
window.addEventListener('pointerup', () => isPointerDown = false);
function updateScrub(e) {
  const rect = canvasWrap.getBoundingClientRect();
  setTrackPositionByRatio(Math.max(0, Math.min(1, (e.clientX - rect.left - 15) / (rect.width - 30))));
}
trackSlider.addEventListener('input', e => setTrackPositionByRatio(parseFloat(e.target.value)));

function setTrackPositionByRatio(ratio) {
  const tr = tracks.find(t => t.id === activeTrackId); if (!tr || !tr.data.points.length) return;
  currentRatio = Math.max(0, Math.min(1, ratio)); const pts = tr.data.points;
  let p1, p2, f = 0, idx = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    if (currentRatio >= pts[i].fraction && currentRatio <= pts[i+1].fraction) {
      p1 = pts[i]; p2 = pts[i+1]; f = (currentRatio - p1.fraction) / (p2.fraction - p1.fraction || 1); idx = i; break;
    }
  }
  if (!p1) { p1 = pts[pts.length-1]; p2 = p1; idx = pts.length - 1; }

  const lon = p1.lon + (p2.lon - p1.lon) * f, lat = p1.lat + (p2.lat - p1.lat) * f;
  const ele = p1.ele !== null ? p1.ele + (p2.ele - p1.ele) * f : null;
  const dist = p1.dist + (p2.dist - p1.dist) * f;
  const dplus = p1.cumDplus + (p2.cumDplus - p1.cumDplus) * f;

  // Pente lissée (lerp) sur le segment courant : l'altitude GPS point à point
  // est bruitée, un lissage évite une valeur (et un pitch caméra) qui saute
  // sans arrêt. Calculée systématiquement (pas juste si affichée) car la
  // caméra en a besoin pour s'ajuster en pente forte.
  const distDeltaM = (p2.dist - p1.dist) * 1000;
  const rawSlope = (distDeltaM > 0.5 && p1.ele !== null && p2.ele !== null) ? ((p2.ele - p1.ele) / distDeltaM) * 100 : currentSlope;
  currentSlope = lerp(currentSlope, isFinite(rawSlope) ? rawSlope : 0, SMOOTHING_FACTOR * 3);

  if (map) {
    if (map.getSource('tracker-source')) map.getSource('tracker-source').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] } });
    
    const camMode = document.getElementById('camModeSelect').value;
    if (camMode !== 'off') {
      let targetBearing = map.getBearing();
      if (camMode === 'fixed') targetBearing = 0;
      else {
        // Cap calculé sur une fenêtre "lookahead" (~20 m) plutôt qu'entre deux
        // points GPS adjacents : deux points très proches donnent un cap très
        // bruité (le moindre écart GPS fait varier l'angle de plusieurs dizaines
        // de degrés d'une frame à l'autre), ce qui faisait vibrer/saccader la
        // caméra, surtout en mode Seuil.
        let rawB = getLookaheadBearing(pts, idx, p1.dist);
        if (isNaN(rawB)) rawB = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);
        if (!isNaN(rawB)) {
          if (camMode === 'threshold') {
            // Ne réagit que si l'écart dépasse le seuil, et rejoint alors le
            // cap cible progressivement (lerp) au lieu de sauter dessus d'un
            // coup en une seule frame — c'était la source des à-coups.
            // Vitesse de rattrapage alignée sur le lissage normal (au lieu
            // de 1.5x plus rapide) : ça restait trop brusque au ressenti.
            let diff = (2 * ((rawB - currentCameraBearing) % 360)) % 360 - ((rawB - currentCameraBearing) % 360);
            if (Math.abs(diff) > 25) currentCameraBearing = lerpAngle(currentCameraBearing, rawB, SMOOTHING_FACTOR);
            targetBearing = currentCameraBearing;
          } else {
            currentCameraBearing = lerpAngle(currentCameraBearing, rawB, SMOOTHING_FACTOR);
            targetBearing = currentCameraBearing;
          }
        }
      }
      
      // Amorti du zoom / altitude de la caméra pour éviter les sauts brusques.
      // On retire de la lecture la marge de dézoom qu'on avait appliquée à la
      // frame précédente (currentZoomMargin) : sinon ce dézoom de secours se
      // relit lui-même comme "le vrai zoom" et s'accumule sans fin tout du
      // long d'une pente soutenue, au lieu de rester plafonné à ~1,3 niveau
      // (c'était le dézoom exagéré observé sur les longues descentes).
      let targetZoom = map.getZoom() + currentZoomMargin;
      currentCameraZoom = lerp(currentCameraZoom, targetZoom, SMOOTHING_FACTOR);

      // En pente marquée (montée ou descente), le relief qui se dresse devant
      // la caméra pousse le point vers le haut du cadre, jusqu'à le faire
      // sortir. Effet nettement réduit et adouci par rapport aux essais
      // précédents (marge de zoom et réduction de pitch divisées par ~2, et
      // lissées plus lentement) : ça restait trop marqué/saccadé au ressenti.
      const basePitch = is3DMode ? 60 : 0;
      let targetPitch = basePitch, targetZoomMargin = 0;
      if (is3DMode) {
        const absSlope = Math.abs(currentSlope);
        const t = Math.min(1, Math.max(0, (absSlope - 12) / 22)); // 0 sous 12%, effet plein dès 34%
        targetPitch = basePitch - t * 18; // jusqu'à 60° -> 42°
        targetZoomMargin = t * 0.6; // dézoome jusqu'à ~0.6 niveau, jamais plus
      }
      currentCameraPitch = lerp(currentCameraPitch, targetPitch, SMOOTHING_FACTOR * 0.7);
      currentZoomMargin = lerp(currentZoomMargin, targetZoomMargin, SMOOTHING_FACTOR * 0.4);

      map.jumpTo({ center: [lon, lat], zoom: currentCameraZoom - currentZoomMargin, pitch: currentCameraPitch, bearing: targetBearing });
    }
  }

  trackSlider.value = currentRatio;
  document.getElementById('stDist').textContent = dist.toFixed(1) + ' km'; document.getElementById('c-dist').textContent = dist.toFixed(1) + ' km';
  document.getElementById('stAlt').textContent = ele !== null ? Math.round(ele) + ' m' : '-- m'; document.getElementById('c-alt').textContent = ele !== null ? Math.round(ele) + ' m' : '-- m';
  document.getElementById('stProg').textContent = Math.round(currentRatio * 100) + '%';

  if (showLiveStats) {
    const dplusTxt = Math.round(dplus) + ' m';
    const penteTxt = (currentSlope >= 0 ? '+' : '') + currentSlope.toFixed(1) + '%';
    const distTxt = dist.toFixed(1) + ' km';
    let tempsTxt = '--:--', elapsedForPace = null;
    if (p1.elapsedSec !== null && p2.elapsedSec !== null) {
      elapsedForPace = p1.elapsedSec + (p2.elapsedSec - p1.elapsedSec) * f;
      tempsTxt = formatDuration(elapsedForPace);
    }
    const recentPace = computeRecentPace(pts, elapsedForPace, dist);
    const allureTxt = recentPace ? formatPace(recentPace.elapsedSec, recentPace.distKm) : formatPace(elapsedForPace, dist);
    let hrTxt = '-- bpm';
    if (p1.hr !== null && p2.hr !== null) hrTxt = Math.round(p1.hr + (p2.hr - p1.hr) * f) + ' bpm';
    else if (p1.hr !== null) hrTxt = Math.round(p1.hr) + ' bpm'; // dernier point avec FC connue (capteur intermittent)
    document.getElementById('stDplus').textContent = dplusTxt; document.getElementById('c-dplus2').textContent = dplusTxt;
    document.getElementById('stPente').textContent = penteTxt; document.getElementById('c-pente2').textContent = penteTxt;
    document.getElementById('stTemps').textContent = tempsTxt; document.getElementById('c-temps2').textContent = tempsTxt;
    document.getElementById('stAllure').textContent = allureTxt; document.getElementById('c-allure2').textContent = allureTxt;
    document.getElementById('stHr').textContent = hrTxt; document.getElementById('c-hr2').textContent = hrTxt;
    document.getElementById('c-dist2').textContent = distTxt;
  }

  redrawMinimap();
  redrawMiniProfile();
  drawElevationProfile();
}

function playStep(ts) {
  if (!isPlaying) return;
  if (!lastFrameTime) lastFrameTime = ts;
  currentRatio += ((ts - lastFrameTime) / 1000) / getSelectedAnimationDurationSec(tracks.find(t => t.id === activeTrackId));
  lastFrameTime = ts;
  if (currentRatio >= 1) { setTrackPositionByRatio(1); pauseTrack(); return; }
  setTrackPositionByRatio(currentRatio);
  playAnimationId = requestAnimationFrame(playStep);
}

let warmedTrackId = null, warmedStyleKey = null;
async function warmupTiles(tr) {
  if (!map || !tr || !tr.data.points.length) return;
  const styleKey = document.getElementById('mapStyleSelect').value;
  if (warmedTrackId === tr.id && warmedStyleKey === styleKey) return; // déjà préchargé pour ce couple trace/fond
  const pts = tr.data.points;
  // Un point de survol tous les ~150 m plutôt qu'un nombre fixe de points :
  // sur un long parcours, 12 points fixes laissaient de grandes zones jamais
  // survolées à l'avance, donc des tuiles de relief (DEM) pas encore chargées
  // pendant le vol réel — c'est ce qui fait "sauter" le point bleu (la caméra
  // se cale sur une hypothèse d'altitude fausse tant que la tuile n'est pas là).
  const steps = Math.max(10, Math.min(60, Math.round(tr.data.totalDist / 0.15)));
  const saved = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  const flightZoom = Math.max(currentCameraZoom, 14);
  try {
    for (let s = 0; s <= steps; s++) {
      const p = pts[Math.floor((pts.length - 1) * (s / steps))];
      map.jumpTo({ center: [p.lon, p.lat], zoom: flightZoom, pitch: 60 });
      await new Promise(r => setTimeout(r, 70));
    }
    await Promise.race([
      new Promise(r => { if (map.loaded()) r(); else map.once('idle', r); }),
      new Promise(r => setTimeout(r, 5000)) // garde-fou si 'idle' ne se déclenche pas
    ]);
  } finally {
    map.jumpTo({ center: saved.center, zoom: saved.zoom, bearing: saved.bearing, pitch: saved.pitch });
    warmedTrackId = tr.id; warmedStyleKey = styleKey;
  }
}

// Empêche l'écran de se mettre en veille pendant la lecture ou l'export
// vidéo (sinon Android coupe l'écran en plein milieu d'un enregistrement).
let wakeLock = null;
async function acquireWakeLock() {
  startNoSleepFallback(); // solution de secours, cumulée dans tous les cas (inoffensif si l'API native marche aussi)
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { console.warn('Wake Lock natif refusé, on repose sur la solution de secours :', e); }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  stopNoSleepFallback();
}
// Le wake lock est automatiquement relâché par le navigateur quand l'onglet
// perd le focus ; on le redemande au retour si la lecture est toujours en cours.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (isPlaying || isRecording)) acquireWakeLock();
});

// Solution de secours anti-veille : certains navigateurs (Brave sur Android
// notamment) sont connus pour restreindre l'API Wake Lock native, qui échoue
// alors silencieusement. Astuce classique et largement compatible : une
// courte vidéo muette générée localement (pas de fichier externe, juste un
// canvas capturé en flux), lue en boucle — la plupart des navigateurs mobiles
// n'éteignent pas l'écran tant qu'une vidéo est activement en lecture.
let noSleepVideo = null;
function ensureNoSleepVideo() {
  if (noSleepVideo) return noSleepVideo;
  const canvas = document.createElement('canvas');
  canvas.width = 2; canvas.height = 2;
  canvas.getContext('2d').fillRect(0, 0, 2, 2);
  const stream = canvas.captureStream(1);
  const video = document.createElement('video');
  video.muted = true; video.loop = true; video.playsInline = true;
  video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;right:0;';
  video.srcObject = stream;
  document.body.appendChild(video);
  noSleepVideo = video;
  return video;
}
function startNoSleepFallback() { ensureNoSleepVideo().play().catch(() => {}); }
function stopNoSleepFallback() { if (noSleepVideo) noSleepVideo.pause(); }

async function playTrack() {
  if (currentRatio >= 1) currentRatio = 0;
  const tr = tracks.find(t => t.id === activeTrackId);
  if (tr && is3DMode) { setStatus('🔄 Préchargement des tuiles 3D...'); await warmupTiles(tr); setStatus(''); }
  // Repart de la position caméra actuelle (zoom/orientation) au lieu de
  // l'ancienne valeur figée lors de la sélection de la trace : évite le
  // saut de zoom au lancement si tu as zoomé/dézoomé entre-temps.
  if (map) { currentCameraZoom = map.getZoom(); currentCameraBearing = map.getBearing(); }
  isPlaying = true; lastFrameTime = 0;
  acquireWakeLock();
  updateTrackLabels(); // masque les étiquettes pendant la lecture
  document.getElementById('btnPlay').textContent = '⏸'; document.getElementById('btnPlay').classList.add('active');
  document.getElementById('btnCinemaPlay').textContent = '⏸ Pause';
  playAnimationId = requestAnimationFrame(playStep);
}
function pauseTrack() {
  isPlaying = false;
  if (!isRecording) releaseWakeLock();
  document.getElementById('btnPlay').textContent = '▶'; document.getElementById('btnPlay').classList.remove('active');
  document.getElementById('btnCinemaPlay').textContent = '▶ Jouer';
  if (playAnimationId) cancelAnimationFrame(playAnimationId);
  updateTrackLabels(); // réaffiche les étiquettes une fois la lecture arrêtée
  // Retire la marge caméra (ajoutée en 3D pendant la lecture) pour ne pas
  // fausser un recentrage/zoom manuel une fois la lecture arrêtée.
  if (map && !isRecording) map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 300 });
}
document.getElementById('btnPlay').onclick = () => isPlaying ? pauseTrack() : playTrack();
document.getElementById('btnCinemaPlay').onclick = () => isPlaying ? pauseTrack() : playTrack();

function sortAndRenderTracks() {
  const m = document.getElementById('sortSelect').value;
  if (m === 'name') tracks.sort((a,b) => a.name.localeCompare(b.name));
  else if (m === 'dist') tracks.sort((a,b) => b.data.totalDist - a.data.totalDist);
  else if (m === 'dplus') tracks.sort((a,b) => b.data.totalDplus - a.data.totalDplus);

  const container = document.getElementById('tracks');
  container.innerHTML = '';
  if (!tracks.length) { container.innerHTML = '<div class="empty">Aucun GPX/FIT chargé.</div>'; updateTrackLabels(); refreshPlaceLabels(); return; }

  tracks.forEach(t => {
    const div = document.createElement('div');
    div.className = 'track' + (t.visible ? '' : ' hidden') + (t.id === activeTrackId ? ' active-track' : '');
    const activity = getTrackActivity(t);
    div.innerHTML = `<span class="swatch" style="background:${t.color}"></span><div class="track-main"><div class="track-name-line"><span class="track-icon" title="${activity.label}" aria-hidden="true">${activity.icon}</span><div class="track-name">${t.name}</div></div><div class="track-info">${t.data.totalDist.toFixed(1)} km</div></div><div class="track-actions"><button class="tg">👁️</button><button class="del">✕</button></div>`;
    div.querySelector('.tg').onclick = (e) => { e.stopPropagation(); t.visible = !t.visible; renderTrackOnMap(t); sortAndRenderTracks(); schedulePlaceLabelsRefresh(100); };
    div.querySelector('.del').onclick = (e) => { e.stopPropagation(); if(map){if(map.getLayer(t.id))map.removeLayer(t.id);if(map.getLayer(t.id+'-hit'))map.removeLayer(t.id+'-hit');if(map.getSource(t.id))map.removeSource(t.id);} tracks = tracks.filter(x => x.id !== t.id); if(activeTrackId === t.id) activeTrackId = tracks[0]?.id || null; if(activeTrackId) setActiveTrack(activeTrackId); else { document.getElementById('active-track-name').textContent = 'Aucune sortie active'; document.getElementById('active-track-stats').textContent = ''; applyActivityUI(null); } sortAndRenderTracks(); fitAll(); schedulePlaceLabelsRefresh(100); };
    // Double-clic pour renommer manuellement (utile si le lieu détecté
    // automatiquement au chargement ne convient pas).
    div.querySelector('.track-name').ondblclick = (e) => {
      e.stopPropagation();
      const newName = prompt('Renommer la sortie :', t.name);
      if (newName && newName.trim()) {
        t.name = newName.trim();
        t.activity = guessActivityKind(t.name, '', t.data);
        if (t.id === activeTrackId) {
          document.getElementById('active-track-name').textContent = t.name;
          applyActivityUI(t);
          updateAnimationDurationUI();
        }
        sortAndRenderTracks();
      }
    };
    div.onclick = (e) => { if(e.target.tagName !== 'BUTTON') setActiveTrack(t.id); };
    container.appendChild(div);
  });
  updateTrackLabels();
  schedulePlaceLabelsRefresh(150);
}

// Étiquettes "lieu + stats" affichées directement sur la carte, en vue
// d'ensemble (plusieurs sorties visibles) — masquées pendant la lecture ou
// en mode Cinéma pour ne pas encombrer l'écran.
let trackLabelMarkers = [];
function clearTrackLabels() { trackLabelMarkers.forEach(m => m.remove()); trackLabelMarkers = []; }

function extractLieu(name) {
  const parts = name.split(' - ');
  if (parts.length === 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) return parts[1];
  return name;
}

function updateTrackLabels() {
  clearTrackLabels();
  if (!map) return;
  const visibleTracks = tracks.filter(t => t.visible);
  if (visibleTracks.length < 2 || isPlaying || isCinemaMode) return;

  // Regroupe les sorties par lieu (extrait de "date - lieu - sport") pour
  // cumuler leurs stats en une seule étiquette au lieu d'en empiler plusieurs
  // au même endroit.
  const groups = new Map(); // clé normalisée -> { label, tracks: [] }
  visibleTracks.forEach(t => {
    const lieu = extractLieu(t.name);
    const key = lieu.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { label: lieu, tracks: [] });
    groups.get(key).tracks.push(t);
  });

  groups.forEach(({ label, tracks: groupTracks }) => {
    const pts = groupTracks[0].data.points;
    if (!pts.length) return;
    const mid = pts[Math.floor(pts.length / 2)]; // point réel du tracé, pas un centroïde qui pourrait tomber hors parcours
    const totalDist = groupTracks.reduce((s, t) => s + t.data.totalDist, 0);
    const totalDplus = groupTracks.reduce((s, t) => s + t.data.totalDplus, 0);
    const totalTemps = groupTracks.every(t => t.data.totalElapsedSec !== null)
      ? groupTracks.reduce((s, t) => s + t.data.totalElapsedSec, 0) : null;
    const countTxt = groupTracks.length > 1 ? ` ×${groupTracks.length}` : '';
    const distTxt = totalDist.toFixed(1) + ' km';
    const dplusTxt = '+' + Math.round(totalDplus) + ' m';
    const tempsTxt = totalTemps !== null ? formatDuration(totalTemps) : null;
    const el = document.createElement('div');
    el.className = 'track-label';
    el.innerHTML = `<div class="track-label-place">${label}${countTxt}</div><div class="track-label-stats">${distTxt} · ${dplusTxt}${tempsTxt ? ' · ' + tempsTxt : ''}</div>`;
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([mid.lon, mid.lat]).addTo(map);
    trackLabelMarkers.push(marker);
  });
}

function fitAll() {
  if (!map || !tracks.filter(t => t.visible).length) return;
  const b = new maplibregl.LngLatBounds();
  tracks.filter(t => t.visible).forEach(t => t.data.points.forEach(p => b.extend([p.lon, p.lat])));
  map.fitBounds(b, { padding: 40, pitch: is3DMode ? 40 : 0 });
  schedulePlaceLabelsRefresh(400);
}
document.getElementById('fitBtn').onclick = fitAll;
document.getElementById('clearBtn').onclick = () => {
  tracks.forEach(t => { if(map){if(map.getLayer(t.id))map.removeLayer(t.id);if(map.getLayer(t.id+'-hit'))map.removeLayer(t.id+'-hit');if(map.getSource(t.id))map.removeSource(t.id);} });
  tracks = []; activeTrackId = null; sortAndRenderTracks(); drawElevationProfile();
  updateAnimationDurationUI();
  document.getElementById('active-track-name').textContent = 'Aucune sortie active';
  document.getElementById('active-track-stats').textContent = '';
  applyActivityUI(null);
  refreshPlaceLabels();
};

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2));
}
function getLookaheadBearing(pts, idx, curDistKm) {
  const LOOKAHEAD_KM = 0.02; // 20 m : assez pour lisser le bruit GPS, assez peu pour rester réactif
  const targetDist = curDistKm + LOOKAHEAD_KM;
  let j = idx;
  while (j < pts.length - 1 && pts[j].dist < targetDist) j++;
  const a = pts[idx], b = pts[j];
  if (!a || !b || a === b) return NaN;
  return calculateBearing(a.lat, a.lon, b.lat, b.lon);
}
function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}
// Allure moyenne jusqu'ici (min/km), pas l'allure instantanée
function formatPace(elapsedSec, distKm) {
  if (!distKm || distKm <= 0 || elapsedSec === null) return '--\'--';
  // On arrondit le total en secondes AVANT de séparer minutes/secondes :
  // arrondir minutes et secondes séparément pouvait produire des valeurs
  // invalides du type "5'60/km" (59,6s arrondi à 60 sans repasser à la
  // minute suivante).
  const totalSec = Math.round(elapsedSec / distKm);
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return `${m}'${String(s).padStart(2,'0')}/km`;
}
// Allure "glissante" sur les ~60 dernières secondes plutôt que la moyenne
// depuis le départ : plus représentative du rythme du moment (une moyenne
// cumulée peut sembler "fausse" si l'allure a beaucoup varié en route).
// Retombe sur la moyenne depuis le départ tant qu'il n'y a pas 60s de recul.
function computeRecentPace(pts, curElapsed, curDist) {
  if (curElapsed === null) return null;
  const WINDOW_SEC = 60;
  const targetElapsed = curElapsed - WINDOW_SEC;
  if (targetElapsed <= 0) return null;
  let refPt = pts[0];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].elapsedSec !== null && pts[i].elapsedSec <= targetElapsed) refPt = pts[i]; else break;
  }
  const deltaElapsed = curElapsed - refPt.elapsedSec, deltaDist = curDist - refPt.dist;
  return (deltaElapsed > 0 && deltaDist > 0) ? { elapsedSec: deltaElapsed, distKm: deltaDist } : null;
}
function calculateBearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2-lon1)*Math.PI/180)*Math.cos(lat2*Math.PI/180);
  const x = Math.cos(lat1*Math.PI/180)*Math.sin(lat2*Math.PI/180) - Math.sin(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.cos((lon2-lon1)*Math.PI/180);
  return (Math.atan2(y, x)*180/Math.PI + 360) % 360;
}
function setStatus(s) {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = s;
  // Pendant un export, le message de progression s'affiche directement dans
  // la bannière rouge déjà visible (plutôt que dans #status, invisible en
  // mode Cinéma et qui finissait par se superposer à cette même bannière).
  if (isRecording) {
    const ri = document.getElementById('recordIndicatorText');
    if (ri) ri.textContent = s;
  }
}

updateAnimationDurationUI();
initMap();
resizeCanvas();
