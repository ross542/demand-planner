#!/usr/bin/env node
/**
 * AMAHC Demand Planner — Scheduled Refresh
 *
 * Runs the same aggregator the live server uses, then writes:
 *   - dist/snapshot.json   (raw data, for debugging)
 *   - dist/index.html      (dashboard with data injected, ready to view)
 *
 * Used by the GitHub Action that publishes to GitHub Pages every business day.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { buildDemandPlan } = require('./api/aggregator');

async function main() {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] Building demand plan...`);

  const data = await buildDemandPlan();

  const outDir = path.join(__dirname, 'dist');
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Write raw snapshot
  fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(data, null, 2));

  // 2. Read template and inject data so the page works as a static file
  const tplPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(tplPath, 'utf8');

  const marker = '<script type="text/babel">';
  const idx = html.indexOf(marker);
  if (idx < 0) throw new Error('Template missing <script type="text/babel"> marker');
  const injectAt = idx + marker.length;

  const injection = `
        // === SCHEDULED SNAPSHOT (${new Date().toISOString()}) ===
        const FALLBACK_PRODUCTS = ${JSON.stringify(data.products)};
        const FALLBACK_VARIANTS = ${JSON.stringify(data.variants || [])};
        const FALLBACK_META = ${JSON.stringify(data.meta)};
        // === END SNAPSHOT ===
`;

  html = html.slice(0, injectAt) + injection + html.slice(injectAt);
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  const ms = Date.now() - start;
  const counts = data.products.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`Built ${data.products.length} products in ${(ms / 1000).toFixed(1)}s`);
  console.log(`Status: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`Wrote: dist/snapshot.json, dist/index.html`);
}

main().catch((err) => {
  console.error('REFRESH FAILED:', err);
  process.exit(1);
});
