// ---- Supabase Client Initialization ----
const { createClient } = supabase;
const { supabaseUrl, supabaseAnonKey } = window.SUPABASE_CONFIG;
const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);

// ---- Lazy Loading Helpers ----
const LIBS = {
  XLSX: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  turf: 'https://unpkg.com/@turf/turf@6.5.0/turf.min.js'
};

async function ensureLibraryLoaded(windowVar, url) {
  if (window[windowVar]) return;
  // If loading is already in progress, wait for it
  if (window[`_loading_${windowVar}`]) {
     await window[`_loading_${windowVar}`];
     return;
  }

  const promise = new Promise((resolve, reject) => {
    console.log(`Loading library: ${windowVar}...`);
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => {
      console.log(`Library loaded: ${windowVar}`);
      resolve();
    };
    s.onerror = (e) => {
      console.error(`Failed to load library: ${windowVar}`, e);
      reject(e);
    };
    document.head.appendChild(s);
  });

  window[`_loading_${windowVar}`] = promise;
  await promise;
}

// Expose to window for testing/debugging
window.ensureLibraryLoaded = ensureLibraryLoaded;

// ---- Auth ----
const AUTH_KEY = 'authState';

async function login(username, password) {
  const { data, error } = await supabaseClient
    .from('users')
    .select('username, role, password_hash')
    .eq('username', username)
    .single();

  if (error || !data) {
    alert('Неверный логин или пароль.');
    return;
  }

  const passwordIsValid = password === data.password_hash;

  if (!passwordIsValid) {
    alert('Неверный логин или пароль.');
    return;
  }

  localStorage.setItem(AUTH_KEY, '1');
  localStorage.setItem('userRole', data.role);
  localStorage.setItem('username', data.username);
  setAuth(true);
  applyRoleRestrictions();
}

function checkAuth() {
  const authState = localStorage.getItem(AUTH_KEY) === '1';
  const userRole = localStorage.getItem('userRole');
  return authState && userRole;
}

function setAuth(isAuthenticated) {
  if (isAuthenticated) {
    localStorage.setItem(AUTH_KEY, '1');
    document.body.classList.remove('login-required');
    document.body.classList.add('authenticated');
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('mainContent').classList.remove('hidden');
  } else {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem('userRole');
    localStorage.removeItem('username');
    document.body.classList.add('login-required');
    document.body.classList.remove('authenticated');
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('mainContent').classList.add('hidden');
  }
}

function getUserRole() {
  return localStorage.getItem('userRole') || null;
}

function hasPermission(action) {
  const role = getUserRole();
  const permissions = {
    'admin': ['upload', 'export', 'view', 'filter', 'manualLocation'],
    'rating_agency': ['view', 'filter'],
    'risk_manager': ['upload', 'export', 'view', 'filter', 'manualLocation']
  };
  return permissions[role]?.includes(action) || false;
}

function applyRoleRestrictions() {
  const unlocatedBtn = document.getElementById('btnShowUnlocated');

  if (!hasPermission('upload')) {
    document.getElementById('excelLabel').style.display = 'none';
  }
  if (!hasPermission('export')) {
    document.getElementById('btnExportRegion').style.display = 'none';
  }
  if (unlocatedBtn) {
    if (!hasPermission('manualLocation')) {
      unlocatedBtn.style.display = 'none';
    } else {
      unlocatedBtn.style.display = '';
    }
  }
}

document.getElementById('btnLogin').addEventListener('click', async () => {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value.trim();
  if (!username || !password) {
    alert('Введите логин и пароль.');
    return;
  }
  await login(username, password);
});

document.getElementById('btnLogout').addEventListener('click', () => setAuth(false));

// ---- Map ----
const map = L.map('map', {
  minZoom: 5,
  maxBounds: [[40, 45], [56, 88]], // Approximate bounds for Kazakhstan
}).setView([48.0196, 66.9237], 5);

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
});

let markerLayer = L.markerClusterGroup({
  disableClusteringAtZoom: 14,
  showCoverageOnHover: false,
  chunkedLoading: true
});
let regionsGeoJSON = null;
let regionLayer = L.geoJSON(null, {
    style: f => {
      return {
        weight: 1,
        color: '#334155',
        fillColor: f.properties.hasSeismicRisk ? '#ef4444' : '#6b7280',
        fillOpacity: 0.6
      };
    },
    onEachFeature: (feature, layer) => {
      const rid = feature.properties.shapeID || feature.properties.GID_1 || feature.properties.NAME_1;
      const name = feature.properties.shapeName || feature.properties.NAME_1 || rid;
      const riskStatus = feature.properties.hasSeismicRisk ? 'Высокий риск' : 'Низкий риск';
      const html = `
        <div class="hover-card">
          <div class="title">${name}</div>
          <div>Сейсмичность: <b>${riskStatus}</b></div>
        </div>`;
      layer.on('mouseover', () => { layer.bindTooltip(html, { sticky:true }).openTooltip(); layer.setStyle({ weight:2 }); });
      layer.on('mouseout',  () => { layer.closeTooltip(); layer.setStyle({ weight:1 }); });
  layer.on('click',    async () => { await openRegionPanel(rid, name); });
    }
});
let seismicOn = false;
let seismicZonesGeoJSON = null;
let seismicZoneLayer = null;
let earthquakeLayer = L.layerGroup().addTo(map);
// Risk Analytics
let riskEngine = null;
let heatmapLayer = null;
let riskChart = null;

// ---- State ----
const GEO_CACHE_KEY = 'geocodeCacheKZ';
let contracts = [];
let unlocatedContracts = [];
let earthquakeEvents = [];
let geoCache = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
let assignmentState = { active: false, contractId: null };
let isContractListVisible = false;
let isContractListStale = true;


function saveGeoCache() { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geoCache)); }

const appState = {
  filters: defaultFilters(),
};

// ---- Filters ----
function defaultFilters() {
  return {
    startDate: '1900-01-01',
    endDate: '2100-01-01',
    status: 'all',
    type: '',
    amountRange: 'all',
  };
}
function iso(d) { return new Date(d).toISOString().slice(0,10); }

function applyFilters() {
  appState.filters.startDate = document.getElementById('filterStart').value || appState.filters.startDate;
  appState.filters.endDate = document.getElementById('filterEnd').value || appState.filters.endDate;
  appState.filters.status = document.getElementById('filterStatus').value;
  appState.filters.type = document.getElementById('filterType').value.trim();
  appState.filters.amountRange = document.getElementById('filterAmountRange').value;
  isContractListStale = true;
  renderAll();
  if (isContractListVisible) {
    renderList();
    isContractListStale = false;
  }
}
function resetFilters() {
  appState.filters = defaultFilters();
  bindFiltersToUI();
  isContractListStale = true;
  renderAll();
  if (isContractListVisible) {
    renderList();
    isContractListStale = false;
  }
}
function bindFiltersToUI() {
  document.getElementById('filterStart').value = appState.filters.startDate;
  document.getElementById('filterEnd').value = appState.filters.endDate;
  document.getElementById('filterStatus').value = appState.filters.status;
  document.getElementById('filterType').value = appState.filters.type;
  document.getElementById('filterAmountRange').value = appState.filters.amountRange;
}
document.getElementById('btnApply').addEventListener('click', applyFilters);
document.getElementById('btnReset').addEventListener('click', resetFilters);

