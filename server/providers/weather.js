/** Conditions right now (Open-Meteo: 15-minute model nowcast + CAMS air quality + marine). */
import { upstream } from '../lib/http.js';
import { haversine } from '../lib/geo.js';

const WMO = {
  0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'], 45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Dense drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'], 80: ['Rain showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Severe thunderstorm', '⛈️'],
};
export const describeWmo = (c) => WMO[c] || ['Unknown', '❔'];
const aqiBand = (v) => v == null ? null : v <= 20 ? 'Good' : v <= 40 ? 'Fair' : v <= 60 ? 'Moderate' : v <= 80 ? 'Poor' : v <= 100 ? 'Very poor' : 'Extremely poor';
const compass = (d) => d == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];

export default {
  id: 'weather', label: 'Conditions now', tier: 'now', ttlMs: 5 * 60e3, timeoutMs: 8000,
  hosts: ['api.open-meteo.com', 'air-quality-api.open-meteo.com', 'marine-api.open-meteo.com'],
  async fetch({ lat, lon }) {
    const q = `latitude=${lat}&longitude=${lon}&timezone=auto`;
    const [fc, aq, mar] = await Promise.allSettled([
      upstream(`https://api.open-meteo.com/v1/forecast?${q}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m&minutely_15=precipitation,temperature_2m,weather_code&forecast_minutely_15=12&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,visibility,uv_index,cloud_cover&forecast_hours=24&daily=sunrise,sunset,uv_index_max&forecast_days=1`),
      upstream(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone,sulphur_dioxide,uv_index,dust`),
      upstream(`https://marine-api.open-meteo.com/v1/marine?${q}&current=wave_height,wave_direction,wave_period,sea_surface_temperature,swell_wave_height`),
    ]);
    if (fc.status !== 'fulfilled') throw fc.reason;
    const f = fc.value, c = f.current || {};
    const [text, icon] = describeWmo(c.weather_code);
    const hourly = (f.hourly?.time || []).map((t, i) => ({ t, temp: f.hourly.temperature_2m[i], pop: f.hourly.precipitation_probability[i], precip: f.hourly.precipitation[i], code: f.hourly.weather_code[i], vis: f.hourly.visibility[i], uv: f.hourly.uv_index[i], cloud: f.hourly.cloud_cover[i] }));
    const next2h = (f.minutely_15?.time || []).map((t, i) => ({ t, precip: f.minutely_15.precipitation[i], temp: f.minutely_15.temperature_2m[i], code: f.minutely_15.weather_code[i] }));
    const out = {
      observedAt: c.time, tz: f.timezone, elevation: f.elevation,
      now: { temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, isDay: !!c.is_day, code: c.weather_code, text, icon,
        precip: c.precipitation, rain: c.rain, showers: c.showers, snow: c.snowfall, cloud: c.cloud_cover, pressure: c.pressure_msl,
        wind: c.wind_speed_10m, windDir: c.wind_direction_10m, windCompass: compass(c.wind_direction_10m), gusts: c.wind_gusts_10m, visibility: hourly[0]?.vis ?? null, uv: hourly[0]?.uv ?? null },
      next2h, hourly, uvMax: f.daily?.uv_index_max?.[0] ?? null,
      air: null, sea: null,
      attribution: 'Open-Meteo (CC BY 4.0), CAMS/Copernicus, MeteoFrance/ECMWF wave models',
    };
    if (aq.status === 'fulfilled' && aq.value.current) {
      const a = aq.value.current;
      out.air = { observedAt: a.time, aqi: a.european_aqi, band: aqiBand(a.european_aqi), pm10: a.pm10, pm25: a.pm2_5, no2: a.nitrogen_dioxide, o3: a.ozone, so2: a.sulphur_dioxide, uv: a.uv_index, dust: a.dust };
    }
    if (mar.status === 'fulfilled' && mar.value.current) {
      const m = mar.value, s = m.current;
      const distM = haversine(lat, lon, m.latitude, m.longitude);
      if (s.wave_height != null && distM < 35_000) {
        out.sea = { observedAt: s.time, waveHeight: s.wave_height, waveDir: s.wave_direction, wavePeriod: s.wave_period, swell: s.swell_wave_height, sst: s.sea_surface_temperature, gridDistanceKm: +(distM / 1000).toFixed(1) };
      }
    }
    return out;
  },
};
