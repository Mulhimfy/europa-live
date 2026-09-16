/**
 * Vessels nearby right now via AIS (aisstream.io websocket; free key required).
 * One websocket per process keeps a rolling in-memory picture of every vessel
 * in Europe (positions arrive every few seconds); lookups are then instant.
 */
import { config } from '../config.js';
import { haversine, bearing } from '../lib/geo.js';
import { log } from '../lib/log.js';

const vessels = new Map(); // mmsi -> {...}
let ws = null, connectedAt = 0, msgCount = 0, lastMsgAt = 0, backoff = 1000, stopping = false;
const TYPES = { 30: 'Fishing', 31: 'Towing', 32: 'Towing', 33: 'Dredging', 34: 'Diving', 35: 'Military', 36: 'Sailing', 37: 'Pleasure craft', 40: 'High-speed craft', 50: 'Pilot', 51: 'SAR', 52: 'Tug', 53: 'Port tender', 55: 'Law enforcement', 58: 'Medical', 60: 'Passenger', 70: 'Cargo', 80: 'Tanker', 90: 'Other' };
const shipType = (t) => t == null ? null : TYPES[t] || TYPES[Math.floor(t / 10) * 10] || 'Other';

export function shipsEnabled() { return !!config.keys.aisstream && typeof WebSocket !== 'undefined'; }

export function ensureAis() {
  if (!shipsEnabled() || ws || stopping) return;
  try {
    ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  } catch (e) { log.warn({ err: e }, 'aisstream connect failed'); ws = null; return; }
  ws.onopen = () => {
    connectedAt = Date.now(); backoff = 1000;
    ws.send(JSON.stringify({ APIKey: config.keys.aisstream, BoundingBoxes: [[[27.5, -32], [82, 60]]], FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }));
    log.info('aisstream connected');
  };
  ws.onmessage = (ev) => {
    msgCount++; lastMsgAt = Date.now();
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const md = m.MetaData || {}; const mmsi = md.MMSI; if (!mmsi) return;
    const v = vessels.get(mmsi) || { mmsi };
    if (m.MessageType === 'PositionReport') {
      const p = m.Message?.PositionReport || {};
      Object.assign(v, { lat: md.latitude, lon: md.longitude, name: (md.ShipName || v.name || '').trim(), sog: p.Sog, cog: p.Cog, heading: p.TrueHeading === 511 ? null : p.TrueHeading, status: p.NavigationalStatus, at: Date.now() });
    } else if (m.MessageType === 'ShipStaticData') {
      const s = m.Message?.ShipStaticData || {};
      Object.assign(v, { name: (s.Name || md.ShipName || v.name || '').trim(), callsign: s.CallSign, type: s.Type, typeName: shipType(s.Type), destination: (s.Destination || '').trim(), lengthM: s.Dimension ? (s.Dimension.A || 0) + (s.Dimension.B || 0) : v.lengthM, imo: s.ImoNumber });
      if (v.at == null) v.at = Date.now();
    }
    vessels.set(mmsi, v);
  };
  ws.onclose = () => { ws = null; if (!stopping) setTimeout(ensureAis, backoff = Math.min(60000, backoff * 2)); };
  ws.onerror = (e) => { log.warn({ err: e?.message || String(e) }, 'aisstream error'); try { ws?.close(); } catch {} };
}
export function stopAis() { stopping = true; try { ws?.close(); } catch {} }
setInterval(() => { const cutoff = Date.now() - 30 * 60e3; for (const [k, v] of vessels) if ((v.at || 0) < cutoff) vessels.delete(k); }, 60e3).unref();

export function shipsNear(lat, lon, radiusKm) {
  const out = [];
  for (const v of vessels.values()) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    if (Math.abs(v.lat - lat) > radiusKm / 100) continue;
    const d = haversine(lat, lon, v.lat, v.lon);
    if (d <= radiusKm * 1000) out.push({ ...v, distanceKm: +(d / 1000).toFixed(1), bearing: Math.round(bearing(lat, lon, v.lat, v.lon)), ageSec: Math.round((Date.now() - v.at) / 1000) });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}
export function aisStatus() { return { enabled: shipsEnabled(), connected: !!ws && ws.readyState === 1, vessels: vessels.size, messages: msgCount, lastMessage: lastMsgAt ? new Date(lastMsgAt).toISOString() : null, since: connectedAt ? new Date(connectedAt).toISOString() : null }; }

export default {
  id: 'ships', label: 'Vessels nearby', tier: 'sea', ttlMs: 5e3, timeoutMs: 3000, keyHint: 'AISSTREAM_KEY',
  hosts: ['stream.aisstream.io'], enabled: shipsEnabled,
  async fetch({ lat, lon }) {
    ensureAis();
    const list = shipsNear(lat, lon, 40);
    return { count: list.length, radiusKm: 40, vessels: list.slice(0, 40), status: aisStatus(), attribution: 'AIS via aisstream.io' };
  },
};
