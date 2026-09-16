#!/usr/bin/env node
/** Syntax-checks every JavaScript file in the project (no linter dependency needed). */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { if (n === 'node_modules' || n === 'vendor' || n.startsWith('.')) continue; const p = join(d, n); statSync(p).isDirectory() ? walk(p) : n.endsWith('.js') && files.push(p); } };
walk('.');
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`syntax ok: ${files.length} files`);