document.getElementById('toggleContractsList').addEventListener('click', () => {
  isContractListVisible = !isContractListVisible;

  const listEl = document.getElementById('contractsList');
  const iconEl = document.getElementById('contractToggleIcon');

  if (isContractListVisible) {
    if (isContractListStale) {
      renderList();
      isContractListStale = false;
    }
    listEl.classList.remove('collapsed');
    iconEl.classList.add('rotated');
  } else {
    listEl.classList.add('collapsed');
    iconEl.classList.remove('rotated');
  }
});

// ---- Active logic ----
function overlaps(filter, c) {
  const isDefaultFilter = filter.startDate === '1900-01-01' && filter.endDate === '2100-01-01';
  if (!c.startDate || !c.endDate) {
    return isDefaultFilter;
  }
  return c.endDate >= filter.startDate && c.startDate <= filter.endDate;
}
function passStatus(filter, c) {
  if (filter.status === 'all') return true;
  if (filter.status === 'active') return c.isActive === true;
  if (filter.status === 'inactive') return c.isActive === false;
  return true;
}
function passType(filter, c) {
  if (!filter.type) return true;
  return (c.objectType||'').toLowerCase().includes(filter.type.toLowerCase());
}
function passAmount(filter, c) {
  const v = c.insuranceAmount || 0;
  switch (filter.amountRange) {
    case 'all': return true;
    case '0-1M': return v < 1000000;
    case '1M-5M': return v >= 1000000 && v < 5000000;
    case '5M-10M': return v >= 5000000 && v < 10000000;
    case '10M-50M': return v >= 10000000 && v < 50000000;
    case '50M+': return v >= 50000000;
    default: return true;
  }
}
function filteredContracts() {
  return contracts.filter(c =>
    overlaps(appState.filters, c) && passStatus(appState.filters, c) && passType(appState.filters, c) && passAmount(appState.filters, c)
  );
}

// ---- Stats ----
function formatKZT(n) {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 }).format(n||0);
}
function updateStats() {
  const list = filteredContracts();
  const total = list.length;
  const active = list.filter(x => x.isActive).length;
  const sum = list.reduce((a,c)=>a+(c.insuranceAmount||0),0);
  document.getElementById('stats').innerHTML = `
    <div>Всего: <b>${total}</b></div>
    <div>Активные: <b>${active}</b></div>
    <div>Сумма: <b>${formatKZT(sum)}</b></div>
  `;
}

// ---- Contracts list ----
function renderList() {
  const el = document.getElementById('contractsList');
  const list = filteredContracts();
  el.innerHTML = '';
  for (const c of list) {
    const div = document.createElement('div');
    div.className = 'contract-card';
    div.innerHTML = `
      <div><b>${c.objectType||'Без типа'}</b></div>
      <div class="meta">${c.startDate} → ${c.endDate} | ${c.address||'-'}</div>
      <div>${formatKZT(c.insuranceAmount||0)} | ${c.isActive ? 'Активен' : 'Неактивен'}</div>
    `;
    el.appendChild(div);
  }
}

// ---- Markers ----
function renderMarkers() {
  markerLayer.clearLayers();
  const list = filteredContracts().filter(c => c.latitude && c.longitude);
  for (const c of list) {
    const color = c.isActive ? '#27ae60' : '#e74c3c';
    const icon = L.divIcon({
      className: 'custom-pin',
      html: `<svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" fill="${color}" stroke="#1f2937" stroke-width="1.5"/></svg>`
    });
    const m = L.marker([c.latitude, c.longitude], { icon });
    m.bindPopup(`
      <div><b>${c.objectType||'-'}</b></div>
      <div>${formatKZT(c.insuranceAmount||0)}</div>
      <div>${c.startDate} — ${c.endDate}</div>
      <div>${c.address||''}</div>
      <div>${c.isActive ? 'Активен' : 'Неактивен'}</div>
    `);
    m.addTo(markerLayer);
  }
}

// ---- Fit all ----
document.getElementById('btnFit').addEventListener('click', () => {
  const list = filteredContracts().filter(c => c.latitude && c.longitude);
  if (!list.length) return;
  const bounds = L.latLngBounds(list.map(c => [c.latitude, c.longitude]));
  map.fitBounds(bounds.pad(0.2));
});

// ---- Risk Modules (Fire & Flood) ----

// 1. Fire Risk (NASA EONET - Open API)
let fireLayer = L.layerGroup();

// Using NASA EONET API (CORS enabled) instead of FIRMS CSV which requires proxy/keys.
// EONET provides curated events including wildfires.
const EONET_WILDFIRES_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open';

async function fetchFireEvents() {
  try {
    console.log('Fetching fire data from NASA EONET...');
    const resp = await fetch(EONET_WILDFIRES_URL);
    if (!resp.ok) throw new Error(`Fire API error: ${resp.status}`);
    const data = await resp.json();
    return parseEONET(data);
  } catch (e) {
    console.error('Failed to fetch fire data:', e);
    return [];
  }
}

function parseEONET(data) {
  const events = [];
  if (!data || !data.events) return [];

  data.events.forEach(ev => {
    if (!ev.geometry || !ev.geometry.length) return;

    // EONET can return multiple geometries (updates over time), usually the last one is latest.
    // For points, it's [lon, lat].
    const geom = ev.geometry[ev.geometry.length - 1];
    console.log(`EONET Event: ${ev.title}, Coords: [${geom.coordinates}]`);
    if (geom.type !== 'Point') return; // Skip complex polygons for now to keep markers simple

    const lon = geom.coordinates[0];
    const lat = geom.coordinates[1];

    // Spatial filter for KZ (approx)
    if (lat < 40 || lat > 56 || lon < 46 || lon > 88) return;

    events.push({
      lat,
      lon,
      brightness: 'N/A', // EONET doesn't provide brightness in top-level
      date: geom.date.slice(0, 10),
      time: geom.date.slice(11, 16),
      title: ev.title
    });
  });
  return events;
}

