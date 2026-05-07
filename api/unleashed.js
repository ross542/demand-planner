/**
 * Unleashed API Integration
 * Pulls Purchase Orders with HMAC-SHA256 authentication
 * Docs: https://apidocs.unleashedsoftware.com/
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

const BASE_URL = 'https://api.unleashedsoftware.com';

// Unleashed returns dates in Microsoft JSON format: /Date(milliseconds)/
function parseUnleashedDate(val) {
  if (!val) return null;
  const match = String(val).match(/\/Date\((-?\d+)\)\//);
  if (match) return new Date(parseInt(match[1], 10));
  const d = new Date(val);
  return isNaN(d) ? null : d;
}

function formatDate(val) {
  const d = parseUnleashedDate(val);
  return d ? d.toISOString().split('T')[0] : null;
}

/**
 * Generate HMAC-SHA256 signature for Unleashed API
 * @param {string} queryString - Query string WITHOUT the leading '?'
 * @returns {{ id: string, signature: string }}
 */
function getAuth(queryString = '') {
  const apiId = process.env.UNLEASHED_API_ID;
  const apiKey = process.env.UNLEASHED_API_KEY;

  if (!apiId || !apiKey) {
    throw new Error('UNLEASHED_API_ID and UNLEASHED_API_KEY must be set in .env');
  }

  const signature = crypto
    .createHmac('sha256', apiKey)
    .update(queryString, 'utf8')
    .digest('base64');

  return { id: apiId, signature };
}

/**
 * Make an authenticated request to Unleashed API
 * @param {string} endpoint - e.g. '/PurchaseOrders'
 * @param {string} queryString - e.g. 'orderStatus=Open'
 * @returns {Promise<object>}
 */
async function unleashedRequest(endpoint, queryString = '') {
  const auth = getAuth(queryString);
  const url = queryString
    ? `${BASE_URL}${endpoint}?${queryString}`
    : `${BASE_URL}${endpoint}`;

  console.log(`[Unleashed] GET ${url}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'api-auth-id': auth.id,
      'api-auth-signature': auth.signature,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'client-type': 'AMAHC/DemandPlanner',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Unleashed API ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Fetch ALL pages of purchase orders from Unleashed
 * Unleashed paginates at 200 items per page
 * @param {string} status - 'Open', 'Completed', 'Parked', etc. Default: all open statuses
 * @returns {Promise<Array>} Array of purchase order objects
 */
async function fetchAllPurchaseOrders(status = '') {
  const allOrders = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const queryParts = [`pageSize=200`, `page=${page}`];
    if (status) queryParts.push(`orderStatus=${status}`);
    const queryString = queryParts.join('&');

    try {
      const data = await unleashedRequest('/PurchaseOrders', queryString);
      const items = data.Items || [];
      allOrders.push(...items);

      console.log(`[Unleashed] PO page ${page}: ${items.length} orders (total: ${allOrders.length})`);

      // Unleashed returns Pagination.NumberOfPages
      const totalPages = data.Pagination?.NumberOfPages || 1;
      hasMore = page < totalPages;
      page++;
    } catch (err) {
      console.error(`[Unleashed] Error on page ${page}:`, err.message);
      hasMore = false;
    }
  }

  return allOrders;
}

/**
 * Fetch purchase orders and extract PO lines mapped by SKU
 * Returns: { [sku]: { poNumber, qty, eta, supplierName, orderDate, lines: [...] } }
 */
async function fetchPurchaseOrdersBySku() {
  // Fetch POs in both Placed and Open statuses to capture all outstanding orders
  const [placedOrders, openOrders] = await Promise.all([
    fetchAllPurchaseOrders('Placed'),
    fetchAllPurchaseOrders('Open'),
  ]);
  // Deduplicate by PO Guid (a PO can only be in one status)
  const seen = new Set();
  const orders = [];
  for (const po of [...placedOrders, ...openOrders]) {
    const id = po.Guid || po.OrderNumber || po.PurchaseOrderNumber;
    if (!seen.has(id)) { seen.add(id); orders.push(po); }
  }
  console.log(`[Unleashed] Total open POs: ${orders.length} (Placed: ${placedOrders.length}, Open: ${openOrders.length})`);

  const skuMap = {};

  for (const po of orders) {
    const poNumber = po.OrderNumber || po.PurchaseOrderNumber || 'N/A';
    const eta = po.RequiredDate || po.DeliveryDate || null;
    const supplierName = po.Supplier?.SupplierName || 'Unknown';
    const orderDate = po.OrderDate || null;

    const lines = po.PurchaseOrderLines || [];

    for (const line of lines) {
      const sku = line.Product?.ProductCode || line.ProductCode || null;
      if (!sku) continue;

      const orderedQty = line.OrderQuantity || 0;
      const receivedQty = line.ReceivedQuantity || 0;
      const outstanding = orderedQty - receivedQty;

      if (outstanding <= 0) continue; // Skip fully received lines

      if (!skuMap[sku]) {
        skuMap[sku] = { totalOnOrder: 0, purchaseOrders: [] };
      }

      skuMap[sku].totalOnOrder += outstanding;
      skuMap[sku].purchaseOrders.push({
        poNumber,
        orderedQty,
        receivedQty,
        outstanding,
        eta: formatDate(eta),
        supplierName,
        orderDate: formatDate(orderDate),
      });
    }
  }

  console.log(`[Unleashed] SKUs with open POs: ${Object.keys(skuMap).length}`);
  return skuMap;
}

/**
 * Fetch stock on hand from Unleashed
 * Returns: { [sku]: { qtyOnHand, availableQty, allocatedQty } }
 */
async function fetchStockOnHand() {
  const stockMap = {};
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const queryString = `pageSize=200&page=${page}`;
    try {
      const data = await unleashedRequest('/StockOnHand', queryString);
      const items = data.Items || [];

      for (const item of items) {
        const sku = item.ProductCode || null;
        if (!sku) continue;

        if (!stockMap[sku]) {
          stockMap[sku] = { qtyOnHand: 0, availableQty: 0, allocatedQty: 0 };
        }
        stockMap[sku].qtyOnHand += item.QtyOnHand || 0;
        stockMap[sku].availableQty += item.AvailableQty || 0;
        stockMap[sku].allocatedQty += item.AllocatedQty || 0;
      }

      console.log(`[Unleashed] SOH page ${page}: ${items.length} items`);
      const totalPages = data.Pagination?.NumberOfPages || 1;
      hasMore = page < totalPages;
      page++;
    } catch (err) {
      console.error(`[Unleashed] SOH error on page ${page}:`, err.message);
      hasMore = false;
    }
  }

  console.log(`[Unleashed] Total SOH SKUs: ${Object.keys(stockMap).length}`);
  return stockMap;
}

module.exports = {
  fetchPurchaseOrdersBySku,
  fetchStockOnHand,
  unleashedRequest,
};
