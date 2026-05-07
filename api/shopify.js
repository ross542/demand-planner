/**
 * Shopify Admin API Integration
 * Pulls products, inventory, and order data for velocity calculation
 * Store: amahc.myshopify.com | API Version: 2024-01
 */

const fetch = require('node-fetch');

function getConfig() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    throw new Error('SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN must be set in .env');
  }

  return {
    baseUrl: `https://${store}/admin/api/2024-01`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  };
}

/**
 * Generic Shopify API request with pagination support
 */
async function shopifyRequest(endpoint, params = {}) {
  const { baseUrl, headers } = getConfig();

  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const url = queryString
    ? `${baseUrl}${endpoint}.json?${queryString}`
    : `${baseUrl}${endpoint}.json`;

  console.log(`[Shopify] GET ${url}`);

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status}: ${text}`);
  }

  // Extract Link header for pagination
  const linkHeader = res.headers.get('link');
  const data = await res.json();

  return { data, linkHeader };
}

/**
 * Parse Shopify Link header for next page URL
 */
function getNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * Fetch ALL products from Shopify (handles pagination)
 * Groups by handle -> first variant SKU = parent SKU
 * Returns: { [parentSku]: { handle, title, type, variants: [{ sku, title, price, inventoryItemId }] } }
 */
async function fetchAllProducts() {
  const { baseUrl, headers } = getConfig();
  const allProducts = [];
  let url = `${baseUrl}/products.json?limit=250&fields=id,handle,title,product_type,variants`;

  while (url) {
    console.log(`[Shopify] Fetching products page...`);
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify products ${res.status}: ${text}`);
    }

    const data = await res.json();
    allProducts.push(...(data.products || []));

    // Pagination via Link header
    const linkHeader = res.headers.get('link');
    url = getNextPageUrl(linkHeader);
  }

  console.log(`[Shopify] Total products fetched: ${allProducts.length}`);

  // Build handle -> parent SKU map
  const productMap = {};
  for (const p of allProducts) {
    const variants = (p.variants || []).map(v => ({
      sku: v.sku || '',
      title: v.title,
      price: parseFloat(v.price) || 0,
      inventoryItemId: v.inventory_item_id,
    }));

    // Parent SKU = first variant's SKU
    const parentSku = variants[0]?.sku || p.handle;

    productMap[parentSku] = {
      handle: p.handle,
      title: p.title,
      type: p.product_type || '',
      variants,
    };
  }

  return productMap;
}

/**
 * Fetch orders within a date range for velocity calculation
 * @param {string} createdAtMin - ISO date string
 * @param {string} createdAtMax - ISO date string
 * Returns: { [sku]: unitsSold }
 */
async function fetchOrderVelocity(createdAtMin, createdAtMax) {
  const { baseUrl, headers } = getConfig();
  const skuSales = {};

  let url = `${baseUrl}/orders.json?limit=250&status=any&financial_status=paid&created_at_min=${createdAtMin}&created_at_max=${createdAtMax}&fields=id,line_items,created_at`;

  while (url) {
    console.log(`[Shopify] Fetching orders page...`);
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify orders ${res.status}: ${text}`);
    }

    const data = await res.json();
    const orders = data.orders || [];

    for (const order of orders) {
      for (const item of (order.line_items || [])) {
        if (item.sku) {
          skuSales[item.sku] = (skuSales[item.sku] || 0) + (item.quantity || 0);
        }
      }
    }

    const linkHeader = res.headers.get('link');
    url = getNextPageUrl(linkHeader);
  }

  console.log(`[Shopify] Order velocity: ${Object.keys(skuSales).length} SKUs with sales`);
  return skuSales;
}

/**
 * Calculate weighted velocity for all SKUs using rolling 8-week windows
 * 50% last 8wk (weeks 1-8) + 30% prior 8wk (weeks 9-16) + 20% earliest 8wk (weeks 17-24)
 * All windows roll from today — no fixed calendar quarters
 * Returns: { [sku]: { velRecent, velMid, velEarly, weeklyVelocity } }
 */
async function calculateWeightedVelocity() {
  const now = new Date();

  // Window 1: most recent 8 weeks (50%)
  const w1End   = now;
  const w1Start = new Date(now); w1Start.setDate(w1Start.getDate() - 56);

  // Window 2: previous 8 weeks before that (30%)
  const w2End   = new Date(w1Start);
  const w2Start = new Date(w1Start); w2Start.setDate(w2Start.getDate() - 56);

  // Window 3: 8 weeks before window 2 (20%)
  const w3End   = new Date(w2Start);
  const w3Start = new Date(w2Start); w3Start.setDate(w3Start.getDate() - 56);

  const windowDays = 56; // each window = 8 weeks = 56 days

  console.log(`[Shopify] Calculating rolling velocity...`);
  console.log(`  Window 1 (50%): ${w1Start.toISOString().split('T')[0]} → ${w1End.toISOString().split('T')[0]}`);
  console.log(`  Window 2 (30%): ${w2Start.toISOString().split('T')[0]} → ${w2End.toISOString().split('T')[0]}`);
  console.log(`  Window 3 (20%): ${w3Start.toISOString().split('T')[0]} → ${w3End.toISOString().split('T')[0]}`);

  // Fetch all three windows in parallel
  const [w1, w2, w3] = await Promise.all([
    fetchOrderVelocity(w1Start.toISOString(), w1End.toISOString()),
    fetchOrderVelocity(w2Start.toISOString(), w2End.toISOString()),
    fetchOrderVelocity(w3Start.toISOString(), w3End.toISOString()),
  ]);

  // Combine all SKUs across all windows
  const allSkus = new Set([
    ...Object.keys(w1),
    ...Object.keys(w2),
    ...Object.keys(w3),
  ]);

  const velocityMap = {};
  for (const sku of allSkus) {
    const velRecent = (w1[sku] || 0) / (windowDays / 7); // weekly rate
    const velMid    = (w2[sku] || 0) / (windowDays / 7);
    const velEarly  = (w3[sku] || 0) / (windowDays / 7);

    // Weighted: 50% recent, 30% mid, 20% early
    // Renormalise weights if a window has no data for this SKU
    let totalWeight = 0;
    let weightedSum = 0;

    if (w1[sku] !== undefined) { weightedSum += velRecent * 0.5; totalWeight += 0.5; }
    if (w2[sku] !== undefined) { weightedSum += velMid    * 0.3; totalWeight += 0.3; }
    if (w3[sku] !== undefined) { weightedSum += velEarly  * 0.2; totalWeight += 0.2; }

    const weeklyVelocity = totalWeight > 0 ? weightedSum / totalWeight : 0;

    velocityMap[sku] = {
      velRecent:       Math.round(velRecent * 100) / 100,
      velMid:          Math.round(velMid    * 100) / 100,
      velEarly:        Math.round(velEarly  * 100) / 100,
      weeklyVelocity:  Math.round(weeklyVelocity * 100) / 100,
    };
  }

  console.log(`[Shopify] Velocity calculated for ${Object.keys(velocityMap).length} SKUs`);
  return velocityMap;
}

module.exports = {
  fetchAllProducts,
  fetchOrderVelocity,
  calculateWeightedVelocity,
};
