---
name: woocommerce
title: WooCommerce store operations
description: Use for WooCommerce store work — products, prices, sale prices, stock, variations, orders and order status, refunds, coupons, customers and sales reports — through the WooCommerce REST API.
keywords: woocommerce, woo, shop, store, ecommerce, product, products, price, sale price, stock, inventory, out of stock, sku, variation, variable product, order, orders, order status, refund, coupon, discount code, customer, checkout, sales report, hpos
---

## When this applies

The site runs WooCommerce (`list_plugins` with `search: "woocommerce"`). Other commerce plugins: find their REST namespace the same way and apply the same rules.

## Rules

1. Write store data through `/wc/v3` with `rest_api`, never with `set_content_meta`, `update_content` meta or SQL. Woo keeps prices, stock and orders in lookup tables and caches (and orders in their own tables under HPOS) that raw meta writes leave stale.
2. `discover_rest_routes` with `namespace: "wc/v3"` first; routes and fields vary by version and extensions. No `wc/v3` namespace means WooCommerce is inactive or REST is blocked.
3. Prices and amounts are strings (`"19.99"`). Stock needs `manage_stock: true` before `stock_quantity` counts; variable products keep price and stock on each variation.
4. Order changes have side effects: setting `completed` or adding a customer note emails the customer; a refund with `api_refund` true (the default) sends money back through the payment gateway. Confirm with the owner first, and use `api_refund: false` to only record a refund.
5. Never delete orders or customers; cancel or trash only with explicit instruction. `force: true` is permanent.
6. Prefer one batch call over many single writes: `POST /wc/v3/products/batch` accepts up to 100 items in `create`, `update` and `delete`.

## Procedure

1. `discover_rest_routes` with `namespace: "wc/v3"`.
2. Find a product: `rest_api` with `route: "/wc/v3/products"` and `query: {"sku": "ABC-1"}` or `query: {"search": "hoodie", "per_page": 20}`. Variations: `route: "/wc/v3/products/{id}/variations"`.
3. Update price or stock: `rest_api` with `route: "/wc/v3/products/{id}"`, `method: "PUT"` and `body: {"regular_price": "24.00", "sale_price": "19.00", "manage_stock": true, "stock_quantity": 12}`. For a variation use `route: "/wc/v3/products/{id}/variations/{variation_id}"`. Scheduled sales: `date_on_sale_from` / `date_on_sale_to`.
4. Many products: read them, then `rest_api` with `route: "/wc/v3/products/batch"`, `method: "POST"` and `body: {"update": [{"id": 1, "stock_quantity": 5}]}`. Show the owner the list before sending.
5. Orders: `rest_api` with `route: "/wc/v3/orders"` and `query: {"status": "processing", "per_page": 50}`; change status with `route: "/wc/v3/orders/{id}"`, `method: "PUT"`, `body: {"status": "completed"}`. Private notes: `route: "/wc/v3/orders/{id}/notes"` with `body: {"note": "…", "customer_note": false}`.
6. Refunds (after confirmation): `route: "/wc/v3/orders/{id}/refunds"`, `method: "POST"`, `body: {"amount": "10.00", "reason": "…", "api_refund": false}`.
7. Coupons: `route: "/wc/v3/coupons"`, `method: "POST"`, `body: {"code": "SPRING10", "discount_type": "percent", "amount": "10", "date_expires": "2026-12-31", "usage_limit": 100}`. Types: `percent`, `fixed_cart`, `fixed_product`.
8. Reports: `route: "/wc/v3/reports/sales"` with `query: {"period": "month"}`, `route: "/wc/v3/reports/top_sellers"`; environment and HPOS status: `route: "/wc/v3/system_status"`.
9. `purge_cache` with `scope: "url"` for changed product pages (cache plugins normally exclude cart and checkout).

## Verify

- Re-read the object with `rest_api` GET on the same route: values, `stock_status` and `price` as expected.
- `get_page_html` with `url: "{product permalink}"` and `mode: "text"` shows the price and stock message a shopper sees.

## Report back

List what changed per product or order (old → new), any customer emails or gateway refunds triggered, and anything left for the owner (payment gateway settings, tax, shipping zones, which are best reviewed in WooCommerce → Settings; `rest_api` with `route: "/wc/v3/settings"` lists the setting groups when a change must be scripted).
