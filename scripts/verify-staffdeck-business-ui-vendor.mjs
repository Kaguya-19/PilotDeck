#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const upstreamRoot = process.env.STAFFDECK_BUSINESS_UI_ROOT;
if (!upstreamRoot) {
  throw new Error('Set STAFFDECK_BUSINESS_UI_ROOT to the StaffDeck @staffdeck/business-ui package directory.');
}

const vendorRoot = resolve(root, 'ui/src/composition/modules/staffdeck/vendor');
const [upstreamPackage, vendorPackage] = await Promise.all([
  readFile(resolve(upstreamRoot, 'package.json'), 'utf8').then(JSON.parse),
  readFile(resolve(vendorRoot, 'package.json'), 'utf8').then(JSON.parse),
]);
if (upstreamPackage.name !== '@staffdeck/business-ui' || vendorPackage.name !== upstreamPackage.name || vendorPackage.version !== upstreamPackage.version) {
  throw new Error(`PilotDeck StaffDeck UI vendor version mismatch: ${vendorPackage.name}@${vendorPackage.version} != ${upstreamPackage.name}@${upstreamPackage.version}`);
}
// Audit every authoritative source, including mechanically extracted formal
// helpers; an old fixed thirteen-file list would silently omit new consumers.
const files = (await readdir(resolve(upstreamRoot, 'src'))).filter((file) => /\.(tsx?|css)$/.test(file));
const mismatches = [];
for (const file of files) {
  const [upstream, vendor] = await Promise.all([
    readFile(resolve(upstreamRoot, 'src', file), 'utf8'),
    readFile(resolve(vendorRoot, file), 'utf8'),
  ]);
  if (upstream !== vendor) mismatches.push(file);
}

if (mismatches.length > 0) {
  throw new Error(`PilotDeck StaffDeck UI vendor snapshot is stale: ${mismatches.join(', ')}`);
}
process.stdout.write(`PilotDeck StaffDeck UI vendor snapshot matches ${upstreamPackage.name} ${upstreamPackage.version} (${files.length} source files).\n`);
