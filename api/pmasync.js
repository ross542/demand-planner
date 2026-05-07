/**
 * PMA Sync API Integration
 * Pulls Stock on Hand via session-based auth against pmasync.packshipdone.com
 *
 * Auth: POST /login/authenticate with username/password → session cookie
 * Data: POST /stock-holding/fetch with session cookie
 */

const fetch = require('node-fetch');

const BASE_URL = 'https://pmasync.packshipdone.com';

let _sessionCookie = null;

async function login() {
  const username = process.env.PMA_SYNC_USERNAME || process.env.PMA_SYNC_API_KEY;
  const password = process.env.PMA_SYNC_PASSWORD || process.env.PMA_SYNC_API_SECRET;

  if (!username || !password) {
    throw new Error('PMA_SYNC_USERNAME and PMA_SYNC_PASSWORD must be set in .env');
  }

  const body = new URLSearchParams();
  body.append('username', username);
  body.append('password', password);

  const res = await fetch(`${BASE_URL}/login/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });

  const cookies = res.headers.raw()['set-cookie'];
  if (!cookies || !cookies.length) {
    throw new Error(`PMA Sync login failed (HTTP ${res.status}) — check credentials`);
  }

  _sessionCookie = cookies.map(c => c.split(';')[0]).join('; ');
  console.log(`[PMA Sync] Logged in successfully`);
  return _sessionCookie;
}

async function pmaRequest(endpoint, body = {}) {
  if (!_sessionCookie) await login();

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': _sessionCookie,
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });

  if (res.status === 401 || res.status === 302 || res.status === 303) {
    // Session expired — re-login once
    _sessionCookie = null;
    await login();
    return pmaRequest(endpoint, body);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PMA Sync ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Fetch all stock on hand from PMA Sync
 * Returns: { [sku]: { stockOnHand } }
 * Aggregates SOH across all warehouse locations per SKU
 */
async function fetchStockOnHand() {
  const stockMap = {};
  let page = 1;
  const limit = 300;

  let actualPageSize = null;

  while (true) {
    const data = await pmaRequest('/stock-holding/fetch', { page, limit });
    const items = data.products || [];
    const totalResults = data.total_results || 0;

    for (const item of items) {
      const sku = item.sku_code;
      if (!sku) continue;
      const soh = parseInt(item.soh, 10) || 0;
      if (!stockMap[sku]) stockMap[sku] = { stockOnHand: 0 };
      stockMap[sku].stockOnHand += soh;
    }

    // Detect actual page size on first page (endpoint may ignore limit param)
    if (page === 1 && items.length > 0) {
      actualPageSize = items.length;
    }

    const effectivePageSize = actualPageSize || limit;
    const totalPages = Math.ceil(totalResults / effectivePageSize);
    console.log(`[PMA Sync] Page ${page}/${totalPages}: ${items.length} items (total: ${totalResults})`);

    if (items.length === 0 || page >= totalPages) break;
    page++;
  }

  console.log(`[PMA Sync] SOH loaded: ${Object.keys(stockMap).length} unique SKUs`);
  return Object.keys(stockMap).length > 0 ? stockMap : null;
}

module.exports = { fetchStockOnHand };
