/**
 * A Man & His Cave — Demand Planner Backend Server
 *
 * Connects to:
 *   - Unleashed API (Purchase Orders + Stock on Hand)
 *   - PMA Sync API (Stock on Hand)
 *   - Shopify Admin API (Products + Order Velocity)
 *
 * Serves the demand planner dashboard and API endpoints.
 *
 * Usage:
 *   npm install
 *   npm start
 *   Open http://localhost:3001 in your browser
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { buildDemandPlan } = require('./api/aggregator');
const unleashed = require('./api/unleashed');
const pmasync = require('./api/pmasync');
const yunfulfillment = require('./api/yunfulfillment');
const shopify = require('./api/shopify');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static files (dashboard HTML)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Live data received from browser (fetch-live.html posts here)
// ============================================================
let liveUnleashed = null;
let liveShopify = null;

app.post('/api/live-data/unleashed', (req, res) => {
  liveUnleashed = req.body;
  console.log(`[Server] Received live Unleashed data: ${Object.keys(liveUnleashed.poMap||{}).length} PO SKUs, ${Object.keys(liveUnleashed.sohMap||{}).length} SOH SKUs`);
  // Invalidate cache so next demand-plan request rebuilds with live data
  cachedPlan = null;
  lastFetchTime = null;
  res.json({ ok: true });
});

app.post('/api/live-data/shopify', (req, res) => {
  liveShopify = req.body;
  console.log(`[Server] Received live Shopify data: ${liveShopify.products} products`);
  cachedPlan = null;
  lastFetchTime = null;
  res.json({ ok: true });
});

// ============================================================
// In-memory cache — refreshes on demand or every 15 minutes
// ============================================================
let cachedPlan = null;
let lastFetchTime = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function isCacheValid() {
  return cachedPlan && lastFetchTime && (Date.now() - lastFetchTime < CACHE_TTL_MS);
}

// ============================================================
// API ENDPOINTS
// ============================================================

/**
 * GET /api/demand-plan
 * Returns the full demand plan (products + variants + meta)
 * Query params: ?force=true to bypass cache
 */