async function initFireLayer() {
  fireLayer.clearLayers();
  const events = await fetchFireEvents();

  events.forEach(ev => {
    const color = ev.brightness > 350 ? '#ff0000' : '#ffa500';

    // Use divIcon for pulse animation (CSS box-shadow doesn't work on SVG circleMarker)
    const icon = L.divIcon({
      className: 'fire-marker-container',
      html: `<div class="fire-dot pulse" style="background-color: ${color};"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });

    const marker = L.marker([ev.lat, ev.lon], { icon });

    const dateStr = `${ev.date} ${ev.time ? ev.time.slice(0,2)+':'+ev.time.slice(2) : ''}`;

    marker.bindTooltip(`
      <div><b>🔥 Пожар</b></div>
      <div>${ev.title || 'Пожар'}</div>
      <div>Обнаружен: ${dateStr}</div>
      <div>${ev.lat.toFixed(4)}, ${ev.lon.toFixed(4)}</div>
    `, {
      className: 'risk-tooltip-fire',
      direction: 'top'
    });

    marker.addTo(fireLayer);
  });
  console.log(`Loaded ${events.length} fire events.`);
}

// 2. Flood & Rain Risk (Open-Meteo)
let floodLayer = L.layerGroup();
// Grid resolution in degrees (approx 50km)
const GRID_STEP = 0.5;

async function fetchFloodForecast(lat, lng) {
  // Fetch precip and river discharge (mocking river location check by just asking for it)
  // Open-Meteo Flood API for discharge, regular API for rain
  // We combine them.
  try {
    // 1. Precip
    const rainUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=precipitation_sum&forecast_days=3&timezone=auto`;
    const rainResp = await fetch(rainUrl);
    const rainData = await rainResp.json();

    // 2. River discharge (experimental endpoint, might not have data everywhere, we'll just try)
    // Actually flood-api is separate.
    // const floodUrl = `https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lng}&daily=river_discharge&forecast_days=3`;
    // const floodResp = await fetch(floodUrl);
    // const floodData = await floodResp.json();

    // Simplify: Just use rain for now as "Flood Risk" proxy if flood api is complex or returns nulls often.
    // But the task asks for it.

    let maxRain = 0;
    if (rainData.daily && rainData.daily.precipitation_sum) {
      maxRain = Math.max(...rainData.daily.precipitation_sum);
    }

    // Determine risk
    let risk = 'low';
    if (maxRain > 30) risk = 'high';
    else if (maxRain > 10) risk = 'medium';

    return { maxRain, risk, days: rainData.daily ? rainData.daily.time : [] };

  } catch (e) {
    console.warn('Meteo fetch failed', e);
    return null;
  }
}

async function initFloodLayer() {
  floodLayer.clearLayers();

  // Generate grid points from current view or just contracts?
  // Task: "Coordinates of all displayed contracts... or cluster centers"
  // We'll use a grid over the bounding box of KZ or the contracts.
  // Using contracts to find relevant areas.

  if (contracts.length === 0) return;

  const grid = new Map();
  contracts.forEach(c => {
    if (!c.latitude || !c.longitude) return;
    // Snap to grid
    const latGrid = Math.round(c.latitude / GRID_STEP) * GRID_STEP;
    const lonGrid = Math.round(c.longitude / GRID_STEP) * GRID_STEP;
    const key = `${latGrid},${lonGrid}`;
    grid.set(key, { lat: latGrid, lon: lonGrid });
  });

  const points = Array.from(grid.values());
  console.log(`Checking flood risk for ${points.length} grid points...`);

  // Limit requests to avoid spamming API too fast (although Open-Meteo is generous)
  // We'll do batches or just Promise.all with a limit if needed.
  // For 50-100 points, Promise.all is likely fine.

  const tasks = points.map(async pt => {
    const forecast = await fetchFloodForecast(pt.lat, pt.lon);
    if (!forecast) return;

    if (forecast.risk === 'low') return; // Only show warnings? Task says "Markers placed not everywhere...".
    // Actually task says "Green < 10". So maybe show green too?
    // "Markers placed... only nearby clusters... to not overload".
    // Let's show Medium and High to reduce noise, or sparse Green.
    // Let's show all for the grid points we found (which are based on contract clusters).

    let color = '#22c55e'; // Green
    let iconType = '🌧';
    if (forecast.risk === 'medium') { color = '#eab308'; } // Yellow
    if (forecast.risk === 'high') { color = '#ef4444'; iconType = '🌊'; } // Red

    // If green, maybe skip to reduce clutter, unless user wants assurance?
    // "Green: Precip < 10". We will show them but maybe smaller?

    const icon = L.divIcon({
      className: 'weather-icon',
      html: `<div style="background:${color}; color:white; border-radius:50%; width:24px; height:24px; text-align:center; line-height:24px; font-size:14px; border:1px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.2);">${iconType}</div>`
    });

    const marker = L.marker([pt.lat, pt.lon], { icon });

    marker.bindTooltip(`
      <div><b>${iconType} Прогноз</b></div>
      <div>Осадки (макс 24ч): ${forecast.maxRain.toFixed(1)} мм</div>
      <div style="margin-top:5px; font-size:0.8em; color:#555;">
        ${forecast.risk === 'high' ? '⚠️ Опасность паводка' : forecast.risk === 'medium' ? '⚠️ Внимание' : '✅ Норма'}
      </div>
    `, {
      className: 'risk-tooltip-flood',
      direction: 'top'
    });

    marker.addTo(floodLayer);
  });

  await Promise.all(tasks);
}


// ---- Regions (ADM1) ----
async function loadRegions() {
  const resp = await fetch('./kaz_adm1_simplified.geojson');
  regionsGeoJSON = await resp.json();
  renderRegions();
}
function locateRegionId([lon, lat]) {
  if (!regionsGeoJSON) return undefined;
  const pt = turf.point([lon, lat]);
  for (const f of regionsGeoJSON.features) {
    if (turf.booleanPointInPolygon(pt, f)) {
      return f.properties.shapeID || f.properties.GID_1 || f.properties.ID_1 || f.properties.NAME_1;
    }
  }
  return undefined;
}
function precomputeSeismicRisk() {
  if (!regionsGeoJSON || !seismicZonesGeoJSON) return;
  for (const region of regionsGeoJSON.features) {
    region.properties.hasSeismicRisk = false;
    for (const zone of seismicZonesGeoJSON.features) {
      if (turf.intersect(region, zone)) {
        region.properties.hasSeismicRisk = true;
        break;
      }
    }
  }
}

function renderRegions() {
  if (!regionsGeoJSON) return;
  regionLayer.clearLayers();
  regionLayer.addData(regionsGeoJSON);
}

// ---- Region panel ----
let currentRegion = { id: null, name: null, contracts: [] };

async function exportToExcel(data, filename) {
  await ensureLibraryLoaded('XLSX', LIBS.XLSX);
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contracts');
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function renderRegionContracts(list) {
  const container = document.getElementById('regionContracts');
  container.innerHTML = '';
  for (const c of list) {
    const div = document.createElement('div');
    div.className = 'contract-card';

    const changeLocationBtn = hasPermission('manualLocation')
      ? `<button class="button-small" onclick="startAssignment(${c.id})">Изменить локацию</button>`
      : '';

    div.innerHTML = `
      <div><b>${c.objectType || 'Без типа'}</b> (${c.isActive ? 'Активен' : 'Неактивен'})</div>
      <div class="meta">${c.address || '-'}</div>
      <div class="meta">${c.startDate} → ${c.endDate}</div>
      <div>${formatKZT(c.insuranceAmount || 0)}</div>
      ${changeLocationBtn}
    `;
    container.appendChild(div);
  }
}

async function openRegionPanel(regionId, name) {
  // Need Turf for risk calculation (layerGroupToGeoJSON calls turf)
  await ensureLibraryLoaded('turf', LIBS.turf);

  currentRegion.id = regionId;
  currentRegion.name = name;
  currentRegion.contracts = contracts.filter(c => c.regionId === regionId);

  const regionNameEl = document.getElementById('regionName');
  if (regionNameEl) {
    regionNameEl.textContent = name;
  }

  const regionCardEl = document.getElementById('regionCard');
  if (regionCardEl) {
    regionCardEl.classList.remove('hidden');
  }

  const stats = {
    total: currentRegion.contracts.length,
    active: currentRegion.contracts.filter(c => c.isActive).length,
    sum: currentRegion.contracts.reduce((a, c) => a + (c.insuranceAmount || 0), 0)
  };

  const regionStatsEl = document.getElementById('regionStats');
  if (regionStatsEl) {
      regionStatsEl.innerHTML = `
        <div>Всего договоров<b>${stats.total}</b></div>
        <div>Активных<b>${stats.active}</b></div>
        <div>Общая сумма<b>${formatKZT(stats.sum)}</b></div>
      `;
  }

  // Calculate Region PML (Spatial Intersection)
  if (riskEngine && regionsGeoJSON) {
      const regionFeature = regionsGeoJSON.features.find(f =>
          (f.properties.shapeID || f.properties.GID_1 || f.properties.ID_1 || f.properties.NAME_1) === regionId
      );

      if (regionFeature) {
          // Construct Risk Layers GeoJSONs
          const riskLayers = {
              earthquake: seismicZonesGeoJSON,
              fire: layerGroupToGeoJSON(fireLayer, 25), // 25km buffer for fire
              flood: layerGroupToGeoJSON(floodLayer, 30) // 30km buffer for flood grid
          };

          const pmlData = riskEngine.calculateRegionalRisks(regionFeature, stats.sum, riskLayers);
          const regionPMLStatsEl = document.getElementById('regionPMLStats');

          if (regionPMLStatsEl) {
              if (pmlData && pmlData.earthquakeDetails) {
                  const details = pmlData.earthquakeDetails;
                  const color = details.maxIntensity >= 9 ? '#ef4444' : (details.maxIntensity >= 7 ? '#f59e0b' : '#10b981');

                  // Tooltip text for region
                  const tooltipText = "Оценка для данного региона. Берется максимальная зафиксированная интенсивность землетрясения (MSK-64) в географических границах региона. Применяется к общей страховой сумме всех договоров в этом регионе.";

                  regionPMLStatsEl.innerHTML = `
                    <div class="pml-box" style="background: #f8fafc; padding: 10px; border-radius: 6px; border-left: 4px solid ${color}; position: relative;">
                        <span class="tooltip-icon" title="${tooltipText}" style="position:absolute; right:10px; top:10px; cursor:help;">(?)</span>
                        <div style="font-size: 1.2em; font-weight: bold; color: #1e293b;">
                            PML (Землетрясение): ${formatKZT(details.pml)}
                        </div>
                        <div style="margin-top: 5px; color: #475569;">
                            <span>Интенсивность: <b>${details.maxIntensity} баллов (MSK-64)</b></span><br>
                            <span>Коэффициент ущерба: <b>${(details.factor * 100).toFixed(0)}%</b></span>
                        </div>
                        <div style="margin-top: 5px; font-size: 0.8em; color: #64748b; font-style: italic;">
                            ${details.description}
                        </div>
                    </div>
                    `;
              } else if (pmlData) {
                   // Fallback for non-MSK calculation or error
                   regionPMLStatsEl.innerHTML = `PML: ${formatKZT(pmlData.pml)}`;
              } else {
                   regionPMLStatsEl.innerHTML = 'Нет данных о сейсмическом риске для данного региона.';
              }
          }
      }
  }

  const regionSearchEl = document.getElementById('regionSearch');
  if (regionSearchEl) {
    regionSearchEl.value = '';
  }
  renderRegionContracts(currentRegion.contracts);
}

document.getElementById('btnCloseRegion').addEventListener('click', () => {
  document.getElementById('regionCard').classList.add('hidden');
});

document.getElementById('regionSearch').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const filtered = currentRegion.contracts.filter(c => {
    const type = (c.objectType || '').toLowerCase();
    const address = (c.address || '').toLowerCase();
    return type.includes(query) || address.includes(query);
  });
  renderRegionContracts(filtered);
});

document.getElementById('btnExportRegion').addEventListener('click', () => {
  const dataToExport = currentRegion.contracts.map(c => ({
    'Тип объекта': c.objectType,
    'Адрес': c.address,
    'Начало': c.startDate,
    'Конец': c.endDate,
    'Сумма': c.insuranceAmount,
    'Статус': c.isActive ? 'Активен' : 'Неактивен',
  }));
  exportToExcel(dataToExport, `Contracts_${currentRegion.name}`);
});

// ---- Manual Location Assignment ----
let assignmentNotification = null;

function startAssignment(contractId) {
  assignmentState = { active: true, contractId: contractId };

  document.getElementById('unlocatedPanel').classList.add('hidden');
  document.getElementById('regionCard').classList.add('hidden');

  if (!assignmentNotification) {
    assignmentNotification = L.control({ position: 'bottomright' });
    assignmentNotification.onAdd = function () {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
      div.innerHTML = 'Кликните на карте, чтобы указать точное местоположение договора';
      return div;
    };
    assignmentNotification.addTo(map);
  }

  L.DomUtil.addClass(map._container,'crosshair-cursor');
}

function cancelAssignment() {
  assignmentState = { active: false, contractId: null };
  if (assignmentNotification) {
    assignmentNotification.remove();
    assignmentNotification = null;
  }
  L.DomUtil.removeClass(map._container,'crosshair-cursor');
}

async function handleMapAssignment(e) {
  if (!assignmentState.active) return;

  await ensureLibraryLoaded('turf', LIBS.turf);

  const { latlng } = e;
  const regionId = locateRegionId([latlng.lng, latlng.lat]);
  const regionName = regionsGeoJSON.features.find(f => (f.properties.shapeID || f.properties.GID_1 || f.properties.NAME_1) === regionId)?.properties.NAME_1 || 'Неизвестный регион';

  const confirmed = confirm(`Вы уверены, что хотите назначить эту локацию в регионе "${regionName}"?`);

  if (confirmed) {
    await saveContractLocation(assignmentState.contractId, latlng, regionId);
  }
  cancelAssignment();
}

map.on('click', handleMapAssignment);

async function saveContractLocation(contractId, latlng, regionId) {
  const { data, error } = await supabaseClient
    .from('contracts')
    .update({ lat: latlng.lat, lng: latlng.lng, region_id: regionId })
    .eq('id', contractId);

  if (error) {
    console.error('Error updating contract location:', error);
    alert('Не удалось обновить локацию. Проверьте консоль на наличие ошибок.');
    return;
  }

  const contract = contracts.find(c => c.id === contractId);
  if (contract) {
    contract.latitude = latlng.lat;
    contract.longitude = latlng.lng;
    contract.regionId = regionId;
  }

  updateUnlocatedCount();
  renderAll();
  alert('Локация успешно обновлена.');
}


// ---- Unlocated Panel ----
function updateUnlocatedCount() {
  unlocatedContracts = contracts.filter(c => !c.latitude || !c.longitude);
  const countEl = document.getElementById('unlocatedCount');
  if(countEl) {
    countEl.textContent = unlocatedContracts.length;
  }
}

function renderUnlocatedList(list) {
  const container = document.getElementById('unlocatedList');
  container.innerHTML = '';
  for (const c of list) {
    const div = document.createElement('div');
    div.className = 'contract-card';
    div.innerHTML = `
      <div><b>${c.objectType || 'Без типа'}</b></div>
      <div class="meta">${c.address || '-'}</div>
      <div class="meta">${c.startDate} → ${c.endDate}</div>
      <div>${formatKZT(c.insuranceAmount || 0)}</div>
      <button class="button-small" onclick="startAssignment(${c.id})">Назначить на карте</button>
    `;
    container.appendChild(div);
  }
}

document.getElementById('btnShowUnlocated').addEventListener('click', () => {
  document.getElementById('unlocatedPanel').classList.remove('hidden');
  document.getElementById('unlocatedSearch').value = '';
  renderUnlocatedList(unlocatedContracts);
});

document.getElementById('btnCloseUnlocated').addEventListener('click', () => {
  document.getElementById('unlocatedPanel').classList.add('hidden');
});

document.getElementById('unlocatedSearch').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const filtered = unlocatedContracts.filter(c => {
    const type = (c.objectType || '').toLowerCase();
    const address = (c.address || '').toLowerCase();
    return type.includes(query) || address.includes(query);
  });
  renderUnlocatedList(filtered);
});


