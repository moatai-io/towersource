#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageNames = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
];

function fail(message) {
  console.error(`[pi-sdk-install] ${message}`);
  process.exitCode = 1;
}

function loadPackage(name) {
  try {
    const directory = path.join(root, 'node_modules', ...name.split('/'));
    const packageJsonPath = path.join(directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (manifest.name !== name) throw new Error(`unexpected package name ${JSON.stringify(manifest.name)}`);
    return { directory, manifest };
  } catch (error) {
    fail(`cannot load ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const packages = new Map();
for (const name of packageNames) {
  const loaded = loadPackage(name);
  if (loaded) packages.set(name, loaded);
}

const manifests = [
  ['root', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))],
  ['backend', JSON.parse(fs.readFileSync(path.join(root, 'packages/backend/package.json'), 'utf8'))],
];
const declaredVersions = new Set();
for (const [scope, manifest] of manifests) {
  for (const name of packageNames) {
    const declared = manifest.dependencies?.[name];
    if (!/^\d+\.\d+\.\d+$/.test(declared ?? '')) {
      fail(`${scope} dependency ${name} must use an exact version, found ${JSON.stringify(declared)}`);
      continue;
    }
    declaredVersions.add(declared);
    const installed = packages.get(name)?.manifest.version;
    if (installed && installed !== declared) {
      fail(`${name} installed version ${installed} does not match ${scope} declaration ${declared}`);
    }
  }
}

const installedVersions = new Set([...packages.values()].map(({ manifest }) => manifest.version));
if (packages.size === packageNames.length && installedVersions.size !== 1) {
  fail(`installed release train versions differ: ${packageNames.map((name) => `${name}=${packages.get(name)?.manifest.version ?? 'missing'}`).join(', ')}`);
}
if (declaredVersions.size !== 1) {
  fail(`declared release train versions differ: ${[...declaredVersions].join(', ')}`);
}

const piAi = packages.get('@earendil-works/pi-ai');
if (piAi) {
  const requiredExports = [
    ['.', './dist/index.d.ts'],
    ['./api/*', './dist/api/*.d.ts'],
  ];
  for (const [exportName, expectedTypes] of requiredExports) {
    const actualTypes = piAi.manifest.exports?.[exportName]?.types;
    if (actualTypes !== expectedTypes) {
      fail(`pi-ai export ${exportName} types is ${JSON.stringify(actualTypes)}, expected ${JSON.stringify(expectedTypes)}`);
    }
  }

  for (const relativePath of [
    'dist/index.d.ts',
    'dist/types.d.ts',
    'dist/api/openai-responses.d.ts',
  ]) {
    if (!fs.existsSync(path.join(piAi.directory, relativePath))) {
      fail(`pi-ai declaration is missing: ${relativePath}`);
    }
  }
}

if (!process.exitCode) {
  console.log(`[pi-sdk-install] ok: ${packageNames.map((name) => `${name}@${packages.get(name)?.manifest.version}`).join(', ')}`);
}
