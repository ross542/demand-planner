#!/usr/bin/env node
/**
 * Quick API credential test — run this first to check connectivity.
 *
 *   node test-apis.js
 */

require('dotenv').config();
const crypto = require('crypto');
const fetch = require('node-fetch');

async function testUnleashed() {
  console.log('\n── Unleashed API ──');
  const id = process.env.UNLEASHED_API_ID;
  const key = process.env.UNLEASHED_API_KEY;
  if (!id || !key) { console.log('  ✗ Missing UNLEASHED_API_ID or UNLEASHED_API_KEY in .env'); return; }

  const qs = 'pageSize=1&page=1';
  const sig = crypto.createHmac('sha256', key).update(qs).digest('base64');

  try {
    const res = await fetch(`https://api.unleashedsoftware.com/StockOnHand?${qs}`, {
      headers: { 'api-auth-id': id, 'api-auth-signature': sig, 'Accept': 'application/json', 'Content-Type': 'application/json', 'client-type': 'AMAHC/DemandPlanner' }
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Connected! ${(data.Items || []).length} items on page 1, ${data.Pagination?.NumberOfPages || '?'} pages total`);
    } else {
      const text = await res.text();
      console.log(`  ✗ HTTP ${res.status}: ${text}`);
      if (res.status === 403) console.log('  → Check: are the API ID and Key current? Is there an IP whitelist in Unleashed?');
    }
  } catch (e) {
    console.log(`  ✗ Network error: ${e.message}`);
  }
}

async function testShopify() {
  console.log('\n── Shopify API ──');
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) { console.log('  ✗ Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN in .env'); return; }

  try {
    const res = await fetch(`https://${store}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Connected! Store: ${data.shop?.name || store}`);
    } else {
      const text = await res.text();
      console.log(`  ✗ HTTP ${res.status}: ${text.substring(0, 200)}`);
      if (res.status === 401) console.log('  → Check: is the access token current? Does the app have read_products and read_orders scope?');
    }
  } catch (e) {
    console.log(`  ✗ Network error: ${e.message}`);
  }
}

async function testPMASync() {
  console.log('\n── PMA Sync API ──');
  const username = process.env.PMA_SYNC_USERNAME;
  const password = process.env.PMA_SYNC_PASSWORD;
  const baseUrl = process.env.PMA_SYNC_BASE_URL || 'https://pmasync.packshipdone.com';
  if (!username || !password) { console.log('  ✗ Missing PMA_SYNC_USERNAME or PMA_SYNC_PASSWORD in .env'); return; }

  try {
    // Step 1: Login
    const body = new URLSearchParams();
    body.append('username', username);
    body.append('password', password);

    const loginRes = await fetch(`${baseUrl}/login/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });

    const cookies = (loginRes.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    if (!cookies) {
      console.log(`  ✗ Login failed (HTTP ${loginRes.status}) — check credentials`);
      return;
    }

    // Step 2: Fetch stock
    const stockRes = await fetch(`${baseUrl}/stock-holding/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': cookies },
      body: JSON.stringify({ page: 1, limit: 1 }),
    });

    if (stockRes.ok) {
      const data = await stockRes.json();
      console.log(`  ✓ Connected! ${data.total_results} total stock records across all warehouses`);
    } else {
      const text = await stockRes.text();
      console.log(`  ✗ Stock fetch HTTP ${stockRes.status}: ${text.substring(0, 200)}`);
    }
  } catch (e) {
    console.log(`  ✗ Network error: ${e.message}`);
  }
}

async function testYunfulfillment() {
  console.log('\n── Yunfulfillment API ──');
  const username = process.env.YUN_USERNAME;
  const password = process.env.YUN_PASSWORD;
  if (!username || !password) { console.log('  ✗ Missing YUN_USERNAME or YUN_PASSWORD in .env'); return; }

  try {
    // Step 1: Init session + get cookies
    const initRes = await fetch('https://yfoms.yunexpress.com/default/index/logout', { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const initCookies = (initRes.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).filter(c => !c.includes('=deleted')).join('; ');

    // Step 2: Login with base64-encoded password (YFOMS does btoa(password) client-side)
    const encodedPassword = Buffer.from(password).toString('base64');
    const body = new URLSearchParams();
    body.append('userName', username);
    body.append('userPass', encodedPassword);

    const loginRes = await fetch('https://yfoms.yunexpress.com/default/index/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': initCookies, 'User-Agent': 'Mozilla/5.0' },
      body: body.toString(),
      redirect: 'manual',
    });

    const loginBody = await loginRes.json().catch(() => ({}));
    if (!loginBody.state) { console.log(`  ✗ Login failed: ${loginBody.message}`); return; }

    const loginCookies = (loginRes.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]);
    const allCookies = [...initCookies.split('; '), ...loginCookies].filter(Boolean).join('; ');

    // Step 2: Test inventory endpoint
    const stockRes = await fetch('https://yfoms.yunexpress.com/product/inventory-wms/list/page/1/pageSize/5', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': allCookies,
      },
      body: 'order_by=&ac=&export_id=&export_type=&early_warning=&timing_hour=&timing_minute=&product_barcode_type=&product_barcode=&reference_no=&product_name=&qty_type=&qty_from=&qty_to=&morequery_field=&morequery_value=&item_ean=',
    });

    if (stockRes.ok) {
      const data = await stockRes.json();
      if (data.state === 1) {
        console.log(`  ✓ Connected! ${data.total} total SKUs in Yunfulfillment`);
      } else {
        console.log(`  ✗ Login succeeded but inventory fetch failed — check credentials`);
      }
    } else {
      console.log(`  ✗ Inventory fetch HTTP ${stockRes.status}`);
    }
  } catch (e) {
    console.log(`  ✗ Network error: ${e.message}`);
  }
}

(async () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  A Man & His Cave — API Credential Test      ║');
  console.log('╚══════════════════════════════════════════════╝');
  await testUnleashed();
  await testShopify();
  await testPMASync();
  await testYunfulfillment();
  console.log('\n── Done ──');
  console.log('If all 4 show ✓, run: node refresh.js');
  console.log('');
})();
