#!/usr/bin/env node
/** Captures screenshots of a running instance with headless Chrome (google-chrome or chromium on PATH). */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const base = process.env.BASE || 'http://localhost:8080';
const chrome = process.env.CHROME || 'google-chrome';
mkdirSync('screenshots', { recursive: true });
const shots = [['rome', '#@41.8902,12.4922,12z'], ['helsinki', '#@60.17,24.94,11z'], ['london', '#@51.507,-0.127,12z'], ['europe', '']];
for (const [name, hash] of shots) {
  execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', '--virtual-time-budget=30000', `--screenshot=screenshots/${name}.png`, `${base}/${hash}`], { stdio: 'ignore' });
  console.log('saved screenshots/' + name + '.png');
}
