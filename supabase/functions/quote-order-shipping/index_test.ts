import { handler } from "./index.ts";
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
Deno.test("shipping uses owned draft values, handles free rates and fails closed", async () => {
  const originalFetch = globalThis.fetch;
  const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "server", PRINTIFY_API_KEY: "provider", PRINTIFY_SHOP_ID: "123" };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, Deno.env.get(k)]));
  Object.entries(env).forEach(([k,v]) => Deno.env.set(k,v));
  let owned = true, rate: unknown = 0, providerCalls = 0;
  let shopMode = "match";
  const assert = (condition: unknown) => { if (!condition) throw new Error("Assertion failed"); };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) return Response.json({ id, is_anonymous: false });
    if (url.includes("/rest/v1/order_drafts")) {
      assert(url.includes("user_id=eq." + id));
      return Response.json(owned ? { id, product_snapshot: { printify_product_id: "saved-product", variant_id: 55 }, quantity: 2, subtotal_cents: 2000, currency: "usd" } : null);
    }
    if (url.endsWith("/shops.json")) return Response.json([{ id: 999 }, { id: 123 }]);
    if (url.includes("/products/saved-product.json")) {
      if (shopMode === "wrong-shop-400" && url.includes("/999/")) return new Response("Bad request", { status: 400 });
      if (shopMode === "failure") return new Response("Unavailable", { status: 500 });
      if (shopMode === "missing" || url.includes("/999/")) return new Response("Missing", { status: 404 });
      return Response.json({ id: "saved-product", shop_id: 123 });
    }
    assert(url === "https://api.printify.com/v1/shops/123/orders/shipping.json");
    providerCalls++;
    const body = JSON.parse(String(init?.body));
    assert(body.line_items[0].product_id === "saved-product" && body.line_items[0].quantity === 2);
    return Response.json({ standard: rate });
  };
  const request = (authenticated = true) => new Request("https://local.test", {
    method: "POST", headers: authenticated ? { Authorization: "Bearer member" } : {},
    body: JSON.stringify({ orderId: id, quantity: 5, productId: "tampered", address: { first_name: "A", last_name: "B", email: "a@b.com", country: "US", address1: "123 Main", city: "Chicago" } }),
  });
  try {
    assert((await handler(request(false))).status === 401);
    assert(providerCalls === 0);
    const free = await handler(request());
    const body = await free.json();
    assert(free.status === 200 && body.shippingCents === 0 && body.totalBeforeTaxCents === 2000);
    rate = 750;
    assert((await (await handler(request())).json()).totalBeforeTaxCents === 2750);
    rate = "750";
    assert((await handler(request())).status === 422);
    Deno.env.delete("PRINTIFY_SHOP_ID");
    rate = 750;
    assert((await handler(request())).status === 200);
    shopMode = "wrong-shop-400";
    assert((await handler(request())).status === 200);
    const beforeLookupErrors = providerCalls;
    shopMode = "missing";
    assert((await handler(request())).status === 409 && providerCalls === beforeLookupErrors);
    shopMode = "failure";
    assert((await handler(request())).status === 503 && providerCalls === beforeLookupErrors);
    owned = false;
    const before = providerCalls;
    assert((await handler(request())).status === 404 && providerCalls === before);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k,v] of Object.entries(previous)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k,v); }
  }
});
