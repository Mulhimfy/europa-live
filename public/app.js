/* Europa Live — frontend. Vanilla ES module, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso, tz) => { if (!iso) return '—'; try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return String(iso).slice(11, 16); } };
const fmtDate = (iso, tz) => { if (!iso) return '—'; try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return iso; } };
const ago = (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); if (s < 60) return `${Math.round(s)}s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`; };
const km = (v) => v == null ? '' : v < 1 ? `${Math.round(v * 1000)} m` : `${v.toFixed(v < 10 ? 1 : 0)} km`;
const compass = (d) => d == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
const EUROPE = { minLat: 27.5, maxLat: 82, minLon: -32, maxLon: 60 };
const inEurope = (lat, lon) => lat >= EUROPE.minLat && lat <= EUROPE.maxLat && lon >= EUROPE.minLon && lon <= EUROPE.maxLon;

const state = { map: null, es: null, point: null, place: null, tz: null, results: {}, timers: new Set(), sat: null, layerMeta: null, layers: {}, base: 'dark', scrub: { frames: [], i: 0, playing: false, timer: null }, hereMarker: null };

// ------------------------------------------------------------------ sections
const SECTIONS = [
  { id: 'cams', tier: 'Cameras', title: 'Live cameras', icon: '📹' },
  { id: 'satellite', tier: 'Sky', title: 'Satellite, right now', icon: '🛰️' },
  { id: 'weather', tier: 'Now', title: 'On the ground now', icon: '🌡️' },
  { id: 'flights', tier: 'Air', title: 'Aircraft overhead', icon: '✈️' },
  { id: 'ships', tier: 'Sea', title: 'Vessels nearby', icon: '🚢' },
  { id: 'alerts', tier: 'Earth', title: 'Warnings & hazards', icon: '⚠️' },
  { id: 'quakes', tier: 'Earth', title: 'Seismic activity', icon: '🌍' },
  { id: 'fires', tier: 'Earth', title: 'Active fires', icon: '🔥' },
  { id: 'photos', tier: 'Latest', title: 'Latest photos', icon: '🖼️' },
  { id: 'news', tier: 'Latest', title: 'Latest headlines', icon: '📰' },
];
const TIERS = [...new Set(SECTIONS.map((s) => s.tier))];

function buildPanelSkeleton() {
  const body = $('#p-body'); body.innerHTML = '';
  const tiers = $('#tiers'); tiers.innerHTML = '';
  for (const t of TIERS) { const b = el('button', '', `${esc(t)} <span class="n" data-tier-n="${t}"></span>`); b.onclick = () => { const first = SECTIONS.find((s) => s.tier === t); $(`#sec-${first.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }; tiers.appendChild(b); }
  for (const s of SECTIONS) {
    const sec = el('section', 'section'); sec.id = 'sec-' + s.id; sec.dataset.tier = s.tier;
    sec.innerHTML = `<div class="section-h"><span>${s.icon}</span><h3>${esc(s.title)}</h3><span class="fresh" data-fresh></span></div><div class="section-c"><div class="skel-row"><div class="skel"></div><div class="skel"></div></div></div>`;
    body.appendChild(sec);
  }
}
function setFresh(id, { live, text, ms }) {
  const f = $(`#sec-${id} [data-fresh]`); if (!f) return;
  f.className = 'fresh' + (live ? ' live' : '');
  f.innerHTML = `${esc(text || '')}${ms != null ? ` <span class="lat">${ms} ms</span>` : ''}`;
}
function content(id) { return $(`#sec-${id} .section-c`); }
function fail(id, msg) { const c = content(id); if (c) c.innerHTML = `<div class="err">${esc(msg || 'unavailable right now')}</div>`; setFresh(id, { text: 'failed' }); }
function attrib(txt) { return txt ? `<div class="attrib">Source: ${esc(txt)}</div>` : ''; }
function tierCount(id, n) { const s = SECTIONS.find((x) => x.id === id); const e = $(`[data-tier-n="${s.tier}"]`); if (!e) return; e.dataset[id] = n; e.textContent = Object.keys(e.dataset).reduce((a, k) => a + (+e.dataset[k] || 0), 0) || ''; }

// ------------------------------------------------------------------ selection & stream
async function select(lat, lon, { fly = true, zoom } = {}) {
  lat = +lat.toFixed(5); lon = +lon.toFixed(5);
  if (!inEurope(lat, lon)) return toast('Europa Live covers Europe — pick a point on the continent.');
  state.es?.close(); for (const t of state.timers) clearInterval(t); state.timers.clear(); state.flightsPanelTimer = null; stopSatLoop();
  state.point = { lat, lon }; state.results = {};
  history.replaceState(null, '', `#@${lat},${lon},${(zoom || Math.max(state.map.getZoom(), 9)).toFixed(1)}z`);
  $('#hint').classList.add('hide');
  placeHere(lat, lon);
  if (fly) state.map.flyTo({ center: [lon, lat], zoom: Math.max(state.map.getZoom(), zoom || 11), speed: 1.4, curve: 1.3, essential: true });
  $('#panel').classList.add('open');
  $('#p-name').textContent = 'Fetching…'; $('#p-sub').textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`; $('#p-flag').textContent = ''; $('#p-meta').innerHTML = '';
  buildPanelSkeleton();
  clearGeo('quakes-src'); clearGeo('cams-src');
  const t0 = performance.now();
  const es = new EventSource(`/api/live?lat=${lat}&lon=${lon}`);
  state.es = es;
  es.addEventListener('meta', (e) => { const m = JSON.parse(e.data); state.place = m.place; state.tz = m.place?.tz; renderHead(m.place, null); const enabled = new Set(m.providers); for (const s of SECTIONS) if (!enabled.has(s.id)) disabledSection(s.id); });
  for (const id of [...SECTIONS.map((s) => s.id), 'place', 'radar']) es.addEventListener(id, (e) => { const r = JSON.parse(e.data); state.results[r.id] = r; try { render(r); } catch (err) { console.error(r.id, err); fail(r.id, 'render error: ' + err.message); } });
  es.addEventListener('done', () => { es.close(); $('#net').textContent = `all sources ${Math.round(performance.now() - t0)} ms`; $('#net').className = 'pill ok'; });
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) return; $('#net').textContent = 'stream error'; $('#net').className = 'pill err'; };
}
function disabledSection(id) {
  const hints = { ships: 'Live vessel tracking needs a free <code>AISSTREAM_KEY</code> on the server.' };
  const c = content(id); if (c) c.innerHTML = `<div class="key-hint">${hints[id] || 'Not enabled on this server.'}</div>`; setFresh(id, { text: 'off' });
}
function render(r) {
  if (r.id === 'place') { if (r.ok) { state.place = { ...state.place, ...r.data }; renderHead(state.place, r.data); } return; }
  if (r.id === 'radar') { renderRadarLine(); return; }
  if (!r.ok) return fail(r.id, r.error);
  const fn = renderers[r.id]; if (fn) fn(r.data, r);
}

function renderHead(p, detail) {
  const name = detail?.name || detail?.locality || p?.nearestCity?.name || 'Somewhere in Europe';
  $('#p-name').textContent = name;
  $('#p-flag').textContent = p?.flag || '';
  const parts = [detail?.locality && detail.locality !== name ? detail.locality : null, detail?.region, p?.country].filter(Boolean);
  const nc = p?.nearestCity; const near = nc && nc.name !== name && nc.name !== detail?.locality ? `${km(nc.distanceM / 1000)} ${compass(nc.bearing)} of ${nc.name}` : '';
  $('#p-sub').textContent = [parts.join(', '), near].filter(Boolean).join(' · ') || `${state.point.lat}, ${state.point.lon}`;
  const d = p?.daylight; const m = p?.moon;
  $('#p-meta').innerHTML = [
    `<span class="tag"><b>${esc(p?.localTime || '')}</b> local</span>`,
    d ? `<span class="tag ${d.isDay ? 'day' : 'night'}">${d.isDay ? '☀️' : '🌙'} ${esc(d.phase)}${d.altitude != null ? ` · sun ${d.altitude}°` : ''}</span>` : '',
    p?.sun?.sunrise ? `<span class="tag">↑ ${esc(p.sun.sunrise)} ↓ ${esc(p.sun.sunset)}</span>` : (p?.sun?.polar ? `<span class="tag">polar ${esc(p.sun.polar)}</span>` : ''),
    m ? `<span class="tag" title="${esc(m.name)}">${moonIcon(m.phase)} ${Math.round(m.illumination * 100)}%</span>` : '',
  ].join('');
}
const moonIcon = (ph) => ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][Math.round(ph * 8) % 8];

// ------------------------------------------------------------------ renderers
const renderers = {
  cams(d, r) {
    tierCount('cams', d.count);
    setFresh('cams', { live: d.withVideo > 0, text: d.withVideo ? `${d.withVideo} live video` : `${d.count} cams`, ms: r.ms });
    const c = content('cams');
    if (!d.count) { c.innerHTML = `<div class="note">No public cameras within ${d.radiusKm} km. Try a nearby city, a motorway, a coast or a ski area.</div>${camSources(d.sources)}${moreCams(d.more)}`; return; }
    const cams = d.cams; const grid = el('div', 'cams');
    const show = (n) => { grid.innerHTML = ''; cams.slice(0, n).forEach((cam, i) => grid.appendChild(camCard(cam, i === 0 && !!cam.image))); };
    show(12);
    c.innerHTML = ''; c.appendChild(grid);
    if (cams.length > 12) { const more = el('button', 'cam-more', `Show all ${cams.length} cameras`); more.onclick = () => { show(cams.length); more.remove(); }; c.appendChild(more); }
    c.insertAdjacentHTML('beforeend', camSources(d.sources) + moreCams(d.more));
    plotCams(cams);
  },
  satellite(d, r) {
    setFresh('satellite', { live: true, text: d.geocolour ? `frame ${fmtTime(d.geocolour.latest, state.tz)}` : 'daily', ms: r.ms });
    const c = content('satellite');
    c.innerHTML = '';
    if (d.geocolour?.frames?.length) {
      const box = el('div', 'sat');
      box.innerHTML = `<img alt="Meteosat view of the area right now"><div class="cross"></div><div class="lbl">${esc(d.geocolour.satellite)} · <b data-t>${fmtTime(d.geocolour.latest, state.tz)}</b> · 600 km</div><div class="ctrl"><button class="play" aria-label="Play/pause">❚❚</button><input type="range" min="0" max="${d.geocolour.frames.length - 1}" value="${d.geocolour.frames.length - 1}" aria-label="Frame"></div>`;
      c.appendChild(box);
      startSatLoop(box, d.geocolour.frames);
      c.insertAdjacentHTML('beforeend', `<div class="note">Every ${d.geocolour.cadenceMin} minutes from geostationary orbit. Daylight shows true colour; at night city lights glow and clouds appear blue. Turn on the <b>Clouds</b> layer to see it on the map.</div>`);
    }
    const grid = el('div', 'sat-grid');
    if (d.sentinel3) grid.appendChild(satTile(d.sentinel3.url, `Sentinel-3 · ${d.sentinel3.day}`, '160 km · 300 m/px', 'Daily true colour, Copernicus Sentinel-3'));
    if (d.viirs) grid.appendChild(satTile(d.viirs.url, `${d.viirs.satellite} · ${d.viirs.day}`, '160 km · 375 m/px', 'Daily true colour, NASA VIIRS'));
    if (d.infrared) grid.appendChild(satTile(d.infrared.url, `Infrared · ${fmtTime(d.infrared.latest, state.tz)}`, '600 km · thermal', 'Meteosat thermal infrared: works in darkness, bright = cold cloud tops'));
    c.appendChild(grid);
    renderRadarLine();
    c.insertAdjacentHTML('beforeend', attrib(d.attribution));
  },
  weather(d, r) {
    setFresh('weather', { live: false, text: `obs ${String(d.observedAt || '').slice(11, 16)} local`, ms: r.ms });
    const n = d.now; const c = content('weather');
    const aqCls = d.air ? (d.air.aqi <= 20 ? 'good' : d.air.aqi <= 40 ? 'fair' : d.air.aqi <= 80 ? 'poor' : 'bad') : '';
    c.innerHTML = `
      <div class="now"><div class="icon">${n.icon}</div><div><div class="temp">${Math.round(n.temp)}<small>°C</small></div></div>
        <div></div><div><div class="desc">${esc(n.text)}</div><div class="feels">feels ${Math.round(n.feels)}° · ${n.humidity}% humidity · cloud ${n.cloud}%</div></div></div>
      <div class="grid">
        <div class="stat"><div class="k">Wind</div><div class="v">${Math.round(n.wind)}<small> km/h ${compass(n.windDir)}</small></div></div>
        <div class="stat"><div class="k">Gusts</div><div class="v">${Math.round(n.gusts)}<small> km/h</small></div></div>
        <div class="stat"><div class="k">Rain now</div><div class="v">${n.precip ?? 0}<small> mm</small></div></div>
        <div class="stat"><div class="k">Visibility</div><div class="v">${n.visibility != null ? (n.visibility / 1000).toFixed(n.visibility < 10000 ? 1 : 0) : '—'}<small> km</small></div></div>
        <div class="stat"><div class="k">Pressure</div><div class="v">${Math.round(n.pressure)}<small> hPa</small></div></div>
        <div class="stat"><div class="k">UV</div><div class="v">${n.uv != null ? n.uv.toFixed(1) : '—'}<small> / max ${d.uvMax ?? '—'}</small></div></div>
        ${d.air ? `<div class="stat ${aqCls}"><div class="k">Air (EAQI)</div><div class="v">${d.air.aqi}<small> ${esc(d.air.band)}</small></div><div class="gauge"><i style="width:${Math.min(100, d.air.aqi)}%"></i></div></div>
        <div class="stat"><div class="k">PM2.5 / PM10</div><div class="v">${d.air.pm25?.toFixed(0) ?? '—'}<small> / ${d.air.pm10?.toFixed(0) ?? '—'} µg</small></div></div>` : ''}
        ${d.sea ? `<div class="stat"><div class="k">Sea</div><div class="v">${d.sea.sst?.toFixed(1) ?? '—'}<small> °C water</small></div></div>
        <div class="stat"><div class="k">Waves</div><div class="v">${d.sea.waveHeight?.toFixed(1) ?? '—'}<small> m ${compass(d.sea.waveDir)} · ${d.sea.wavePeriod ?? '—'} s</small></div></div>` : ''}
      </div>
      ${sparkline(d.hourly)}
      ${attrib(d.attribution)}`;
  },
  flights(d, r) {
    tierCount('flights', d.airborne);
    setFresh('flights', { live: true, text: `${d.airborne} airborne · ${d.count} tracked`, ms: r.ms });
    const c = content('flights');
    if (!d.aircraft.length) c.innerHTML = `<div class="note">No aircraft within ${d.radiusKm} km right now.</div>${attrib(d.attribution)}`;
    else {
      c.innerHTML = `<div class="list">${d.aircraft.slice(0, 10).map(planeItem).join('')}</div><div class="note">Positions are seconds old (ADS-B). Turn on the <b>Aircraft</b> layer to watch them move on the map.</div>${attrib(d.attribution)}`;
      c.querySelectorAll('[data-ll]').forEach((e) => { e.onclick = () => { const [la, lo] = e.dataset.ll.split(','); state.map.flyTo({ center: [+lo, +la], zoom: Math.max(state.map.getZoom(), 9) }); toggleLayer('flights', true); }; });
    }
    if (!state.flightsPanelTimer) {
      state.flightsPanelTimer = setInterval(async () => { if (document.hidden || !state.point) return; try { const j = await (await fetch(`/api/p/flights?lat=${state.point.lat}&lon=${state.point.lon}`)).json(); if (j.ok) renderers.flights(j.data, j); } catch {} }, 10000);
      state.timers.add(state.flightsPanelTimer);
    }
  },
  ships(d, r) {
    tierCount('ships', d.count);
    setFresh('ships', { live: true, text: `${d.count} within ${d.radiusKm} km`, ms: r.ms });
    const c = content('ships');
    if (!d.status?.connected && !d.count) { c.innerHTML = `<div class="note">AIS feed ${d.status?.connected ? 'connected' : 'connecting'}… ${d.status?.vessels || 0} vessels tracked across Europe so far.</div>`; return; }
    if (!d.count) { c.innerHTML = `<div class="note">No vessels within ${d.radiusKm} km — probably not a coastal or river place.</div>${attrib(d.attribution)}`; return; }
    c.innerHTML = `<div class="list">${d.vessels.slice(0, 10).map((v) => `<div class="item" data-ll="${v.lat},${v.lon}"><div class="ic">🚢</div><div class="b"><div class="t">${esc(v.name || 'MMSI ' + v.mmsi)}</div><div class="s">${esc(v.typeName || 'vessel')}${v.destination ? ' → ' + esc(v.destination) : ''}${v.lengthM ? ' · ' + v.lengthM + ' m' : ''}</div></div><div class="r"><b>${km(v.distanceKm)}</b>${v.sog != null ? v.sog.toFixed(1) + ' kn' : ''} ${compass(v.cog)}</div></div>`).join('')}</div>${attrib(d.attribution)}`;
    c.querySelectorAll('[data-ll]').forEach((e) => { e.onclick = () => { const [la, lo] = e.dataset.ll.split(','); state.map.flyTo({ center: [+lo, +la], zoom: Math.max(state.map.getZoom(), 11) }); toggleLayer('ships', true); }; });
  },
  quakes(d, r) {
    tierCount('quakes', d.last24h);
    setFresh('quakes', { live: false, text: `${d.last24h} in 24 h · ${d.count} in 30 d`, ms: r.ms });
    const c = content('quakes');
    if (!d.count) { c.innerHTML = `<div class="ok-line">No earthquakes recorded within ${d.radiusKm} km in the last 30 days.</div>${attrib(d.attribution)}`; return; }
    c.innerHTML = `<div class="list">${d.events.slice(0, 8).map((q) => `<a class="item" href="${esc(q.url)}" target="_blank" rel="noopener"><div class="ic q ${q.mag >= 4 ? 'big' : ''}">${q.mag != null ? q.mag.toFixed(1) : '?'}</div><div class="b"><div class="t">${esc(q.place || 'Unnamed event')}</div><div class="s">${fmtDate(q.time, state.tz)} · ${q.depthKm != null ? q.depthKm.toFixed(0) + ' km deep' : ''} · ${esc((q.sources || []).join('+'))}</div></div><div class="r"><b>${km(q.distanceKm)}</b>${ago(q.time)}</div></a>`).join('')}</div>${attrib(d.attribution)}`;
    setGeo('quakes-src', d.events.map((q) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon, q.lat] }, properties: { mag: q.mag || 0, title: `M${(q.mag || 0).toFixed(1)} ${q.place || ''}`, time: q.time } })));
  },
  fires(d, r) {
    const n = d.count ?? 0; tierCount('fires', n);
    setFresh('fires', { live: false, text: d.source ? `${n} detections · 24 h` : 'map layer', ms: r.ms });
    const c = content('fires');
    if (d.detections && d.detections.length) c.innerHTML = `<div class="list">${d.detections.slice(0, 8).map((f) => `<div class="item" data-ll="${f.lat},${f.lon}"><div class="ic" style="background:rgba(255,90,95,.15);color:var(--red)">🔥</div><div class="b"><div class="t">Hotspot ${f.frp != null ? f.frp.toFixed(0) + ' MW' : ''}</div><div class="s">${f.time ? fmtDate(f.time, state.tz) : ''} · ${esc(f.satellite || '')} · ${esc(String(f.confidence || ''))}</div></div><div class="r"><b>${km(f.distanceKm)}</b></div></div>`).join('')}</div>`;
    else if (d.detections) c.innerHTML = `<div class="ok-line">No satellite fire detections within ${d.radiusKm} km in the last 24 h.</div>`;
    else c.innerHTML = `<div class="note">${esc(d.note || 'Hotspot list unavailable')}</div>`;
    c.insertAdjacentHTML('beforeend', `<div class="note">Turn on the <b>Fires</b> layer for live 10-minute fire radiative power from Meteosat and 24 h VIIRS hotspots.</div>${attrib(d.attribution)}`);
    c.querySelectorAll('[data-ll]').forEach((e) => { e.onclick = () => { const [la, lo] = e.dataset.ll.split(','); state.map.flyTo({ center: [+lo, +la], zoom: 11 }); toggleLayer('fires', true); }; });
  },
  alerts(d, r) {
    const n = d.local.length + d.gdacs.length; tierCount('alerts', n);
    setFresh('alerts', { live: false, text: d.maxLevel !== 'none' && d.maxLevel !== 'green' ? `${d.maxLevel} warning` : 'no local warning', ms: r.ms });
    const c = content('alerts');
    let h = '';
    if (d.local.length) h += d.local.map((w) => `<div class="alert ${w.level}"><div class="t"><span class="lv"></span>${esc(w.event)}</div><div class="d">${esc(w.description || '')}</div><div class="m">${esc(w.areas.slice(0, 3).join(', '))} · until ${fmtDate(w.expires, state.tz)} · ${esc(w.sender || '')}</div></div>`).join('');
    else h += `<div class="ok-line">${d.meteoalarmCovered ? `No official weather warning for this area${d.countryCount ? ` (${d.countryCount} elsewhere in ${esc(d.country)})` : ''}.` : 'This country is not covered by Meteoalarm.'}</div>`;
    if (d.gdacs.length) h += `<div class="list" style="margin-top:8px">${d.gdacs.slice(0, 4).map((g) => `<a class="item" href="${esc(g.url)}" target="_blank" rel="noopener"><div class="ic" style="color:var(--${g.level === 'red' ? 'red' : g.level === 'orange' ? 'orange' : 'green'})">${{ EQ: '🌍', TC: '🌀', FL: '🌊', VO: '🌋', WF: '🔥', DR: '☀️' }[g.type] || '⚠️'}</div><div class="b"><div class="t">${esc(g.name)}</div><div class="s">GDACS ${esc(g.level)} · ${esc(g.country || '')}</div></div><div class="r"><b>${km(g.distanceKm)}</b></div></a>`).join('')}</div>`;
    if (d.eonet.length) h += `<div class="list" style="margin-top:8px">${d.eonet.slice(0, 4).map((e) => `<a class="item" href="${esc(e.url)}" target="_blank" rel="noopener"><div class="ic">🛰️</div><div class="b"><div class="t">${esc(e.title)}</div><div class="s">NASA EONET · ${esc(e.category || '')}</div></div><div class="r"><b>${km(e.distanceKm)}</b></div></a>`).join('')}</div>`;
    c.innerHTML = h + attrib(d.attribution);
  },
  photos(d, r) {
    setFresh('photos', { text: d.photos[0]?.taken ? `newest ${ago(d.photos[0].taken)}` : `${d.count}`, ms: r.ms });
    const c = content('photos');
    if (!d.count) { c.innerHTML = `<div class="note">No geotagged photos within 1.5 km yet.</div>`; return; }
    c.innerHTML = `<div class="photos">${d.photos.slice(0, 12).map((p, i) => `<div class="photo" data-i="${i}" title="${esc(p.title)}"><img src="${esc(p.thumb)}" alt="${esc(p.title)}" loading="lazy" referrerpolicy="no-referrer"><div class="d">${p.taken ? esc(p.taken.slice(0, 10)) : ''}</div></div>`).join('')}</div><div class="note">${d.mapillary ? 'Street-level imagery (Mapillary) and Commons photos, newest first.' : 'Newest geotagged Commons photos first. Add a <code>MAPILLARY_TOKEN</code> for recent street-level captures.'}</div>${attrib(d.attribution)}`;
    c.querySelectorAll('.photo').forEach((e) => { e.onclick = () => { const p = d.photos[+e.dataset.i]; lightbox({ image: p.thumb.replace(/\/(\d+)px-/, '/1600px-'), title: p.title, sub: `${p.taken ? fmtDate(p.taken, state.tz) : ''} · ${p.author || ''} · ${p.license || ''}`, page: p.url }); }; });
  },
  news(d, r) {
    setFresh('news', { text: d.items[0]?.published ? ago(d.items[0].published) : '', ms: r.ms });
    const c = content('news');
    if (!d.items.length) { c.innerHTML = `<div class="note">No recent headlines mention ${esc(d.query || 'this place')}.</div>`; return; }
    c.innerHTML = `<div class="list news">${d.items.slice(0, 8).map((i) => `<a class="item" href="${esc(i.link)}" target="_blank" rel="noopener"><div class="b"><div class="t">${esc(i.title)}</div><div class="s">${esc(i.source || '')} · ${ago(i.published)}</div></div></a>`).join('')}</div>${attrib(d.attribution)}`;
  },
};

function planeItem(a) {
  const rot = a.track != null ? a.track : 0;
  return `<div class="item" data-ll="${a.lat},${a.lon}"><div class="ic"><svg viewBox="0 0 24 24" fill="currentColor" style="transform:rotate(${rot}deg)"><path d="M12 2 9 9l-7 4v2l7-2v5l-2 2v1l4-1 4 1v-1l-2-2v-5l7 2v-2l-7-4-2-7z"/></svg></div><div class="b"><div class="t">${esc(a.callsign || a.registration || a.hex.toUpperCase())}${a.type ? ` <span style="color:var(--fg-3);font-weight:500">${esc(a.type)}</span>` : ''}</div><div class="s">${a.onGround ? 'on the ground' : `${a.altFt != null ? Math.round(a.altFt / 100) * 100 + ' ft' : '—'} · ${a.groundSpeedKt != null ? Math.round(a.groundSpeedKt) + ' kt' : ''} ${a.verticalRateFpm > 300 ? '↗' : a.verticalRateFpm < -300 ? '↘' : '→'}`}${a.emergency ? ' · ⚠ ' + esc(a.emergency) : ''}</div></div><div class="r"><b>${km(a.distanceKm)}</b>${compass(a.bearing)}</div></div>`;
}
function sparkline(hourly) {
  if (!hourly?.length) return '';
  const w = 400, h = 64, pad = 14; const temps = hourly.map((x) => x.temp); const min = Math.min(...temps), max = Math.max(...temps); const span = Math.max(2, max - min);
  const x = (i) => pad + (i / (hourly.length - 1)) * (w - pad * 2); const y = (t) => 10 + (1 - (t - min) / span) * (h - 30);
  const path = temps.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t).toFixed(1)}`).join(' ');
  const bars = hourly.map((p, i) => p.pop > 0 ? `<rect x="${(x(i) - 3).toFixed(1)}" y="${(h - 18 - (p.pop / 100) * 22).toFixed(1)}" width="6" height="${((p.pop / 100) * 22).toFixed(1)}" rx="2" fill="rgba(56,214,255,.45)"/>` : '').join('');
  const labels = hourly.map((p, i) => i % 4 === 0 ? `<text x="${x(i).toFixed(1)}" y="${h - 4}" text-anchor="middle">${p.t.slice(11, 13)}h</text>` : '').join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Next 24 hours">${bars}<path d="${path}" fill="none" stroke="#ffb454" stroke-width="2" stroke-linejoin="round"/><text x="${pad}" y="9">${Math.round(max)}°</text><text x="${w - pad}" y="9" text-anchor="end">${Math.round(min)}°</text>${labels}</svg>`;
}
function moreCams(links) {
  if (!links?.length) return '';
  return `<div class="cam-sources more"><span class="tag" style="border:0;background:none;padding-left:0">More live cams:</span>${links.map((l) => `<a class="tag" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>`;
}
function camSources(src) {
  if (!src) return '';
  return `<div class="cam-sources">${Object.entries(src).map(([id, s]) => `<span class="tag ${s.ok ? '' : 'off'}" title="${esc(s.error || '')}">${esc(s.label)} <b>${s.ok ? s.count : '✕'}</b></span>`).join('')}</div>`;
}
function camCard(cam, wide) {
  const card = el('div', 'cam' + (wide ? ' wide' : ''));
  const badge = cam.live && (cam.video || cam.embed) ? '<span class="badge live">LIVE</span>' : cam.kind === 'traffic' ? '<span class="badge">CCTV</span>' : cam.kind === 'video' ? '<span class="badge video">VIDEO</span>' : '<span class="badge">CAM</span>';
  const dist = cam.distanceKm != null ? `<span class="dist">${km(cam.distanceKm)}</span>` : '';
  if (cam.image) {
    card.innerHTML = `<img alt="${esc(cam.title)}" loading="lazy" referrerpolicy="no-referrer">${badge}${dist}<div class="cap">${esc(cam.title)}<small>${esc(cam.source)}${cam.updated ? ' · ' + ago(cam.updated) : ''}</small></div>`;
    const img = $('img', card);
    const load = () => { img.classList.add('loading'); img.src = bust(cam.image); };
    img.onload = () => img.classList.remove('loading');
    img.onerror = () => { img.remove(); card.insertAdjacentHTML('afterbegin', `<div class="noimg"><div><div class="big">📷</div>image unavailable</div></div>`); };
    load();
    if (cam.refreshSec > 0 && cam.kind !== 'video') { const t = setInterval(() => { if (!card.isConnected) return clearInterval(t); if (!document.hidden) load(); }, Math.max(20, cam.refreshSec) * 1000); state.timers.add(t); }
  } else {
    let host = cam.host || ''; try { if (!host && cam.page) host = new URL(cam.page).hostname.replace(/^www\./, ''); } catch {}
    card.innerHTML = `<div class="noimg"><div><div class="big">${cam.kind === 'video' ? '▶️' : '🎥'}</div>${esc(cam.live ? 'Live stream' : 'Camera page')}<br><small>${esc(host)}</small></div></div>${badge}${dist}<div class="cap">${esc(cam.title)}<small>${esc(cam.source)}</small></div>`;
  }
  card.onclick = () => openCam(cam);
  return card;
}
const bust = (u) => u + (u.includes('?') ? '&' : '?') + '_t=' + Math.floor(Date.now() / 1000);
function openCam(cam) {
  if (cam.embed) return lightbox({ iframe: cam.embed, title: cam.title, sub: `${cam.source}${cam.updated ? ' · updated ' + ago(cam.updated) : ''}`, page: cam.page });
  if (cam.video && /\.(mp4|webm)(\?|$)/i.test(cam.video)) return lightbox({ video: cam.video, title: cam.title, sub: cam.source, page: cam.page });
  if (cam.image) return lightbox({ image: cam.image, refresh: cam.refreshSec, title: cam.title, sub: `${cam.source}${cam.updated ? ' · updated ' + ago(cam.updated) : ''}${cam.distanceKm != null ? ' · ' + km(cam.distanceKm) + ' away' : ''}`, page: cam.page || cam.video });
  if (cam.video || cam.page) window.open(cam.video || cam.page, '_blank', 'noopener');
}
function satTile(url, label, scale, note) {
  const t = el('div', 'sat'); t.title = note;
  t.innerHTML = `<img src="${esc(url)}" alt="${esc(note)}" loading="lazy"><div class="cross"></div><div class="lbl">${esc(label)}</div><div class="scale">${esc(scale)}</div>`;
  t.onclick = () => lightbox({ image: url, title: label, sub: note });
  return t;
}
function renderRadarLine() {
  const r = state.results.radar; const c = content('satellite'); if (!c || !r || !state.results.satellite) return;
  let line = $('.radar-line', c); if (!line) { line = el('div', 'sky-row radar-line'); const at = $('.attrib', c); at ? c.insertBefore(line, at) : c.appendChild(line); }
  if (!r.ok) { line.innerHTML = `<span>Rain radar unavailable</span>`; return; }
  line.innerHTML = `<span>🌧️ Rain radar frame <b>${fmtTime(r.data.latest, state.tz)}</b> · every ${r.data.cadenceMin} min</span> <button class="chip" data-toggle="radar"><span class="sw" style="--c:#38d6ff"></span>Show on map</button>`;
  $('[data-toggle]', line).onclick = () => toggleLayer('radar', true);
}
// satellite loop (panel)
function startSatLoop(box, frames) {
  stopSatLoop();
  const img = $('img', box), range = $('input', box), play = $('.play', box), lbl = $('[data-t]', box);
  const cache = frames.map((f) => { const i = new Image(); i.decoding = 'async'; i.src = f.url; return i; });
  let i = frames.length - 1, playing = true;
  const show = (n) => { i = n; img.src = frames[n].url; range.value = n; lbl.textContent = fmtTime(frames[n].time, state.tz); };
  show(i);
  const timer = setInterval(() => { if (!playing || document.hidden) return; const n = (i + 1) % frames.length; if (cache[n].complete) show(n); }, 700);
  range.oninput = () => { playing = false; play.textContent = '▶'; show(+range.value); };
  play.onclick = () => { playing = !playing; play.textContent = playing ? '❚❚' : '▶'; };
  state.sat = { timer };
}
function stopSatLoop() { if (state.sat) { clearInterval(state.sat.timer); state.sat = null; } }

// ------------------------------------------------------------------ lightbox
function lightbox({ image, video, iframe, refresh, title, sub, page }) {
  const lb = $('#lightbox'), fr = $('#lb-frame'); fr.innerHTML = '';
  if (iframe) { const f = el('iframe'); f.src = iframe; f.allow = 'autoplay; fullscreen; picture-in-picture'; f.referrerPolicy = 'strict-origin-when-cross-origin'; f.setAttribute('allowfullscreen', ''); fr.appendChild(f); }
  else if (video) { const v = el('video'); v.src = video; v.controls = true; v.autoplay = true; v.muted = true; v.playsInline = true; v.loop = true; fr.appendChild(v); }
  else if (image) { const im = el('img'); im.src = refresh ? bust(image) : image; im.alt = title || ''; im.referrerPolicy = 'no-referrer'; fr.appendChild(im); if (refresh) { const tag = el('div', 'refresh', 'auto-refresh'); fr.appendChild(tag); const t = setInterval(() => { if (lb.hidden) return clearInterval(t); im.src = bust(image); tag.textContent = 'refreshed ' + new Date().toLocaleTimeString(); }, Math.max(15, refresh) * 1000); } }
  $('#lb-cap').innerHTML = `<b>${esc(title || '')}</b> ${esc(sub || '')}${page ? `<a href="${esc(page)}" target="_blank" rel="noopener">open source ↗</a>` : ''}`;
  lb.hidden = false;
}
function closeLightbox() { $('#lightbox').hidden = true; $('#lb-frame').innerHTML = ''; }
$('#lb-close').onclick = closeLightbox;
$('#lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLightbox(); });

// ------------------------------------------------------------------ map
const WMS = (layer, time) => `https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(layer)}&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512&format=image/png&transparent=true${time ? '&time=' + encodeURIComponent(time) : ''}`;
const LIVE_LAYERS = [
  { id: 'cams', label: 'Cameras', color: '#ffb454' },
  { id: 'clouds', label: 'Clouds', color: '#cfe6ff' },
  { id: 'radar', label: 'Rain', color: '#38d6ff' },
  { id: 'lightning', label: 'Lightning', color: '#ffe066' },
  { id: 'fires', label: 'Fires', color: '#ff5a5f' },
  { id: 'flights', label: 'Aircraft', color: '#7c5cff' },
  { id: 'ships', label: 'Ships', color: '#3ddc97' },
  { id: 'quakes', label: 'Quakes', color: '#ff8a3d' },
];
function initMap() {
  const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/dark', center: [10, 50], zoom: 3.6, minZoom: 2.5, maxZoom: 19, attributionControl: false, maxBounds: [[-60, 20], [80, 84]], hash: false, pitchWithRotate: false, dragRotate: false, touchPitch: false });
  state.map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => {
    const layers = map.getStyle().layers;
    const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
    const firstLine = layers.find((l) => l.type === 'line')?.id || firstSymbol;
    // Base imagery (inserted under roads and labels so the vector labels stay crisp).
    map.addSource('base-sat', { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 });
    map.addLayer({ id: 'base-sat', type: 'raster', source: 'base-sat', layout: { visibility: 'none' } }, firstLine);
    map.addSource('base-s2', { type: 'raster', tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg'], tileSize: 256, maxzoom: 15 });
    map.addLayer({ id: 'base-s2', type: 'raster', source: 'base-s2', layout: { visibility: 'none' } }, firstLine);
    // Live raster overlays
    map.addSource('clouds', { type: 'raster', tiles: [WMS('mtg_fd:rgb_geocolour')], tileSize: 512, maxzoom: 9 });
    map.addLayer({ id: 'clouds', type: 'raster', source: 'clouds', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.82, 'raster-fade-duration': 0 } }, firstLine);
    map.addSource('radar', { type: 'raster', tiles: ['https://tilecache.rainviewer.com/v2/radar/nowcast_0/256/{z}/{x}/{y}/4/1_1.png'], tileSize: 256, maxzoom: 12 });
    map.addLayer({ id: 'radar', type: 'raster', source: 'radar', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 } }, firstSymbol);
    map.addSource('lightning', { type: 'raster', tiles: [WMS('mtg_fd:li_afa')], tileSize: 512, maxzoom: 9 });
    map.addLayer({ id: 'lightning', type: 'raster', source: 'lightning', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.95 } }, firstSymbol);
    map.addSource('fires', { type: 'raster', tiles: ['https://maps.effis.emergency.copernicus.eu/effis?service=WMS&version=1.3.0&request=GetMap&layers=viirs.hs&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512&format=image/png&transparent=true'], tileSize: 512, maxzoom: 12 });
    map.addLayer({ id: 'fires', type: 'raster', source: 'fires', layout: { visibility: 'none' } }, firstSymbol);
    map.addSource('fires-frp', { type: 'raster', tiles: [WMS('mtg_fd:frp')], tileSize: 512, maxzoom: 9 });
    map.addLayer({ id: 'fires-frp', type: 'raster', source: 'fires-frp', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9 } }, firstSymbol);
    // Vector overlays
    for (const id of ['cams-src', 'flights-src', 'ships-src', 'quakes-src']) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'quakes', type: 'circle', source: 'quakes-src', layout: { visibility: 'none' }, paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 0, 3, 3, 8, 6, 22], 'circle-color': '#ff8a3d', 'circle-opacity': 0.55, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
    map.addLayer({ id: 'ships', type: 'circle', source: 'ships-src', layout: { visibility: 'none' }, paint: { 'circle-radius': 4.5, 'circle-color': '#3ddc97', 'circle-stroke-color': '#062', 'circle-stroke-width': 1 } });
    map.addLayer({ id: 'cams', type: 'circle', source: 'cams-src', layout: { visibility: 'visible' }, paint: { 'circle-radius': 6, 'circle-color': '#ffb454', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    planeIcon(map);
    map.addLayer({ id: 'flights', type: 'symbol', source: 'flights-src', layout: { visibility: 'none', 'icon-image': 'plane', 'icon-size': 0.55, 'icon-rotate': ['get', 'track'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'text-field': ['get', 'callsign'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-optional': true, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#cbbfff', 'text-halo-color': '#000', 'text-halo-width': 1 } });
    for (const id of ['cams', 'flights', 'ships', 'quakes']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
    map.on('click', 'cams', (e) => { const cam = JSON.parse(e.features[0].properties.cam); openCam(cam); e.originalEvent._handled = true; });
    map.on('click', 'flights', (e) => { const p = e.features[0].properties; new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(`<b>${esc(p.callsign || p.hex)}</b> ${esc(p.type || '')}<br>${p.altFt} ft · ${p.gs} kt · ${p.vr}`).addTo(map); e.originalEvent._handled = true; });
    map.on('click', 'ships', (e) => { const p = e.features[0].properties; new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(`<b>${esc(p.name || 'MMSI ' + p.mmsi)}</b><br>${esc(p.typeName || '')} · ${p.sog ?? '—'} kn${p.destination ? ' → ' + esc(p.destination) : ''}`).addTo(map); e.originalEvent._handled = true; });
    map.on('click', 'quakes', (e) => { const p = e.features[0].properties; new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(`<b>${esc(p.title)}</b><br>${fmtDate(p.time, state.tz)}`).addTo(map); e.originalEvent._handled = true; });
    map.on('click', (e) => { if (e.originalEvent._handled) return; select(e.lngLat.lat, e.lngLat.lng, { fly: false }); });
    map.on('moveend', () => { if (state.layers.flights) refreshFlights(); if (state.layers.ships) refreshShips(); if (state.layers.cams && map.getZoom() >= 6.5) refreshCamsInView(); });
    buildDock();
    refreshLayerMeta();
    fromHash();
  });
}
function planeIcon(map) {
  const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d');
  x.translate(24, 24); x.scale(2, 2); x.translate(-12, -12); x.fillStyle = '#c9b8ff'; x.strokeStyle = '#1a1030'; x.lineWidth = 1;
  const p = new Path2D('M12 2 9 9l-7 4v2l7-2v5l-2 2v1l4-1 4 1v-1l-2-2v-5l7 2v-2l-7-4-2-7z'); x.fill(p); x.stroke(p);
  map.addImage('plane', x.getImageData(0, 0, 48, 48), { pixelRatio: 2 });
}
function setGeo(src, features) { state.map.getSource(src)?.setData({ type: 'FeatureCollection', features }); }
function clearGeo(src) { setGeo(src, []); }
function placeHere(lat, lon) {
  if (!state.hereMarker) { const d = el('div', 'mk here'); state.hereMarker = new maplibregl.Marker({ element: d }).setLngLat([lon, lat]).addTo(state.map); }
  else state.hereMarker.setLngLat([lon, lat]);
}
function plotCams(cams) {
  setGeo('cams-src', cams.filter((c) => c.lat != null).map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: { cam: JSON.stringify(c) } })));
}
function viewRadiusKm(max, min) { const b = state.map.getBounds(); return Math.min(max, Math.max(min, Math.round(haversineKm(b.getSouth(), b.getWest(), b.getNorth(), b.getEast()) / 2))); }
async function refreshCamsInView() {
  const c = state.map.getCenter();
  try { const j = await (await fetch(`/api/cams?lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}&r=${viewRadiusKm(100, 5)}`)).json(); if (j.cams) { plotCams(j.cams); setChipAge('cams', String(j.count)); } } catch {}
}
async function refreshFlights() {
  const c = state.map.getCenter();
  try {
    const j = await (await fetch(`/api/flights?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&r=${viewRadiusKm(250, 20)}`)).json();
    setGeo('flights-src', (j.aircraft || []).filter((a) => !a.onGround).map((a) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lon, a.lat] }, properties: { hex: a.hex, callsign: a.callsign || '', type: a.type || '', track: a.track || 0, altFt: a.altFt, gs: Math.round(a.groundSpeedKt || 0), vr: a.verticalRateFpm > 300 ? 'climbing' : a.verticalRateFpm < -300 ? 'descending' : 'level' } })));
    setChipAge('flights', `${(j.aircraft || []).length}`);
  } catch {}
}
async function refreshShips() {
  const c = state.map.getCenter();
  try { const j = await (await fetch(`/api/ships?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&r=${viewRadiusKm(150, 10)}`)).json(); if (!j.enabled) { setChipAge('ships', 'no key'); return; } setGeo('ships-src', (j.vessels || []).map((v) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon, v.lat] }, properties: { mmsi: v.mmsi, name: v.name, typeName: v.typeName, sog: v.sog, destination: v.destination } }))); setChipAge('ships', `${(j.vessels || []).length}`); } catch {}
}
function haversineKm(lat1, lon1, lat2, lon2) { const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(a)); }

// ------------------------------------------------------------------ dock
function buildDock() {
  const live = $('#live-layers'); live.innerHTML = '';
  for (const l of LIVE_LAYERS) {
    const b = el('button', 'chip', `<span class="sw" style="--c:${l.color}"></span>${esc(l.label)} <span class="age" data-age="${l.id}"></span>`);
    b.dataset.layer = l.id; b.setAttribute('aria-pressed', 'false'); b.onclick = () => toggleLayer(l.id);
    live.appendChild(b);
  }
  const base = $('#base-layers'); base.innerHTML = '';
  for (const [id, label] of [['dark', 'Dark'], ['sat', 'Satellite'], ['s2', 'Sentinel-2']]) { const b = el('button', 'chip base', esc(label)); b.setAttribute('aria-pressed', String(id === 'dark')); b.onclick = () => setBase(id); b.dataset.base = id; base.appendChild(b); }
  toggleLayer('cams', true);
  $('#scrub-play').onclick = () => { state.scrub.playing = !state.scrub.playing; $('#scrub-play').textContent = state.scrub.playing ? '❚❚' : '▶'; runScrub(); };
  $('#scrub-range').oninput = (e) => { state.scrub.playing = false; $('#scrub-play').textContent = '▶'; clearInterval(state.scrub.timer); showScrubFrame(+e.target.value); };
}
function setBase(id) {
  state.base = id;
  for (const [lid, on] of [['base-sat', id === 'sat'], ['base-s2', id === 's2']]) state.map.setLayoutProperty(lid, 'visibility', on ? 'visible' : 'none');
  document.querySelectorAll('[data-base]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.base === id)));
}
function toggleLayer(id, force) {
  const on = force != null ? force : !state.layers[id];
  state.layers[id] = on;
  const ids = id === 'fires' ? ['fires', 'fires-frp'] : [id];
  for (const lid of ids) if (state.map.getLayer(lid)) state.map.setLayoutProperty(lid, 'visibility', on ? 'visible' : 'none');
  document.querySelector(`[data-layer="${id}"]`)?.setAttribute('aria-pressed', String(on));
  if (id === 'flights') { clearInterval(state.flightTimer); if (on) { refreshFlights(); state.flightTimer = setInterval(() => !document.hidden && refreshFlights(), 8000); } }
  if (id === 'ships') { clearInterval(state.shipTimer); if (on) { refreshShips(); state.shipTimer = setInterval(() => !document.hidden && refreshShips(), 10000); } }
  if (id === 'cams' && on && state.map.getZoom() >= 6.5 && !state.point) refreshCamsInView();
  if (id === 'clouds' || id === 'radar') updateScrub();
}
function setChipAge(id, text) { const e = document.querySelector(`[data-age="${id}"]`); if (e) e.textContent = text; }

// Time scrubber: drives the Clouds (Meteosat, 10 min) and Rain (radar, 10 min) layers together.
async function refreshLayerMeta() {
  try { state.layerMeta = await (await fetch('/api/layers')).json(); } catch { return; }
  const m = state.layerMeta;
  const geo = m.eumetsat?.['mtg_fd:rgb_geocolour']; if (geo) { setChipAge('clouds', fmtTime(geo.latest)); if (!state.scrub.playing) state.map.getSource('clouds')?.setTiles([WMS('mtg_fd:rgb_geocolour', geo.latest)]); }
  const li = m.eumetsat?.['mtg_fd:li_afa']; if (li) { setChipAge('lightning', fmtTime(li.latest)); state.map.getSource('lightning')?.setTiles([WMS('mtg_fd:li_afa', li.latest)]); }
  const frp = m.eumetsat?.['mtg_fd:frp']; if (frp) { setChipAge('fires', fmtTime(frp.latest)); state.map.getSource('fires-frp')?.setTiles([WMS('mtg_fd:frp', frp.latest)]); }
  const past = m.radar?.past || []; if (past.length) { setChipAge('radar', fmtTime(past[past.length - 1].time)); if (!state.scrub.playing) state.map.getSource('radar')?.setTiles([past[past.length - 1].tiles]); }
  updateScrub();
  clearTimeout(state.metaTimer); state.metaTimer = setTimeout(refreshLayerMeta, 5 * 60 * 1000);
}
function updateScrub() {
  const on = state.layers.clouds || state.layers.radar;
  $('#scrub').classList.toggle('on', !!on);
  if (!on || !state.layerMeta) { state.scrub.playing = false; clearInterval(state.scrub.timer); $('#scrub-play').textContent = '▶'; return; }
  const geo = state.layerMeta.eumetsat?.['mtg_fd:rgb_geocolour']; const past = state.layerMeta.radar?.past || [];
  const end = geo ? new Date(geo.latest).getTime() : (past.length ? new Date(past[past.length - 1].time).getTime() : Date.now());
  const frames = [];
  for (let i = 11; i >= 0; i--) {
    const t = end - i * 10 * 60e3;
    const radar = past.length ? past.reduce((b, f) => (Math.abs(new Date(f.time) - t) < Math.abs(new Date(b.time) - t) ? f : b)) : null;
    frames.push({ t, cloudsTime: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), radar: radar?.tiles });
  }
  state.scrub.frames = frames; $('#scrub-range').max = frames.length - 1;
  if (!state.scrub.playing) showScrubFrame(frames.length - 1);
}
function showScrubFrame(i) {
  const f = state.scrub.frames[i]; if (!f) return;
  state.scrub.i = i; $('#scrub-range').value = i;
  const latest = i === state.scrub.frames.length - 1;
  $('#scrub-time').innerHTML = `${latest ? '<b>LIVE</b> ' : ''}${fmtTime(new Date(f.t).toISOString())}${latest ? '' : ' <span style="color:var(--fg-3)">' + ago(new Date(f.t).toISOString()) + '</span>'}`;
  if (state.layers.clouds) state.map.getSource('clouds')?.setTiles([WMS('mtg_fd:rgb_geocolour', f.cloudsTime)]);
  if (state.layers.radar && f.radar) state.map.getSource('radar')?.setTiles([f.radar]);
}
function runScrub() {
  clearInterval(state.scrub.timer);
  if (!state.scrub.playing) return;
  state.scrub.timer = setInterval(() => { if (document.hidden) return; showScrubFrame((state.scrub.i + 1) % state.scrub.frames.length); }, 900);
}

// ------------------------------------------------------------------ search
const q = $('#q'), results = $('#results');
let searchTimer, searchSeq = 0, sel = -1;
q.addEventListener('input', () => { clearTimeout(searchTimer); const v = q.value.trim(); if (v.length < 2) { results.hidden = true; return; } searchTimer = setTimeout(() => doSearch(v), 180); });
q.addEventListener('keydown', (e) => {
  const items = [...results.querySelectorAll('li[data-ll]')];
  if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); mark(items); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); mark(items); e.preventDefault(); }
  else if (e.key === 'Enter') { (items[sel] || items[0])?.click(); }
  else if (e.key === 'Escape') { results.hidden = true; q.blur(); }
});
function mark(items) { items.forEach((it, i) => it.setAttribute('aria-selected', String(i === sel))); items[sel]?.scrollIntoView({ block: 'nearest' }); }
async function doSearch(v) {
  const seq = ++searchSeq;
  let j; try { j = await (await fetch(`/api/search?q=${encodeURIComponent(v)}`)).json(); } catch { return; }
  if (seq !== searchSeq) return;
  sel = -1; results.innerHTML = '';
  if (!j.results.length) { results.innerHTML = '<li class="empty">Nothing found in Europe for that.</li>'; results.hidden = false; return; }
  for (const r of j.results) {
    const li = el('li', '', `<span class="flag">${esc(r.flag || '📍')}</span><span class="name">${esc(r.name)}</span><span class="detail">${esc(r.detail || [r.type === 'city' ? (r.population ? r.population.toLocaleString() + ' people' : '') : r.type, r.country].filter(Boolean).join(' · '))}</span>`);
    li.dataset.ll = `${r.lat},${r.lon}`; li.setAttribute('role', 'option');
    li.onclick = () => { results.hidden = true; q.value = r.name; q.blur(); const z = r.type === 'city' ? (r.population > 500000 ? 11 : 12) : r.extent ? 13 : 14; select(r.lat, r.lon, { zoom: z }); };
    results.appendChild(li);
  }
  results.hidden = false;
}
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); q.select(); }
  if (e.key === 'Escape') { if (!$('#lightbox').hidden) closeLightbox(); else closePanel(); }
});
$('#locate').onclick = () => {
  if (!navigator.geolocation) return toast('Geolocation is not available in this browser.');
  navigator.geolocation.getCurrentPosition((p) => { const { latitude: la, longitude: lo } = p.coords; if (!inEurope(la, lo)) return toast('You seem to be outside Europe — click the map instead.'); select(la, lo, { zoom: 13 }); }, () => toast('Could not get your location.'), { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
};
function closePanel() { $('#panel').classList.remove('open'); state.es?.close(); for (const t of state.timers) clearInterval(t); state.timers.clear(); state.flightsPanelTimer = null; stopSatLoop(); state.point = null; history.replaceState(null, '', location.pathname); $('#hint').classList.remove('hide'); }
$('#p-close').onclick = closePanel;
function toast(msg) { const t = el('div', 'toast', esc(msg)); document.body.appendChild(t); setTimeout(() => t.remove(), 3500); }
function fromHash() {
  const m = location.hash.match(/^#@(-?[\d.]+),(-?[\d.]+)(?:,([\d.]+)z)?/);
  if (!m) return;
  const lat = +m[1], lon = +m[2], z = m[3] ? +m[3] : 11;
  state.map.jumpTo({ center: [lon, lat], zoom: z });
  select(lat, lon, { fly: false });
}
window.addEventListener('hashchange', () => { const m = location.hash.match(/^#@(-?[\d.]+),(-?[\d.]+)/); if (m && (!state.point || +m[1] !== state.point.lat || +m[2] !== state.point.lon)) fromHash(); });

// clock + server status
setInterval(() => { $('#clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC'; }, 1000);
fetch('/api/status').then((r) => r.json()).then((s) => { $('#net').textContent = `${s.providers.filter((p) => p.enabled).length} live sources · v${s.version}`; $('#net').className = 'pill ok'; }).catch(() => { $('#net').textContent = 'offline'; $('#net').className = 'pill err'; });

initMap();