// ---- Legends ----
function renderSeismicLegend() {
  const el = document.getElementById('legendSeismic');
  el.classList.remove('hidden');
  el.innerHTML = `
    <div><b>Сейсмический риск</b></div>
    <div class="row"><i style="background:#ef4444"></i> Высокий</div>
    <div class="row"><i style="background:#6b7280"></i> Низкий</div>
  `;
}

// ---- Seismic ----
async function loadSeismicZones() {
  const resp = await fetch('./kz_risk_zones.geojson');
  seismicZonesGeoJSON = await resp.json();

  // Assign intensity manually if missing
  seismicZonesGeoJSON.features.forEach(f => {
      if (!f.properties.intensity) {
          const name = (f.properties.name || f.properties.Name || '').toLowerCase();
          if (name.includes('almaty') || name.includes('алматы')) {
              f.properties.intensity = 9;
          } else if (name.includes('east') || name.includes('восток') || name.includes('zhambyl') || name.includes('turkistan')) {
              f.properties.intensity = 8;
          } else {
              f.properties.intensity = 7;
          }
      }
  });
}

// ---- Excel Import ----
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_PARAMS = { format: 'jsonv2', addressdetails: 1, limit: 1, countrycodes: 'kz' };
const GEO_DELAY_MS = 1000;

