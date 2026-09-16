#!/usr/bin/env node
/**
 * Builds data/cities.json — a compact index of every European city/town with
 * population >= 15k, from the GeoNames "cities15000" dump (CC BY 4.0).
 *
 * Usage:  node scripts/build-data.js [path/to/cities15000.zip]
 * If no path is given the dump is downloaded from download.geonames.org.
 *
 * Output row format (compact array to keep the payload small):
 *   [name, countryCode, lat, lon, population, admin1, timezone, geonameId]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'cities.json');
const DUMP_URL = 'https://download.geonames.org/export/dump/cities15000.zip';

// Europe in the wide sense: the continent plus micro-states, dependencies and
// the transcontinental states whose European part people travel to.
const EUROPE = new Set(('AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE ' +
  'LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM TR UA VA XK GE AM AZ').split(' '));
// Bounding box used to clip the transcontinental countries (RU, TR, KZ) to their European side.
const BBOX = { minLat: 34, maxLat: 82, minLon: -32, maxLon: 60 };

async function main() {
  let zipPath = process.argv[2];
  const work = join(tmpdir(), 'europa-geonames');
  mkdirSync(work, { recursive: true });
  if (!zipPath) {
    zipPath = join(work, 'cities15000.zip');
    if (!existsSync(zipPath)) {
      console.log('Downloading', DUMP_URL);
      const res = await fetch(DUMP_URL, { headers: { 'user-agent': 'EuropaLive/1.0 build script' } });
      if (!res.ok) throw new Error('download failed ' + res.status);
      writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    }
  }
  // Extract with python's zipfile module (available everywhere; avoids a zip dependency).
  execFileSync('python3', ['-m', 'zipfile', '-e', zipPath, work], { stdio: 'inherit' });
  const txt = readFileSync(join(work, 'cities15000.txt'), 'utf8');
  const rows = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    const cc = c[8];
    if (!EUROPE.has(cc)) continue;
    const lat = +c[4], lon = +c[5];
    if (lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) continue;
    // Russia east of the Urals and Turkey's far east are outside the app's remit.
    if (cc === 'RU' && lon > 60) continue;
    rows.push([c[1], cc, +lat.toFixed(4), +lon.toFixed(4), +c[14] || 0, c[10] || '', c[17] || '', +c[0]]);
  }
  rows.sort((a, b) => b[4] - a[4]);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    source: 'GeoNames cities15000 (CC BY 4.0) https://www.geonames.org/',
    built: new Date().toISOString(),
    fields: ['name', 'cc', 'lat', 'lon', 'pop', 'admin1', 'tz', 'geonameId'],
    rows,
  }));
  console.log(`Wrote ${rows.length} cities to ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
