# A Man & His Cave — Demand Planner Backend

Live demand planner dashboard powered by Unleashed + PMA Sync + Shopify APIs.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Check your .env file has the correct API keys (already pre-filled)
# Edit .env if you need to update any credentials

# 3. Start the server
npm start

# 4. Open your browser
# http://localhost:3001
```

## What It Does

- **Unleashed API** — Pulls open purchase orders (PO#, qty outstanding, ETA, supplier) and stock on hand via HMAC-SHA256 auth
- **PMA Sync API** — Pulls stock on hand (preferred SOH source)
- **Shopify Admin API** — Pulls product catalog and calculates weighted sales velocity (50% last 8wk + 30% Q4-2025 + 20% Q3-2025)
- **Aggregation** — Maps all variant-level data back to parent SKUs (first variant SKU per Shopify handle = parent)
- **Dashboard** — Serves a live React dashboard at http://localhost:3001 with editable SOH/On Purchase, PO detail popups, variant drill-down, and all demand formulas

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/demand-plan` | Full demand plan (products + variants + meta) |
| `GET /api/demand-plan?force=true` | Force refresh (bypass 15-min cache) |
| `GET /api/unleashed/purchase-orders` | Raw Unleashed PO data by SKU |
| `GET /api/unleashed/stock` | Unleashed stock on hand |
| `GET /api/pmasync/stock` | PMA Sync stock on hand |
| `GET /api/shopify/products` | Shopify product catalog |
| `GET /api/shopify/velocity` | Calculated weighted velocity |
| `GET /api/health` | API connectivity status |

## File Structure

```
demand-planner-backend/
  .env                  # API credentials (DO NOT commit)
  package.json
  server.js             # Express server + routes
  api/
    unleashed.js        # Unleashed HMAC-SHA256 auth + PO/SOH fetch
    pmasync.js          # PMA Sync stock + PO fetch
    shopify.js          # Shopify products + order velocity
    aggregator.js       # Maps variant data -> parent SKU demand plan
  public/
    index.html          # Live React dashboard
```

## Configuration

All settings are in `.env`:

```
SHOPIFY_STORE=amahc.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpca_...

PMA_SYNC_API_KEY=463cf...
PMA_SYNC_API_SECRET=761bf...
PMA_SYNC_BASE_URL=https://api.pmasync.com.au  # Optional override

UNLEASHED_API_ID=3c0ce866-...
UNLEASHED_API_KEY=cCfVqd4Hi...

PORT=3001
```

## Troubleshooting

1. **Health check first**: Visit http://localhost:3001/api/health to see which APIs are connected
2. **PMA Sync auth**: If PMA Sync returns 401/403, you may need to adjust the auth headers in `api/pmasync.js` — PMA Sync uses varying auth schemes
3. **Unleashed 403**: Double-check API ID and Key in .env. The HMAC signature is computed from the query string
4. **Shopify rate limits**: The server fetches all orders for 3 time periods — Shopify may throttle at 2 req/sec. The server handles pagination but not rate limiting retries
