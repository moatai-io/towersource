#!/usr/bin/env node
import { existsSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

const [,, input, output] = process.argv;
if (!input || !output) {
  console.error('Usage: node render_pdf.mjs <input.html> <output.pdf>');
  process.exit(2);
}

const inputPath = resolve(input);
const outputPath = resolve(output);
if (!existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  process.exit(1);
}

const candidates = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);
const chromium = candidates.find((p) => existsSync(p));
if (!chromium) {
  console.error('Chromium not found. Tried: ' + candidates.join(', '));
  process.exit(1);
}

const url = 'file://' + inputPath;
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=3000',
  `--print-to-pdf=${outputPath}`,
  '--print-to-pdf-no-header',
  url,
];

const res = spawnSync(chromium, args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
