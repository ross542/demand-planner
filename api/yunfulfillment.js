/**
 * Yunfulfillment YFOMS API Integration
 * Pulls Stock on Hand via session-based auth against yfoms.yunexpress.com
 *
 * Auth: POST /login/dologin with account/password → PHPSESSID session cookie
 * Data: POST /product/inventory-wms/list/page/1/pageSize/200
 *
 * Response fields:
 *   product_sku    → matches AMAHC internal SKU
 *   pi_sellable    → saleable (available) stock = SOH
 */

const fetch = require('node-fetch');

const BASE_URL = 'https://yfoms.yunexpress.com';

let _sessionCookie = null;

/**
 * Authenticate with YFOMS portal, store session cookie
 */
async function login() {
  const username = process.env.YUN_USERNAME;
  const password = process.env.YUN_PASSWORD;

  if (!username || !password) {
    throw new Error('YUN_USERNAME and YUN_PASSWORD must be set in .env');
  }

  // Step 1: GET login page to initialise PHPSESSID + SERVERID
  const initRes = await fetch(`${BASE_URL}/default/index/logout`, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const initCookies = (initRes.headers.raw()['set-cookie'] || [])
    .map(c => c.split(';')[0])
    .filter(c => !c.includes('=deleted') && c.includes('='))
    .join('; ');

  // Step 2: POST credentials — password is base64-encoded before sending
  // (the YFOMS login form does btoa(password) client-side before submission)
  const encodedPassword = Buffer.from(password).toString('base64');
  const body = new URLSearchParams();
  body.append('userName', username);
  body.append('userPass', encodedPassword);

  const loginRes = await fetch(`${BASE_URL}/default/index/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': initCookies,
      'User-Agent': 'Mozilla/5.0',
    },
    body: body.toString(),
    redirect: 'manual',
  });

  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginBody.state) {
    throw new Error(`Yunfulfillment login failed: ${loginBody.message || loginRes.status} — check YUN_USERNAME and YUN_PASSWORD in .env`);
  }

  // Merge init + login cookies, deduplicate by name
  const loginCookies = loginRes.headers.raw()['set-cookie'] || [];
  const cookieMap = {};
  for (const raw of [...initCookies.split('; ').map(c => c + ';'), ...loginCookies]) {
    const kv = raw.split(';')[0];
    const eq = kv.indexOf('=');
    if (eq > 0) cookieMap[kv.substring(0, eq).trim()] = kv.substring(eq + 1).trim();
  }
  _sessionCookie = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
  console.log('[Yunfulfillment] Logged in successfully');
  return _sessionCookie;
}

/**
 * Make an authenticated POST request to YFOMS
 */
async function yunRequest(endpoint, formBody = '') {
  if (!_sessionCookie) await login();

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': _sessionCookie,
    },
    body: formBody,
  });

  // Session expired
  if (res.status === 401 || res.status === 302) {
    _sessionCookie = null;
    await login();
    return yunRequest(endpoint, formBody);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Yunfulfillment ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Session expired at API level (HTTP 200 but reLogin flag set)
  if (data && data.reLogin === 1) {
    _sessionCookie = null;
    await login();
    return yunRequest(endpoint, formBody);
  }

  return data;
}

/**
 * Fetch all stock on hand from Yunfulfillment YFOMS
 * Returns: { [product_sku]: { stockOnHand: number } }
 *
 * The pi_sellable field = saleable/available units (displayed in red on portal)
 * Yunfulfillment holds AMAHC's China-based LED signs & accessories
 */
async function fetchStockOnHand() {
  const stockMap = {};

  // Empty filter body = fetch all products
  const emptyFilter = 'order_by=&ac=&export_id=&export_type=&early_warning=&timing_hour=&timing_minute=&product_barcode_type=&product_barcode=&reference_no=&product_name=&qty_type=&qty_from=&qty_to=&morequery_field=&morequery_value=&item_ean=';

  // Fetch page 1 with large page size to get all records at once
  const data = await yunRequest('/product/inventory-wms/list/page/1/pageSize/200', emptyFilter);

  if (!data || data.state !== 1) {
    throw new Error(`Yunfulfillment API returned error: ${JSON.stringify(data)}`);
  }

  const items = data.data || [];
  const total = parseInt(data.total, 10) || 0;

  for (const item of items) {
    const sku = item.product_sku;
    if (!sku) continue;
    const soh = parseInt(item.pi_sellable, 10) || 0;
    if (!stockMap[sku]) stockMap[sku] = { stockOnHand: 0 };
    stockMap[sku].stockOnHand += soh;
  }

  // If more pages exist, fetch them
  if (total > items.length) {
    const pageSize = items.length || 200;
    const totalPages = Math.ceil(total / pageSize);
    for (let page = 2; page <= totalPages; page++) {
      const pageData = await yunRequest(`/product/inventory-wms/list/page/${page}/pageSize/${pageSize}`, emptyFilter);
      for (const item of (pageData.data || [])) {
        const sku = item.product_sku;
        if (!sku) continue;
        const soh = parseInt(item.pi_sellable, 10) || 0;
        if (!stockMap[sku]) stockMap[sku] = { stockOnHand: 0 };
        stockMap[sku].stockOnHand += soh;
      }
    }
  }

  console.log(`[Yunfulfillment] SOH loaded: ${Object.keys(stockMap).length} SKUs (total inventory: ${total})`);
  return stockMap;
}

module.exports = { fetchStockOnHand };
