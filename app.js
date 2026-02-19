// ---- Lazy Loading Helpers ----
const LIBS = {
  turf: {
    url: 'https://unpkg.com/@turf/turf@6.5.0/turf.min.js',
    integrity: 'sha384-82q0nm29xZzIo5BMtDYnh2/NxeO6FoaK1S/0nF84w3cEsqbBfun3JdMyDVYWfVY5'
  }
};

async function ensureLibraryLoaded(windowVar, libConfig) {
  if (window[windowVar]) return;
  // If loading is already in progress, wait for it
  if (window[`_loading_${windowVar}`]) {
     await window[`_loading_${windowVar}`];
     return;
  }

  const url = typeof libConfig === 'string' ? libConfig : libConfig.url;
  const integrity = typeof libConfig === 'string' ? null : libConfig.integrity;

  const promise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    if (integrity) {
      s.integrity = integrity;
      s.crossOrigin = 'anonymous';
    }
    s.onload = () => {
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


// ---- Map ----
const map = L.map('map', {
  minZoom: 2,
  // maxBounds removed
  scrollWheelZoom: true,
  dragging: true
}).setView([48.0196, 66.9237], 5);

map.createPane('earthquakePane');
map.getPane('earthquakePane').style.zIndex = 650; 
map.getPane('earthquakePane').style.pointerEvents = 'none';

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
});

// ---- Layers ----
let regionsGeoJSON = null;
let regionLayer = L.geoJSON(null, {
    style: f => {
      return {
        weight: 1,
        color: '#334155',
        fillColor: f.properties.hasSeismicRisk ? '#ef4444' : '#6b7280',
        fillOpacity: 0.4
      };
    },
    onEachFeature: (feature, layer) => {
      const name = feature.properties.shapeName || feature.properties.NAME_1;
      const riskStatus = feature.properties.hasSeismicRisk ? 'Высокий риск' : 'Низкий риск';

      const container = document.createElement('div');
      container.className = 'hover-card';
      const titleDiv = document.createElement('div');
      titleDiv.className = 'title';
      titleDiv.textContent = name;

      const riskDiv = document.createElement('div');
      riskDiv.textContent = 'Сейсмичность: ';
      const riskB = document.createElement('b');
      riskB.textContent = riskStatus;
      riskDiv.appendChild(riskB);

      container.appendChild(titleDiv);
      container.appendChild(riskDiv);

      layer.bindTooltip(container, { sticky:true });
      layer.on('mouseover', () => { layer.setStyle({ weight:2, fillOpacity: 0.6 }); });
      layer.on('mouseout',  () => { layer.setStyle({ weight:1, fillOpacity: 0.4 }); });
    }
});

let seismicZonesGeoJSON = null;
let earthquakeLayer = L.layerGroup().addTo(map);
let earthquakeEvents = [];

// ---- Weather Modules (Flood & Rain) ----
let floodLayer = L.layerGroup();
// Regions centers for weather check
const KZ_REGIONS = {
  'Шымкент': { lat: 42.3, lon: 69.6 },
  'Алматы': { lat: 43.2, lon: 76.9 },
  'Астана': { lat: 51.1, lon: 71.4 },
  'Акмолинская': { lat: 51.9, lon: 69.4 },
  'Актюбинская': { lat: 50.3, lon: 57.2 },
  'Алматинская': { lat: 45.0, lon: 78.0 },
  'Атырауская': { lat: 47.1, lon: 51.9 },
  'Западно-Казахстанская': { lat: 51.2, lon: 51.4 },
  'Жамбылская': { lat: 43.3, lon: 71.4 },
  'Карагандинская': { lat: 49.8, lon: 73.1 },
  'Костанайская': { lat: 53.2, lon: 63.6 },
  'Кызылординская': { lat: 44.8, lon: 62.5 },
  'Мангистауская': { lat: 44.6, lon: 54.1 },
  'Павлодарская': { lat: 52.3, lon: 76.9 },
  'Северо-Казахстанская': { lat: 54.9, lon: 69.2 },
  'Туркестанская': { lat: 43.3, lon: 68.3 },
  'Восточно-Казахстанская': { lat: 49.9, lon: 82.6 },
  'Абайская': { lat: 48.9, lon: 80.2 }, // Approximate
  'Жетысуская': { lat: 45.5, lon: 79.0 }, // Approximate
  'Улытауская': { lat: 48.0, lon: 67.0 } // Approximate
};