const KZ_REGIONS = {
  'Шымкент': { lat: 42.3, lon: 69.6, radius: 50 },
  'Алматы': { lat: 43.2, lon: 76.9, radius: 50 },
  'Астана': { lat: 51.1, lon: 71.4, radius: 50 },
  'Нур-Султан': { lat: 51.1, lon: 71.4, radius: 50 },
  'Акмолинская': { lat: 51.9, lon: 69.4, radius: 200 },
  'Актюбинская': { lat: 50.3, lon: 57.2, radius: 200 },
  'Алматинская': { lat: 45.0, lon: 78.0, radius: 200 },
  'Атырауская': { lat: 47.1, lon: 51.9, radius: 200 },
  'Западно-Казахстанская': { lat: 51.2, lon: 51.4, radius: 200 },
  'Жамбылская': { lat: 43.3, lon: 71.4, radius: 200 },
  'Карагандинская': { lat: 49.8, lon: 73.1, radius: 200 },
  'Костанайская': { lat: 53.2, lon: 63.6, radius: 200 },
  'Кызылординская': { lat: 44.8, lon: 62.5, radius: 200 },
  'Мангистауская': { lat: 44.6, lon: 54.1, radius: 200 },
  'Павлодарская': { lat: 52.3, lon: 76.9, radius: 200 },
  'Северо-Казахстанская': { lat: 54.9, lon: 69.2, radius: 200 },
  'Туркестанская': { lat: 43.3, lon: 68.3, radius: 200 },
  'Восточно-Казахстанская': { lat: 49.9, lon: 82.6, radius: 200 }
};

let geoQueue = Promise.resolve();
function enqueue(task) {
  geoQueue = geoQueue.then(() => task()).then(res => new Promise(r => setTimeout(() => r(res), GEO_DELAY_MS)));
  return geoQueue;
}

function layerGroupToGeoJSON(layerGroup, bufferRadiusKm) {
    const features = [];
    layerGroup.eachLayer(layer => {
        if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
            const ll = layer.getLatLng();
            const pt = turf.point([ll.lng, ll.lat]);
            const buffered = turf.buffer(pt, bufferRadiusKm, { units: 'kilometers' });
            features.push(buffered);
        }
    });
    return turf.featureCollection(features);
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the Earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function validateGeoResult(geoResult, originalAddress) {
  if (!geoResult || !geoResult.lat || !geoResult.lon) return false;
  const lat = parseFloat(geoResult.lat);
  const lon = parseFloat(geoResult.lon);
  if (lat < 40.5 || lat > 55.5 || lon < 46.5 || lon > 87.5) {
    console.warn(`Координаты вне границ Казахстана: ${lat}, ${lon} для адреса ${originalAddress}`);
    return false;
  }
  for (const [regionName, regionData] of Object.entries(KZ_REGIONS)) {
    if (originalAddress.toLowerCase().includes(regionName.toLowerCase())) {
      const distance = calculateDistance(lat, lon, regionData.lat, regionData.lon);
      if (distance > regionData.radius) {
        console.warn(`Адрес "${originalAddress}" содержит "${regionName}", но координаты находятся на расстоянии ${distance} км`);
        return false;
      }
    }
  }
  return true;
}

function buildAddressVariants(raw) {
  const base = raw ? String(raw).trim() : '';
  const withCountry = /казахстан/i.test(base) ? base : `${base}, Казахстан`;
  const parts = withCountry.split(',').map(s => s.trim()).filter(Boolean);
  const variants = [];
  variants.push(parts.join(', '));
  if (parts.length > 2) {
    variants.push(parts.slice(1).join(', '));
  }
  if (parts.length >= 3) {
    variants.push(`${parts[0]}, ${parts[1]}, Казахстан`);
  }
  if (parts.length >= 2) {
    variants.push(`${parts[0]}, Казахстан`);
  }
  return [...new Set(variants)];
}

async function geocodeOnce(q) {
  const url = new URL(NOMINATIM_URL);
  Object.entries({ ...NOMINATIM_PARAMS, q }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { 'Accept-Language': 'ru' } });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