app.get('/api/demand-plan', async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';

    if (!forceRefresh && isCacheValid()) {
      console.log('[Server] Returning cached demand plan');
      return res.json(cachedPlan);
    }

    console.log('[Server] Building fresh demand plan from APIs...');
    const livePlan = await buildDemandPlan();

    // If APIs returned actual products, use live data
    if (livePlan.products && livePlan.products.length > 0) {
      cachedPlan = livePlan;
      lastFetchTime = Date.now();
      return res.json(cachedPlan);
    }

    // APIs connected but returned no data — fall through to fallback
    console.log('[Server] APIs returned 0 products, falling back to static data');
    throw new Error('APIs returned empty product list');
  } catch (err) {
    console.error('[Server] Using fallback data:', err.message);

    // Fall back to static data files if APIs are unreachable
    try {
      const productsPath = path.join(__dirname, 'data_products.json');
      const variantsPath = path.join(__dirname, 'data_variants.json');

      if (fs.existsSync(productsPath) && fs.existsSync(variantsPath)) {
        const products = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
        const variants = JSON.parse(fs.readFileSync(variantsPath, 'utf8'));

        // Check for live browser data (posted from fetch-live.html)
        const hasLiveUnleashed = liveUnleashed && (Object.keys(liveUnleashed.poMap || {}).length > 0 || Object.keys(liveUnleashed.sohMap || {}).length > 0);
        const hasLiveShopify = liveShopify && liveShopify.velocityRecent;

        if (hasLiveUnleashed) console.log('[Server] Merging live Unleashed data');
        if (hasLiveShopify) console.log('[Server] Merging live Shopify velocity data');

        // Enrich static products with computed demand fields + live data overlays
        const settings = { planningWeeks: 8, leadTimeWeeks: 12, safetyBufferWeeks: 2 };
        const enriched = products.map(p => {
          let vel = p.weeklyVelocity || 0;
          let soh = p.stockOnHand || 0;
          let onPurchase = p.onPurchase || 0;
          let purchaseOrders = [];

          // Overlay live Unleashed SOH + POs
          // Build normalised lookup maps for case/whitespace-insensitive matching
          if (hasLiveUnleashed) {
            const normKey = (s) => (s || '').trim().toUpperCase();
            const normSohMap = {};
            const normPoMap = {};
            for (const [k, v] of Object.entries(liveUnleashed.sohMap || {})) { normSohMap[normKey(k)] = v; }
            for (const [k, v] of Object.entries(liveUnleashed.poMap || {})) { normPoMap[normKey(k)] = v; }

            const nParent = normKey(p.parentSku);
            if (normSohMap[nParent] !== undefined) {
              soh = normSohMap[nParent];
            }
            if (normPoMap[nParent]) {
              onPurchase = normPoMap[nParent].total;
              purchaseOrders = normPoMap[nParent].orders || [];
            }
            // Also check variant SKUs for PO matching
            const relatedVariants = variants.filter(v => v.parentSku === p.parentSku);
            for (const v of relatedVariants) {
              const nVar = normKey(v.variantSku);
              if (normSohMap[nVar] !== undefined && normSohMap[nParent] === undefined) {
                soh += normSohMap[nVar];
              }
              if (normPoMap[nVar]) {
                onPurchase += normPoMap[nVar].total;
                purchaseOrders.push(...(normPoMap[nVar].orders || []));
              }
            }
          }

          // Overlay live Shopify velocity (recalculate weighted)
          if (hasLiveShopify) {
            const recent = liveShopify.velocityRecent || {};
            const q4 = liveShopify.velocityQ4 || {};
            const q3 = liveShopify.velocityQ3 || {};
            // Sum across all variant SKUs for this parent
            const relatedVariants = variants.filter(v => v.parentSku === p.parentSku);
            const allSkus = [p.parentSku, ...relatedVariants.map(v => v.variantSku)];
            let r = 0, r4 = 0, r3 = 0;
            for (const sku of allSkus) {
              r += recent[sku] || 0;
              r4 += q4[sku] || 0;
              r3 += q3[sku] || 0;
            }
            const vel8wk = r / 8;  // weekly
            const velQ4 = r4 / (92/7);
            const velQ3 = r3 / (92/7);
            vel = vel8wk * 0.5 + velQ4 * 0.3 + velQ3 * 0.2;
          }

          const available = soh + onPurchase;
          const weeksOfStock = vel > 0 ? Math.round((available / vel) * 10) / 10 : 999;
          const demand8wk = Math.round(vel * settings.planningWeeks);
          const minStock = Math.round(vel * settings.safetyBufferWeeks);
          const maxStock = Math.round(vel * (settings.leadTimeWeeks + settings.planningWeeks));
          const reorderPoint = Math.round(vel * settings.leadTimeWeeks);
          const reorderQty = Math.max(0, maxStock - available);

          let status = 'OK';
          if (available <= minStock) status = 'CRITICAL';
          else if (available <= reorderPoint) status = 'ORDER NOW';
          else if (weeksOfStock <= settings.planningWeeks) status = 'LOW';

          let reorderDate = null;
          if (vel > 0 && weeksOfStock < 999) {
            const weeksUntilReorder = Math.max(0, (available - reorderPoint) / vel);
            const d = new Date();
            d.setDate(d.getDate() + Math.round(weeksUntilReorder * 7));
            reorderDate = d.toISOString().split('T')[0];
          }

          return {
            ...p,
            stockOnHand: soh, onPurchase, weeklyVelocity: Math.round(vel * 100) / 100,
            weeksOfStock, demand8wk, minStock, maxStock, reorderPoint, reorderQty, reorderDate, status,
            purchaseOrders,
          };
        });

        const fallbackPlan = {
          products: enriched,
          variants,
          meta: {
            generatedAt: new Date().toISOString(),
            settings,
            sources: {
              soh: hasLiveUnleashed ? 'Unleashed (live)' : 'Static (fallback)',
              purchaseOrders: hasLiveUnleashed ? 'Unleashed (live)' : 'None',
              velocity: hasLiveShopify ? 'Shopify (live weighted)' : 'Static ABC analysis (fallback)',
              productCatalog: 'Static + live overlays',
            },
          },
        };

        cachedPlan = fallbackPlan;
        lastFetchTime = Date.now();
        console.log('[Server] Serving fallback data: ' + enriched.length + ' products');
        return res.json(fallbackPlan);
      }
    } catch (fallbackErr) {
      console.error('[Server] Fallback also failed:', fallbackErr.message);
    }

    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/unleashed/purchase-orders
 * Raw Unleashed PO data by SKU
 */
app.get('/api/unleashed/purchase-orders', async (req, res) => {
  try {
    const data = await unleashed.fetchPurchaseOrdersBySku();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/unleashed/stock
 * Raw Unleashed stock on hand
 */
app.get('/api/unleashed/stock', async (req, res) => {
  try {
    const data = await unleashed.fetchStockOnHand();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pmasync/stock
 * PMA Sync stock on hand
 */
app.get('/api/pmasync/stock', async (req, res) => {
  try {
    const data = await pmasync.fetchStockOnHand();
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/shopify/products
 * Shopify product catalog
 */
app.get('/api/shopify/products', async (req, res) => {
  try {
    const data = await shopify.fetchAllProducts();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/shopify/velocity
 * Calculated weighted velocity for all SKUs
 */
app.get('/api/shopify/velocity', async (req, res) => {
  try {
    const data = await shopify.calculateWeightedVelocity();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/health
 * Health check — tests connectivity to all APIs
 */
app.get('/api/health', async (req, res) => {
  const health = {
    server: 'ok',
    timestamp: new Date().toISOString(),
    apis: {
      unleashed: 'unknown',
      pmasync: 'unknown',
      yunfulfillment: 'unknown',
      shopify: 'unknown',
    },
  };

  // Test Unleashed
  try {
    await unleashed.unleashedRequest('/StockOnHand', 'pageSize=1&page=1');
    health.apis.unleashed = 'connected';
  } catch (err) {
    health.apis.unleashed = `error: ${err.message}`;
  }

  // Test PMA Sync
  try {
    await pmasync.fetchStockOnHand();
    health.apis.pmasync = 'connected';
  } catch (err) {
    health.apis.pmasync = `error: ${err.message}`;
  }

  // Test Yunfulfillment
  try {
    await yunfulfillment.fetchStockOnHand();
    health.apis.yunfulfillment = 'connected';
  } catch (err) {
    health.apis.yunfulfillment = `error: ${err.message}`;
  }

  // Test Shopify
  try {
    const { data } = await shopify.fetchAllProducts();
    health.apis.shopify = data ? 'connected' : 'no data';
  } catch (err) {
    health.apis.shopify = `error: ${err.message}`;
  }

  res.json(health);
});

// Serve the dashboard for all non-API routes
app.get('*', (req, res) => {
  const dashboardPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(dashboardPath)) {
    res.sendFile(dashboardPath);
  } else {
    res.send(`
      <h1>AMAHC Demand Planner Backend</h1>
      <p>Server is running. Place your dashboard HTML in <code>public/index.html</code>.</p>
      <p>API endpoints:</p>
      <ul>
        <li><a href="/api/health">/api/health</a> - API connectivity check</li>
        <li><a href="/api/demand-plan">/api/demand-plan</a> - Full demand plan</li>
        <li><a href="/api/unleashed/purchase-orders">/api/unleashed/purchase-orders</a> - Unleashed POs</li>
        <li><a href="/api/unleashed/stock">/api/unleashed/stock</a> - Unleashed SOH</li>
        <li><a href="/api/shopify/products">/api/shopify/products</a> - Shopify products</li>
        <li><a href="/api/shopify/velocity">/api/shopify/velocity</a> - Shopify velocity</li>
      </ul>
    `);
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  A Man & His Cave — Demand Planner Backend   ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  Dashboard:  http://localhost:${PORT}            ║`);
  console.log(`║  Health:     http://localhost:${PORT}/api/health  ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log('API Config:');
  console.log(`  Shopify:        ${process.env.SHOPIFY_STORE || 'NOT SET'}`);
  console.log(`  Unleashed:      ${process.env.UNLEASHED_API_ID ? 'Configured' : 'NOT SET'}`);
  console.log(`  PMA Sync:       ${process.env.PMA_SYNC_USERNAME ? 'Configured' : 'NOT SET'}`);
  console.log(`  Yunfulfillment:  ${process.env.YUN_USERNAME ? 'Configured' : 'NOT SET'}`);
  console.log('');
});
