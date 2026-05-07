/**
 * Data Aggregation Layer
 * Maps variant-level API data to parent SKUs for the demand planner
 *
 * Parent SKU = first variant SKU per Shopify handle
 * All stock, PO, and velocity data is rolled up from variants -> parent
 */

const shopify = require('./shopify');
const unleashed = require('./unleashed');
const pmasync = require('./pmasync');
const yunfulfillment = require('./yunfulfillment');

// Normalise SKU strings for cross-system matching (trim + uppercase)
const normSku = (s) => (s || '').trim().toUpperCase();

// Default planning parameters
const DEFAULTS = {
  planningWeeks: 8,
  leadTimeWeeks: 12,
  safetyBufferWeeks: 2,
};

/**
 * Build the complete demand planner dataset from all 3 APIs
 * Returns the full product array ready for the dashboard
 */
async function buildDemandPlan(settings = {}) {
  const config = { ...DEFAULTS, ...settings };

  console.log('\n=== Building Demand Plan ===');
  console.log(`Planning: ${config.planningWeeks}wk | Lead: ${config.leadTimeWeeks}wk | Safety: ${config.safetyBufferWeeks}wk`);

  // 1. Fetch data from all sources in parallel
  const [shopifyProducts, velocityData, unleashedPOs, unleashedSOH, pmaSyncSOH, yunSOH] = await Promise.all([
    shopify.fetchAllProducts().catch(err => { console.warn('[Aggregator] Shopify products failed:', err.message); return null; }),
    shopify.calculateWeightedVelocity().catch(err => { console.warn('[Aggregator] Shopify velocity failed:', err.message); return null; }),
    unleashed.fetchPurchaseOrdersBySku().catch(err => { console.warn('[Aggregator] Unleashed POs failed:', err.message); return null; }),
    unleashed.fetchStockOnHand().catch(err => { console.warn('[Aggregator] Unleashed SOH failed:', err.message); return null; }),
    pmasync.fetchStockOnHand().catch(err => { console.warn('[Aggregator] PMA Sync SOH failed:', err.message); return null; }),
    yunfulfillment.fetchStockOnHand().catch(err => { console.warn('[Aggregator] Yunfulfillment SOH failed:', err.message); return null; }),
  ]);

  // 2. Build parent SKU -> variant SKU mapping from Shopify
  //    All lookup keys are normalised (trimmed + uppercased) so that
  //    PMA Sync / Unleashed SKUs match even with minor formatting diffs.
  const parentToVariants = {}; // { NORM_parentSku: [variantSku1, ...] }
  const variantToParent = {};  // { NORM_variantSku: parentSku (original) }
  const normToOrigParent = {}; // { NORM_parentSku: parentSku (original) }

  if (shopifyProducts) {
    for (const [parentSku, product] of Object.entries(shopifyProducts)) {
      const nParent = normSku(parentSku);
      const variantSkus = product.variants.map(v => v.sku).filter(Boolean);
      parentToVariants[nParent] = variantSkus;
      normToOrigParent[nParent] = parentSku;
      for (const vSku of variantSkus) {
        variantToParent[normSku(vSku)] = parentSku;
      }
    }
    console.log(`[Aggregator] ${Object.keys(parentToVariants).length} parent SKUs, ${Object.keys(variantToParent).length} variant SKUs mapped`);
  }

  // 3. Roll up variant-level velocity to parent SKU
  //    Shopify velocity fields: velRecent (last 8wk), velMid (prior 8wk), velEarly (earliest 8wk)
  const parentVelocity = {};
  if (velocityData) {
    for (const [sku, vel] of Object.entries(velocityData)) {
      const parent = variantToParent[normSku(sku)] || sku;
      if (!parentVelocity[parent]) {
        parentVelocity[parent] = { velRecent: 0, velMid: 0, velEarly: 0, weeklyVelocity: 0 };
      }
      parentVelocity[parent].velRecent += vel.velRecent || 0;
      parentVelocity[parent].velMid += vel.velMid || 0;
      parentVelocity[parent].velEarly += vel.velEarly || 0;
      parentVelocity[parent].weeklyVelocity += vel.weeklyVelocity || 0;
    }
  }

  // 4. SOH per parent SKU
  //    PMA Sync = source of truth for AU/local stock (Unleashed duplicates this, so excluded)
  //    Yunfulfillment = separate China warehouse, additive on top of PMA Sync
  const parentSOH = {};
  const sohSourceNames = [];

  // Step A: PMA Sync (primary SOH source)
  if (pmaSyncSOH) {
    sohSourceNames.push('PMA Sync');
    for (const [sku, stock] of Object.entries(pmaSyncSOH)) {
      const nSku = normSku(sku);
      const parent = variantToParent[nSku] || (normToOrigParent[nSku] || sku);
      if (parentToVariants[nSku] || !variantToParent[nSku]) {
        if (!parentSOH[parent]) parentSOH[parent] = 0;
        parentSOH[parent] += stock.stockOnHand || 0;
      }
    }
  }

  // Step B: Yunfulfillment (separate China warehouse — additive)
  if (yunSOH) {
    sohSourceNames.push('Yunfulfillment');
    for (const [sku, stock] of Object.entries(yunSOH)) {
      const nSku = normSku(sku);
      const parent = variantToParent[nSku] || (normToOrigParent[nSku] || sku);
      if (parentToVariants[nSku] || !variantToParent[nSku]) {
        if (!parentSOH[parent]) parentSOH[parent] = 0;
        parentSOH[parent] += stock.stockOnHand || 0;
      }
    }
  }

  // Note: Unleashed SOH is intentionally excluded — it duplicates PMA Sync inventory
  const sohSourceName = sohSourceNames.length > 0 ? sohSourceNames.join(' + ') : 'None';
  console.log(`[Aggregator] SOH sources: ${sohSourceName}`);

  // 5. Roll up POs to parent SKU with PO detail
  const parentPOs = {};
  if (unleashedPOs) {
    for (const [sku, poData] of Object.entries(unleashedPOs)) {
      const nSku = normSku(sku);
      const parent = variantToParent[nSku] || (normToOrigParent[nSku] || sku);
      if (!parentPOs[parent]) {
        parentPOs[parent] = { totalOnOrder: 0, purchaseOrders: [] };
      }
      parentPOs[parent].totalOnOrder += poData.totalOnOrder;
      parentPOs[parent].purchaseOrders.push(...poData.purchaseOrders);
    }
  }

  // 6. Assemble the master product list
  //    Only include Shopify products where at least one SKU (parent or variant)
  //    exists in PMA Sync. PMA Sync is the source of truth for which products
  //    we actively stock/sell.
  const products = [];
  const variantDetails = [];

  // Build normalised SKU sets for PMA Sync and Yunfulfillment
  const pmaSyncSkuSet = new Set();
  if (pmaSyncSOH) {
    for (const sku of Object.keys(pmaSyncSOH)) pmaSyncSkuSet.add(normSku(sku));
  }
  const yunSkuSet = new Set();
  if (yunSOH) {
    for (const sku of Object.keys(yunSOH)) yunSkuSet.add(normSku(sku));
  }
  console.log(`[Aggregator] PMA Sync: ${pmaSyncSkuSet.size} SKUs | Yunfulfillment: ${yunSkuSet.size} SKUs`);

  // Filter Shopify catalog to only products tracked by PMA Sync or Yunfulfillment.
  // When both SOH sources are down we return an empty list rather than flooding
  // the dashboard with the full Shopify catalog.
  const allParentSkus = shopifyProducts
    ? Object.keys(shopifyProducts)
    : Object.keys(parentVelocity);

  const parentSkus = allParentSkus.filter(parentSku => {
    const nParent = normSku(parentSku);
    if (pmaSyncSkuSet.has(nParent) || yunSkuSet.has(nParent)) return true;
    const variants = shopifyProducts?.[parentSku]?.variants || [];
    for (const v of variants) {
      const nv = normSku(v.sku);
      if (pmaSyncSkuSet.has(nv) || yunSkuSet.has(nv)) return true;
    }
    return false;
  });

  console.log(`[Aggregator] Products in PMA/YUN: ${parentSkus.length} / ${allParentSkus.length}`);

  for (const parentSku of parentSkus) {
    const shopifyProduct = shopifyProducts?.[parentSku] || {};
    const velocity = parentVelocity[parentSku] || { velRecent: 0, velMid: 0, velEarly: 0, weeklyVelocity: 0 };
    const soh = parentSOH[parentSku] || 0;
    const poData = parentPOs[parentSku] || { totalOnOrder: 0, purchaseOrders: [] };

    const weeklyVel = velocity.weeklyVelocity;
    const available = soh + poData.totalOnOrder;
    const weeksOfStock = weeklyVel > 0 ? Math.round((available / weeklyVel) * 10) / 10 : 999;
    const demand8wk = Math.round(weeklyVel * config.planningWeeks);
    const minStock = Math.round(weeklyVel * config.safetyBufferWeeks);
    const maxStock = Math.round(weeklyVel * (config.leadTimeWeeks + config.planningWeeks));
    const reorderPoint = Math.round(weeklyVel * config.leadTimeWeeks);
    const reorderQty = Math.max(0, maxStock - available);

    // Status
    let status = 'OK';
    if (available <= minStock) status = 'CRITICAL';
    else if (available <= reorderPoint) status = 'ORDER NOW';
    else if (weeksOfStock <= config.planningWeeks) status = 'LOW';

    // Reorder date
    let reorderDate = null;
    if (weeklyVel > 0 && weeksOfStock < 999) {
      const weeksUntilReorder = Math.max(0, (soh + poData.totalOnOrder - reorderPoint) / weeklyVel);
      const reorderDateObj = new Date();
      reorderDateObj.setDate(reorderDateObj.getDate() + Math.round(weeksUntilReorder * 7));
      reorderDate = reorderDateObj.toISOString().split('T')[0];
    }

    // Grade based on weekly velocity (A/B/C)
    let grade = 'C';
    if (weeklyVel >= 2) grade = 'A';
    else if (weeklyVel >= 0.5) grade = 'B';

    products.push({
      grade,
      parentSku,
      name: shopifyProduct.title || parentSku,
      type: shopifyProduct.type || '',
      variantCount: shopifyProduct.variants?.length || 1,
      stockOnHand: soh,
      onPurchase: poData.totalOnOrder,
      weeklyVelocity: Math.round(weeklyVel * 100) / 100,
      velRecent: velocity.velRecent,
      velMid: velocity.velMid,
      velEarly: velocity.velEarly,
      weeksOfStock,
      demand8wk,
      minStock,
      maxStock,
      reorderPoint,
      reorderQty,
      reorderDate,
      status,
      purchaseOrders: poData.purchaseOrders,
    });

    // Build variant details
    if (shopifyProduct.variants) {
      for (const variant of shopifyProduct.variants) {
        const vVel = velocityData?.[variant.sku] || { velRecent: 0, velMid: 0, velEarly: 0, weeklyVelocity: 0 };
        variantDetails.push({
          grade,
          parentSku,
          name: shopifyProduct.title || parentSku,
          variantSku: variant.sku,
          variantTitle: variant.title,
          velRecent: vVel.velRecent,
          velMid: vVel.velMid,
          velEarly: vVel.velEarly,
          weightedDaily: Math.round((vVel.weeklyVelocity / 7) * 1000) / 1000,
          weightedWeekly: Math.round(vVel.weeklyVelocity * 100) / 100,
        });
      }
    }
  }

  // Sort by weekly velocity descending
  products.sort((a, b) => b.weeklyVelocity - a.weeklyVelocity);

  console.log(`\n=== Demand Plan Complete ===`);
  console.log(`Products: ${products.length} | Variants: ${variantDetails.length}`);
  console.log(`SOH source: ${sohSourceName} | POs: ${unleashedPOs ? 'Unleashed' : 'None'} | Velocity: ${velocityData ? 'Shopify' : 'None'}`);

  return {
    products,
    variants: variantDetails,
    meta: {
      generatedAt: new Date().toISOString(),
      settings: config,
      sources: {
        soh: sohSourceName,
        purchaseOrders: unleashedPOs ? 'Unleashed' : 'None',
        velocity: velocityData ? 'Shopify (weighted)' : 'None',
        productCatalog: shopifyProducts ? 'Shopify' : 'None',
      },
    },
  };
}

module.exports = { buildDemandPlan };