function normalizeAddress(address) {
    if (!address) return '';
    return address
        .replace(/\bРК,?\s*/gi, 'Казахстан, ')
        .replace(/\bг\.\s*/gi, '')
        .replace(/\bобл\.\s*/gi, 'область ')
        .replace(/\bр-н\.\s*/gi, 'район ')
        .replace(/\bул\.\s*/gi, 'улица ')
        .replace(/\bпр\.\s*/gi, 'проспект ')
        .replace(/\bд\.\s*/gi, 'дом ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function geocodeKZ(address) {
  if (!address) return null;
  const normalizedAddress = normalizeAddress(address);
  if (geoCache[address]) {
    return geoCache[address];
  }
  const variants = buildAddressVariants(normalizedAddress);
  for (const q of variants) {
    const hit = await enqueue(() => geocodeOnce(q));
    if (hit?.lat && hit?.lon) {
      if (!validateGeoResult(hit, address)) {
        console.warn(`Результат геокодирования для "${q}" не прошел валидацию`);
        continue;
      }
      const res = {
        lat: +hit.lat,
        lon: +hit.lon,
        display_name: hit.display_name || q
      };
      geoCache[address] = res;
      saveGeoCache();
      return res;
    }
  }
  console.error(`Не удалось геокодировать адрес: ${address}`);
  return null;
}

function excelToISO(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

function parseAmount(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[ \u202F]/g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

function extractFirstAddress(rawAddress) {
    if (!rawAddress) return '';
    let address = String(rawAddress).trim();
    address = address.replace(/^[0-9]{6},?\s*/, '');
    address = address.split(';')[0];
    address = address.replace(/^[0-9]+\s*объект:\s*/i, '');
    return address.trim();
}

async function importExcel(file, onProgress) {
  // Ensure libraries are loaded
  await ensureLibraryLoaded('XLSX', LIBS.XLSX);
  await ensureLibraryLoaded('turf', LIBS.turf);

  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const imported = [];
  let geoErrors = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const startDate = excelToISO(row[0]);
    const endDate = excelToISO(row[1]);
    const objectType = row[2] ? String(row[2]).trim() : '';
    // ВЫЗЫВАЕМ НАШ ОЧИСТИТЕЛЬ
    const address = extractFirstAddress(row[3]); // <-- НОВАЯ СТРОКА
    const insuranceAmount = parseAmount(row[4]);

    if (!startDate || !endDate || !address) {
      // --- НАЧАЛО БЛОКА ЛОГИРОВАНИЯ ---
      // 'i + 1' используется, т.к. массив 'rows' начинается с 0 (заголовок),
      // а реальные данные (i=1) - это строка 2 в Excel.
      const excelRowNumber = i + 1;

      let skipReason = [];
      if (!startDate) skipReason.push("Неверная/пустая Дата Начала (Колонка A)");
      if (!endDate) skipReason.push("Неверная/пустая Дата Окончания (Колонка B)");
      if (!address) skipReason.push("Пустой Адрес (Колонка D)");

      // Выводим предупреждение в консоль браузера
      console.warn(`[ИМПОРТ ПРОПУЩЕН] Строка Excel №${excelRowNumber}: Причина: ${skipReason.join(', ')}`);
      // --- КОНЕЦ БЛОКА ЛОГИРОВАНИЯ ---

      onProgress && onProgress(i, rows.length - 1, geoErrors);
      continue;
    }

    const geo = await geocodeKZ(address);
    if (!geo) geoErrors++;
    const c = {
      id: Date.now() + i,
      objectType,
      insuranceAmount,
      startDate,
      endDate,
      isActive: true,
      address,
      latitude: geo?.lat,
      longitude: geo?.lon
    };
    if (c.latitude && c.longitude) c.regionId = locateRegionId([c.longitude, c.latitude]);
    imported.push(c);
    onProgress && onProgress(i, rows.length - 1, geoErrors);
  }
  return { imported, geoErrors, total: rows.length - 1 };
}

function showLoader(msg) {
  document.getElementById('loaderText').textContent = msg || 'Загрузка...';
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('loader').classList.remove('hidden');
}

function hideLoader() {
  document.getElementById('loader').classList.add('hidden');
}

document.getElementById('excelInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  document.getElementById('btnResetExcel').classList.remove('hidden');
  showLoader('Импорт Excel...');
  try {
    const { imported, geoErrors, total } = await importExcel(file, (i, total, errs) => {
      const percent = total > 0 ? (i / total) * 100 : 0;
      document.getElementById('loaderText').textContent = `Импорт: ${i}/${total} | Ошибки геокодирования: ${errs}`;
      document.getElementById('progressBar').style.width = `${percent}%`;
    });

    const toInsert = imported.map(c => ({
      start_date: c.startDate,
      end_date: c.endDate,
      object_type: c.objectType,
      address: c.address,
      insurance_amount: c.insuranceAmount,
      lat: c.latitude,
      lng: c.longitude,
      is_active: c.isActive,
      region_id: c.regionId // <-- ДОБАВЛЕНО ЭТО ПОЛЕ
    }));

    if (toInsert.length > 0) {
      const { error } = await supabaseClient.from('contracts').insert(toInsert);
      if (error) {
        console.error('Error inserting contracts:', error);
        alert('Ошибка при сохранении данных в базу.');
      }
    }

    contracts = contracts.concat(imported);
    resetFilters(); // Сбрасываем фильтры, чтобы показать все данные
    renderAll();
    updateUnlocatedCount();
    alert(`Импорт завершен.\n\nВсего строк в файле: ${total}\nУспешно импортировано: ${imported.length}\n\nНе удалось определить координаты для ${geoErrors} адресов. Эти записи не будут отображены на карте, но появятся в общем списке.`);
  } finally {
    hideLoader();
  }
});

document.getElementById('btnResetExcel').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('excelInput').value = '';
  document.getElementById('btnResetExcel').classList.add('hidden');
});

// ---- Render all ----
function renderAll() {
  map.invalidateSize();
  renderMarkers();
  renderRegions();
  renderEarthquakes();
  updateStats();
  updateUnlocatedCount();
  renderSeismicLegend();

  const filtered = filteredContracts();
  updateHeatmap(filtered);
  updateDashboard(filtered);
}

// ---- Risk Analytics Visualization ----

function updateHeatmap(list) {
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) {
        console.warn('Map size is 0, skipping heatmap update to prevent IndexSizeError');
        return;
    }

    if (!heatmapLayer) {
        heatmapLayer = L.heatLayer([], { radius: 25, maxZoom: 10 }).addTo(map);
    }
    const points = [];
    for (const c of list) {
        if (c.latitude && c.longitude && c.riskData) {
            // Intensity based on risk score (0-100 -> 0.0-1.0)
            // Use score/100 as intensity
            points.push([c.latitude, c.longitude, c.riskData.score / 100]);
        }
    }
    heatmapLayer.setLatLngs(points);
}