async function initFloodLayer() {
  floodLayer.clearLayers();
  const regionNames = Object.keys(KZ_REGIONS);
  const lats = [];
  const lons = [];

  for (const coords of Object.values(KZ_REGIONS)) {
    lats.push(coords.lat);
    lons.push(coords.lon);
  }

  try {
    const rainUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&daily=precipitation_sum&forecast_days=3&timezone=auto`;
    const rainResp = await fetch(rainUrl);
    const rainData = await rainResp.json();

    // The API returns an array of objects if multiple coords are requested.
    // However, if only 1 location is requested, it returns a single object.
    // We should handle both, although KZ_REGIONS has multiple entries.
    const results = Array.isArray(rainData) ? rainData : [rainData];

    results.forEach((data, index) => {
        if (!data || !data.daily || !data.daily.precipitation_sum) return;

        const maxRain = Math.max(...data.daily.precipitation_sum);
        let risk = 'low';
        if (maxRain > 30) risk = 'high';
        else if (maxRain > 10) risk = 'medium';

        if (risk === 'low') return;

        const name = regionNames[index];
        const lat = lats[index];
        const lon = lons[index];

        let color = '#22c55e'; // Green
        let iconType = '🌧';
        if (risk === 'medium') { color = '#eab308'; } // Yellow
        if (risk === 'high') { color = '#ef4444'; iconType = '🌊'; } // Red

        const icon = L.divIcon({
          className: 'weather-icon',
          html: `<div style="background:${color}; color:white; border-radius:50%; width:24px; height:24px; text-align:center; line-height:24px; font-size:14px; border:1px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.2);">${iconType}</div>`
        });

        const marker = L.marker([lat, lon], { icon });

        const tooltipContainer = document.createElement('div');
        const line1 = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = `${iconType} ${name}`;
        line1.appendChild(b);

        const line2 = document.createElement('div');
        line2.textContent = `Осадки (макс 24ч): ${maxRain.toFixed(1)} мм`;

        const line3 = document.createElement('div');
        line3.style.marginTop = '5px';
        line3.style.fontSize = '0.8em';
        line3.style.color = '#555';
        line3.textContent = risk === 'high' ? '⚠️ Опасность паводка' : '⚠️ Сильный дождь';

        tooltipContainer.appendChild(line1);
        tooltipContainer.appendChild(line2);
        tooltipContainer.appendChild(line3);

        marker.bindTooltip(tooltipContainer, {
          className: 'risk-tooltip-flood',
          direction: 'top'
        });

        marker.addTo(floodLayer);
    });

  } catch (e) {
    console.warn('Meteo fetch failed', e);
  }
}


// ---- Regions (ADM1) ----
async function loadRegions() {
  const resp = await fetch('./kaz_adm1_simplified.geojson');
  regionsGeoJSON = await resp.json();
  renderRegions();
}

function precomputeSeismicRisk() {
  if (!regionsGeoJSON || !seismicZonesGeoJSON) return;
  // Simple check if region intersects any seismic zone
  // We need turf for this
  if (typeof turf === 'undefined' && !window.turf) return;
  const t = window.turf || turf;

  for (const region of regionsGeoJSON.features) {
    region.properties.hasSeismicRisk = false;
    for (const zone of seismicZonesGeoJSON.features) {
      // Very simple intersection check or centroid check to speed up if polygons are complex
      // turf.intersect can be slow.
      // Let's use booleanIntersects
      try {
          if (t.booleanIntersects(region, zone)) {
            region.properties.hasSeismicRisk = true;
            break;
          }
      } catch (e) {
          console.warn('Turf intersection error', e);
      }
    }
  }
}

function renderRegions() {
  if (!regionsGeoJSON) return;
  regionLayer.clearLayers();
  regionLayer.addData(regionsGeoJSON);
}

// ---- Seismic ----
async function loadSeismicZones() {
  const resp = await fetch('./kz_risk_zones.geojson');
  seismicZonesGeoJSON = await resp.json();
}

function renderSeismicLegend() {
  const el = document.getElementById('legendSeismic');
  el.classList.remove('hidden');
  el.innerHTML = `
    <div><b>Сейсмические зоны</b></div>
    <div class="row"><i style="background:#ef4444; opacity:0.4;"></i> Высокий риск</div>
    <div class="row"><i style="background:#6b7280; opacity:0.4;"></i> Низкий риск</div>
    <div style="margin-top:10px;"><b>Погода</b></div>
    <div class="row">🌧 Дождь (>10мм)</div>
    <div class="row">🌊 Паводок (>30мм)</div>
  `;
}

// ---- Earthquake Data ----
async function loadEarthquakeData() {
    try {
        const response = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson');
        const data = await response.json();

        let newEvents = data.features.filter(event => {
            return !earthquakeEvents.some(existing => existing.id === event.id);
        });

        // Use all events without distance filtering
        earthquakeEvents = data.features;

        renderEarthquakes();
        renderEarthquakeList();

        // Process ShakeMap for NEW events
        for (const event of newEvents) {
             if (event.properties.mag >= 5.0) {
                 processShakeMap(event.properties.detail);
             }
        }

    } catch (error) {
        console.error("Failed to load earthquake data:", error);
        showToast("Не удалось обновить данные о землетрясениях");
    }
}

function showToast(message) {
  let toast = document.getElementById('toast-notification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast-notification';
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #ef4444;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      z-index: 9999;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
    `;
    document.body.appendChild(toast);
  }
  toast.innerText = message;
  toast.style.opacity = '1';
  setTimeout(() => {
    toast.style.opacity = '0';
  }, 4000);
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function renderEarthquakes() {
    earthquakeLayer.clearLayers();
    earthquakeEvents.forEach(event => {
        const { geometry, properties } = event;
        if (geometry) {
            const [lon, lat] = geometry.coordinates;
            const magnitude = properties.mag;
            const marker = L.circleMarker([lat, lon], {
                pane: 'earthquakePane', 
                radius: magnitude * 1.5,
                color: '#ff0000',
                fillColor: '#ff0000',
                fillOpacity: 0.5,
                weight: 1,
                interactive: true 
            }).addTo(earthquakeLayer);
            const eventTime = new Date(properties.time).toLocaleString('ru-RU');

            const popupContent = document.createElement('div');

            const magB = document.createElement('b');
            magB.textContent = 'Магнитуда: ';
            popupContent.appendChild(magB);
            popupContent.appendChild(document.createTextNode(properties.mag));
            popupContent.appendChild(document.createElement('br'));

            const placeB = document.createElement('b');
            placeB.textContent = 'Местоположение: ';
            popupContent.appendChild(placeB);
            popupContent.appendChild(document.createTextNode(properties.place));
            popupContent.appendChild(document.createElement('br'));

            const timeB = document.createElement('b');
            timeB.textContent = 'Время: ';
            popupContent.appendChild(timeB);
            popupContent.appendChild(document.createTextNode(eventTime));
            popupContent.appendChild(document.createElement('br'));

            const link = document.createElement('a');
            link.href = properties.url;
            link.target = '_blank';
            link.textContent = 'Подробнее на USGS';
            popupContent.appendChild(link);

            marker.bindPopup(popupContent);
        }
    });
}

function renderEarthquakeList() {
    const el = document.getElementById('earthquakeList');
    el.innerHTML = '';
    if (!earthquakeEvents || earthquakeEvents.length === 0) {
        el.innerHTML = '<div style="padding:10px; color:#666;">Нет данных за последние 24ч</div>';
        return;
    }

    earthquakeEvents.forEach((event, index) => {
        const { geometry, properties } = event;
        const div = document.createElement('div');
        div.className = 'contract-card';
        const eventDate = new Date(properties.time).toLocaleDateString('ru-RU');
        const eventTime = new Date(properties.time).toLocaleTimeString('ru-RU');

        const row1 = document.createElement('div');
        const magB = document.createElement('b');
        magB.textContent = `M ${properties.mag}`;
        row1.appendChild(magB);
        row1.appendChild(document.createTextNode(` - ${properties.place}`));

        const row2 = document.createElement('div');
        row2.className = 'meta';
        row2.textContent = `${eventDate} ${eventTime}`;

        div.appendChild(row1);
        div.appendChild(row2);

        div.addEventListener('click', () => {
            const [lon, lat] = geometry.coordinates;
            map.flyTo([lat, lon], 7);
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
        listEl.classList.remove('collapsed');
        iconEl.classList.add('rotated');
    }
});

async function processShakeMap(detailUrl) {
    try {
        const response = await fetch(detailUrl);
        const eventDetail = await response.json();

        if (!eventDetail.properties || !eventDetail.properties.products || !eventDetail.properties.products.shakemap) {
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

        L.geoJSON(intensityData, {
            style: function(feature) {
                const intensity = feature.properties.value;
                return {
                    fillColor: getIntensityColor(intensity),
                    fillOpacity: 0.5,
                    weight: 0
                };
            }
        }).addTo(earthquakeLayer); // Add to earthquake layer group so it can be toggled
    } catch (error) {
        console.error("Ошибка при отображении ShakeMap:", error);
    }
}

function setupLayerControl() {
    const baseLayers = {
        "OpenStreetMap": osmLayer
    };

    const overlayLayers = {
        "Регионы": regionLayer,
        "Землетрясения (USGS)": earthquakeLayer,
        "💧 Погода (Open-Meteo)": floodLayer
    };

    L.control.layers(baseLayers, overlayLayers, { collapsed: false }).addTo(map);
}

// ---- Init ----
async function init() {
  osmLayer.addTo(map);
  regionLayer.addTo(map);
  earthquakeLayer.addTo(map);
  floodLayer.addTo(map);

  // Default load
  await Promise.all([
      loadRegions(),
      loadSeismicZones(),
      loadEarthquakeData(),
      initFloodLayer()
  ]);

  await ensureLibraryLoaded('turf', LIBS.turf);
  precomputeSeismicRisk();
  renderRegions(); // re-render with risk colors
  renderSeismicLegend();
  setupLayerControl();

  // Auto-refresh earthquakes
  setInterval(loadEarthquakeData, 10 * 60 * 1000);
}

init();

