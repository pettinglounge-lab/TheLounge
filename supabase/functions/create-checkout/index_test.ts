import { handler } from "./index.ts";
Deno.test("checkout verifies ownership, requotes, persists and reuses one Stripe session", async () => {
  const original = fetch;
  const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "server", STRIPE_SECRET_KEY: "sk_live_fixture", PRINTIFY_API_KEY: "provider", PRINTIFY_SHOP_ID: "123" };
  const old = Object.fromEntries(Object.keys(env).map(k => [k, Deno.env.get(k)]));
  Object.entries(env).forEach(([k,v]) => Deno.env.set(k,v));
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  let attempt: any = null, creates = 0, owned = true, rate = 500;
  const assert = (v: unknown, message: string) => { if (!v) throw new Error(message); };
  const session = { id: "cs_live_fixture", status: "open", livemode: true, url: "https://checkout.stripe.com/c/pay/fixture" };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) return Response.json({ id, is_anonymous: false });
    if (url.includes("/order_drafts?")) {
      assert(url.includes("user_id=eq." + id), "Must scope draft to owner");
      return Response.json(owned ? { id, quantity: 2, unit_price_cents: 1000, subtotal_cents: 2000, currency: "usd", product_snapshot: { printify_product_id: "saved", variant_id: 1, title: "Portrait" } } : null);
    }
    if (url.includes("/order_checkouts")) {
      if (init?.method === "POST") attempt = JSON.parse(String(init.body));
      if (init?.method === "PATCH") Object.assign(attempt, JSON.parse(String(init.body)));
      return Response.json(attempt);
    }
    if (url.endsWith("/shipping.json")) return Response.json({ standard: rate });
    if (url.endsWith("/customers")) return Response.json({ id: "cus_fixture" });
    if (url.endsWith("/checkout/sessions")) {
      creates++;
      const params = new URLSearchParams(String(init?.body));
      assert(params.get("line_items[0][price_data][unit_amount]") === "1000", "Server price");
      assert(params.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") === "500", "Server shipping");
      assert(params.get("automatic_tax[enabled]") === "true", "Calculate tax");
      assert(params.get("metadata[purpose]") === "portrait_order", "Webhook routing");
      return Response.json(session);
    }
    if (url.endsWith("/checkout/sessions/cs_live_fixture")) return Response.json(session);
    throw new Error("Unexpected request " + url);
  };
  const request = (token = "member") => new Request("https://local.test", { method: "POST", headers: token ? { Authorization: "Bearer " + token } : {}, body: JSON.stringify({ orderId: id, shippingCents: 500, unit_price_cents: 1, address: { first_name: "A", last_name: "B", email: "a@b.com", country: "US", address1: "1 Main", city: "Chicago" } }) });
  try {
    assert((await handler(request(""))).status === 401, "Reject unsigned request");
    owned = false;
    assert((await handler(request())).status === 404 && creates === 0, "Reject other owner's draft");
    owned = true; rate = 600;
    assert((await handler(request())).status === 409 && creates === 0, "Reject changed quote before payment");
    rate = 500;
    assert((await handler(request())).status === 200 && creates === 1, "Create checkout");
    assert((await handler(request())).status === 200 && creates === 1, "Reuse checkout");
    session.status = "complete";
    assert((await handler(request())).status === 409 && creates === 1, "Never create another session for paid draft");
    session.status = "expired";
    assert((await handler(request())).status === 409 && creates === 1, "Expired session requires new draft");
  } finally {
    globalThis.fetch = original;
    Object.entries(old).forEach(([k,v]) => v === undefined ? Deno.env.delete(k) : Deno.env.set(k,v));
  }
});