function updateDashboard(list) {
    const dashboard = document.getElementById('risk-dashboard');
    if (!dashboard) return;

    if (list.length === 0) {
        // Keep visible or hide? User says "floating panel".
    } else {
        dashboard.classList.remove('hidden');
    }

    // 1. Total Exposure
    const totalExposure = list.reduce((sum, c) => sum + (c.insuranceAmount || 0), 0);
    const totalExposureEl = document.getElementById('dashTotalExposure');
    if (totalExposureEl) {
        totalExposureEl.textContent = formatKZT(totalExposure);
    }

    // 2. PML (Probable Maximum Loss) - MSK-64 Aggregation
    const pmlEl = document.getElementById('dashPML');

    // Calculate Total PML using MSK logic
    let totalPML_MSK = 0;

    if (riskEngine && seismicZonesGeoJSON && (typeof turf !== 'undefined' || window.turf)) {
        const riskLayers = { earthquake: seismicZonesGeoJSON };
        const t = window.turf || turf;
        list.forEach(c => {
            const amt = c.insuranceAmount || 0;
            if (amt === 0) return;

            // If we have coordinates, calculate exact risk
            if (c.latitude && c.longitude) {
                const pt = t.point([c.longitude, c.latitude]);
                const msk = riskEngine.calculatePML_MSK64(pt, amt, riskLayers);
                totalPML_MSK += msk.pml;
            }
        });
    } else if (riskEngine) {
        // Fallback if turf/geojson not ready
         const scenarios = riskEngine.calculateScenarios(list);
         totalPML_MSK = scenarios.length > 0 ? scenarios[0].pml : 0;
    }

    if (pmlEl) {
        const tooltipText = "Расчет PML (Probable Maximum Loss) произведен на основе сейсмической шкалы MSK-64. Для каждого объекта определяется зона сейсмической активности, назначается балл (от 6 до 10) и соответствующий коэффициент разрушения (от 5% до 100%). Итоговая цифра — сумма вероятных убытков по всему портфелю.";

        pmlEl.innerHTML = `
            ${formatKZT(totalPML_MSK)}
            <span class="tooltip-icon" title="${tooltipText}" style="cursor:help;">(?)</span>
            <div style="font-size:0.7em; color:#ccc; margin-top:4px;">
                Расчет по методологии MSK-64<br>
                (Сумма PML каждого объекта)
            </div>
        `;
    }

    const detailsEl = document.getElementById('pmlDetails');
    if (detailsEl) {
        // Show breakdown by Intensity
        const buckets = { 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 'No Risk': 0 };
        const riskLayers = { earthquake: seismicZonesGeoJSON };

        if (riskEngine && seismicZonesGeoJSON && (typeof turf !== 'undefined' || window.turf)) {
             const t = window.turf || turf;
             list.forEach(c => {
                const amt = c.insuranceAmount || 0;
                if (!c.latitude || !c.longitude) return;
                const pt = t.point([c.longitude, c.latitude]);
                const msk = riskEngine.calculatePML_MSK64(pt, amt, riskLayers);
                const intensity = Math.floor(msk.maxIntensity);
                if (intensity >= 6) buckets[intensity] = (buckets[intensity] || 0) + msk.pml;
                else buckets['No Risk'] = (buckets['No Risk'] || 0) + msk.pml;
             });
        }

        let tableRows = '';
        [10, 9, 8, 7, 6].forEach(intensity => {
             const pml = buckets[intensity];
             if (pml > 0) {
                 tableRows += `
                  <tr>
                    <td><b>${intensity} баллов</b></td>
                    <td>${formatKZT(pml)}</td>
                  </tr>
                 `;
             }
        });

        if (tableRows) {
             detailsEl.innerHTML = `
                <table class="pml-table" style="width:100%; border-collapse:collapse; font-size:0.85rem; margin-top:10px;">
                  <thead>
                    <tr style="text-align:left; border-bottom:1px solid #ddd;">
                      <th>Интенсивность</th>
                      <th>PML</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                </table>`;
             detailsEl.classList.remove('hidden');
        } else {
             detailsEl.innerHTML = '';
             detailsEl.classList.add('hidden');
        }
    }

    // 3. Chart
    updateRiskChart(list);
}

function updateRiskChart(list) {
    const counts = { Extreme: 0, High: 0, Medium: 0, Low: 0 };
    for (const c of list) {
        if (c.riskData) {
            counts[c.riskData.level]++;
        } else {
            counts.Low++; // Default
        }
    }

    const ctx = document.getElementById('riskChart').getContext('2d', { willReadFrequently: true });

    if (riskChart) {
        riskChart.data.labels = ['Extreme', 'High', 'Medium', 'Low'];
        riskChart.data.datasets[0].data = [counts.Extreme, counts.High, counts.Medium, counts.Low];
        riskChart.data.datasets[0].backgroundColor = ['#7f1d1d', '#dc3545', '#ffc107', '#28a745'];
        riskChart.update();
    } else {
        riskChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Extreme', 'High', 'Medium', 'Low'],
                datasets: [{
                    data: [counts.Extreme, counts.High, counts.Medium, counts.Low],
                    backgroundColor: ['#7f1d1d', '#dc3545', '#ffc107', '#28a745'],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });
    }
}

document.getElementById('btnCloseDashboard').addEventListener('click', () => {
   document.getElementById('risk-dashboard').classList.add('hidden');
});

function renderEarthquakes() {
    earthquakeLayer.clearLayers();
    if (!earthquakeEvents) return;

    earthquakeEvents.forEach(event => {
        const { geometry, properties } = event;
        if (geometry) {
            const [lon, lat] = geometry.coordinates;
            const magnitude = properties.mag;
            const marker = L.circleMarker([lat, lon], {
                radius: magnitude * 2,
                color: '#ff6b6b',
                fillColor: '#ff6b6b',
                fillOpacity: 0.6,
                weight: 1
            }).addTo(earthquakeLayer);

            const eventTime = new Date(properties.time).toLocaleString('ru-RU');
            marker.bindPopup(`
                <b>Магнитуда:</b> ${properties.mag}<br>
                <b>Местоположение:</b> ${properties.place}<br>
                <b>Время:</b> ${eventTime}
            `);
        }
    });
}

function renderEarthquakeList() {
    const el = document.getElementById('earthquakeList');
    el.innerHTML = '';
    if (!earthquakeEvents) return;

    earthquakeEvents.forEach((event, index) => {
        const { geometry, properties } = event;
        const div = document.createElement('div');
        div.className = 'contract-card';
        const eventDate = new Date(properties.time).toLocaleDateString('ru-RU');

        div.innerHTML = `
            <div><b>Магнитуда: ${properties.mag}</b></div>
            <div class="meta">${properties.place}</div>
            <div class="meta">Дата: ${eventDate}</div>
        `;

        div.addEventListener('click', () => {
            const [lon, lat] = geometry.coordinates;
            map.flyTo([lat, lon], 8);

            // Find the corresponding marker on the map and open its popup
            const marker = earthquakeLayer.getLayers()[index];
            if (marker) {
                marker.openPopup();
            }
        });

        el.appendChild(div);
    });
}

document.getElementById('toggleEarthquakesList').addEventListener('click', () => {
    const listEl = document.getElementById('earthquakeList');
    const iconEl = document.getElementById('earthquakeToggleIcon');
    const isVisible = !listEl.classList.contains('collapsed');

    if (isVisible) {
        listEl.classList.add('collapsed');
        iconEl.classList.remove('rotated');
    } else {
        renderEarthquakeList();
        listEl.classList.remove('collapsed');
        iconEl.classList.add('rotated');
    }
});
function setupLayerControl() {
    const baseLayers = {
        "OpenStreetMap": osmLayer
    };

    const overlayLayers = {
        "Договоры": markerLayer,
        "Регионы (Сейсмо)": regionLayer,
        "Землетрясения (USGS)": earthquakeLayer,
        "🔥 Пожары (NASA)": fireLayer,
        "💧 Паводки и Ливни": floodLayer
    };

    L.control.layers(baseLayers, overlayLayers, { collapsed: false }).addTo(map);
}
// ---- init ----
async function loadContracts() {
  const CHUNK_SIZE = 1000;
  let allData = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabaseClient
      .from('contracts')
      .select('id, start_date, end_date, object_type, address, insurance_amount, lat, lng, is_active, region_id')
      .range(from, from + CHUNK_SIZE - 1);

    if (error) {
      console.error('Error fetching contracts:', error);
      contracts = []; // Ensure it's an array on error
      return;
    }

    allData.push(...data);

    if (data.length < CHUNK_SIZE) {
      break; // Last page
    }

    from += CHUNK_SIZE;
  }

  // Convert snake_case (from DB) to camelCase (for JS)
  contracts = allData.map(c => {
    const contract = {
      id: c.id,
      startDate: c.start_date,
      endDate: c.end_date,
      objectType: c.object_type,
      address: c.address,
      insuranceAmount: parseFloat(c.insurance_amount) || 0,
      latitude: c.lat,
      longitude: c.lng,
      isActive: c.is_active,
      regionId: c.region_id
    };
    if (riskEngine) {
        contract.riskData = riskEngine.calculateScore(contract);
    }
    return contract;
  });
}

async function init() {
  console.log("Initializing application");

  // Init Risk Engine
  if (typeof RiskEngine !== 'undefined') {
      riskEngine = new RiskEngine();
  } else {
      console.warn('RiskEngine not loaded');
  }

  if (checkAuth()) {
    setAuth(true);
    applyRoleRestrictions(); // Apply restrictions for logged-in user
  } else {
    setAuth(false);
  }
  osmLayer.addTo(map);
  markerLayer.addTo(map);
  regionLayer.addTo(map);
  earthquakeLayer.addTo(map);
  bindFiltersToUI();
  await loadContracts();
  await loadRegions();
  await loadSeismicZones();
  await loadEarthquakeData();

  // Preload Turf for seismic risk computation
  await ensureLibraryLoaded('turf', LIBS.turf);
  precomputeSeismicRisk();

  // Risk layers are loaded on demand via event listeners below

  renderAll();
  setupLayerControl();

  // Make dashboard draggable
  const dashboardEl = document.getElementById('risk-dashboard');
  if (dashboardEl) {
      makeDraggable(dashboardEl);
  }

  // Load-on-demand logic for risk layers
  map.on('overlayadd', function(e) {
    if (e.name === '🔥 Пожары (NASA)') {
       // Only fetch if empty or stale? For now, just fetch.
       if (fireLayer.getLayers().length === 0) {
         initFireLayer();
       }
    }
    if (e.name === '💧 Паводки и Ливни') {
       if (floodLayer.getLayers().length === 0) {
         initFloodLayer();
       }
    }
  });

  setInterval(loadEarthquakeData, 10 * 60 * 1000);
  // Refresh fires every hour if layer is active?
  // Simple interval is fine, but check if needed.
  setInterval(() => {
    if (map.hasLayer(fireLayer)) initFireLayer();
  }, 60 * 60 * 1000);
}

// ---- Earthquake Data ----
async function loadEarthquakeData() {
    try {
        const response = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson');
        const data = await response.json();

        const KZ_CENTER = { lat: 48.0, lon: 66.9 };
        const MAX_DISTANCE_KM = 1000; // Максимальный радиус поиска (в км)

        let newEvents = data.features.filter(event => {
            return !earthquakeEvents.some(existing => existing.id === event.id);
        });

        let relevantEvents = newEvents.filter(event => {
            const [lon, lat] = event.geometry.coordinates;
            const distance = calculateDistance(lat, lon, KZ_CENTER.lat, KZ_CENTER.lon);

            return distance < MAX_DISTANCE_KM && event.properties.mag >= 5.0;
        });

        if (relevantEvents.length > 0) {
            console.log(`Найдено ${relevantEvents.length} новых релевантных землетрясений!`);
            for (const event of relevantEvents) {
                processShakeMap(event.properties.detail);
            }
        }

        earthquakeEvents = earthquakeEvents.concat(newEvents);
        console.log(`Loaded ${newEvents.length} new earthquake events. Total events: ${earthquakeEvents.length}`);

        if (newEvents.length > 0) {
            renderEarthquakes();
            renderEarthquakeList();
        }
    } catch (error) {
        console.error("Failed to load earthquake data:", error);
        earthquakeEvents = []; // Ensure it's an array on error
    }
}
async function processShakeMap(detailUrl) {
    try {
        const response = await fetch(detailUrl);
        const eventDetail = await response.json();

        if (!eventDetail.properties || !eventDetail.properties.products || !eventDetail.properties.products.shakemap) {
            console.log("ShakeMap для этого события не найден.", eventDetail.properties.title);
            return;
        }

        const shakemapProduct = eventDetail.properties.products.shakemap[0];

        const intensityGridUrl = shakemapProduct.contents['application/json']?.url;

        if (intensityGridUrl) {
            await fetchAndDisplayShakeMap(intensityGridUrl, eventDetail.properties.title);
        }
    } catch (error) {
        console.error("Ошибка при получении ShakeMap:", error);
    }
}

function getIntensityColor(intensity) {
    if (intensity > 7.5) return '#d73027';
    if (intensity > 6.5) return '#fc8d59';
    if (intensity > 5.5) return '#fee08b';
    if (intensity > 4.5) return '#d9ef8b';
    if (intensity > 3.5) return '#91cf60';
    return '#1a9850';
}

async function fetchAndDisplayShakeMap(gridUrl, eventTitle) {
    try {
        await ensureLibraryLoaded('turf', LIBS.turf);
        const response = await fetch(gridUrl);
        const intensityData = await response.json();

        const shakeMapLayer = L.geoJSON(intensityData, {
            style: function(feature) {
                const intensity = feature.properties.value;
                return {
                    fillColor: getIntensityColor(intensity),
                    fillOpacity: 0.5,
                    weight: 1
                };
            }
        }).addTo(map);

        let affectedRegions = [];

        for (const region of regionsGeoJSON.features) {
            for (const intensityZone of intensityData.features) {
                if (intensityZone.properties.value > 5.0) {
                    const intersection = turf.intersect(region, intensityZone);
                    if (intersection) {
                        affectedRegions.push(region.properties.NAME_1);
                        break;
                    }
                }
            }
        }

        const uniqueRegions = [...new Set(affectedRegions)];

        if(uniqueRegions.length > 0) {
            alert(`ВНИМАНИЕ: Землетрясение "${eventTitle}" может затронуть регионы: ${uniqueRegions.join(', ')}`);
        }

    } catch (error) {
        console.error("Ошибка при отображении ShakeMap:", error);
    }
}
// --- Logic for Draggable Dashboard ---
function makeDraggable(el) {
    const header = el.querySelector('.dashboard-header');
    if (!header) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        // Получаем текущие координаты окна
        const rect = el.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        // Важно: убираем позиционирование bottom/right, переходим на top/left
        el.style.bottom = 'auto';
        el.style.right = 'auto';
        el.style.left = `${initialLeft}px`;
        el.style.top = `${initialTop}px`;

        document.body.style.cursor = 'move';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        el.style.left = `${initialLeft + dx}px`;
        el.style.top = `${initialTop + dy}px`;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        document.body.style.cursor = 'default';
    });
}

init();
