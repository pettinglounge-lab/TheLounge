import { handler } from "./index.ts";

const draftId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const sessionId = "cs_live_fixture";
const draft = { id: draftId, user_id: userId, subtotal_cents: 5000,
  currency: "usd", quantity: 2, unit_price_cents: 2500, artwork_path: "private/artwork" };
const paid = { id: sessionId, livemode: true, mode: "payment", status: "complete",
  payment_status: "paid", metadata: { purpose: "portrait_order", draft_id: draftId, user_id: userId },
  client_reference_id: draftId, currency: "usd", amount_subtotal: 5000, amount_total: 5600,
  total_details: { amount_shipping: 500, amount_tax: 100, amount_discount: 0 },
  customer_details: { email: "customer@example.test" },
  collected_information: { shipping_details: { name: "Test Customer",
    address: { line1: "1 Test Street", country: "US" } } } };

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("finalization verifies payments before writing and preserves replay results", async () => {
  const savedFetch = globalThis.fetch;
  const env = { SUPABASE_URL: "https://project.example.test", SUPABASE_SERVICE_ROLE_KEY: "server-secret",
    STRIPE_SECRET_KEY: "sk_live_fixture" };
  const old = Object.fromEntries(Object.keys(env).map(k => [k, Deno.env.get(k)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  let session = structuredClone(paid);
  let writes = 0;
  let reads = 0;
  let rpcFails = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    reads++;
    let body: unknown;
    if (url.includes("/line_items?")) body = { has_more: false, data: [{ quantity: 2,
      currency: "usd", amount_subtotal: 5000, price: { unit_amount: 2500 } }] };
    else if (url.startsWith("https://api.stripe.com/")) body = session;
    else if (url.includes("/rest/v1/order_drafts?")) body = draft;
    else if (url.endsWith("/rpc/finalize_paid_order")) {
      writes++;
      const args = JSON.parse(String(init?.body));
      assert(args.p_total === 5600 && args.p_draft_id === draftId, "Must use verified payment and draft");
      if (rpcFails) return new Response(JSON.stringify({ message: "database unavailable" }), { status: 500 });
      body = { orderId: "order-fixture", status: "paid", replayed: writes > 1 };
    } else throw new Error("Unexpected request: " + url);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const call = (token = "server-secret") => handler(new Request("https://local.test", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, amount: 1, imageUrl: "https://untrusted.test" }),
  }));
  try {
    assert((await call("customer-token")).status === 401 && reads === 0, "Reject customer before any provider call");
    session.payment_status = "unpaid";
    assert((await call()).status === 409 && writes === 0, "Reject unpaid session");
    session = structuredClone(paid);
    session.metadata.user_id = "wrong-owner";
    assert((await call()).status === 409 && writes === 0, "Reject owner mismatch");
    session = structuredClone(paid);
    session.amount_total = 1;
    assert((await call()).status === 409 && writes === 0, "Reject wrong total");
    session = structuredClone(paid);
    session.collected_information.shipping_details.address.line1 = "";
    assert((await call()).status === 409 && writes === 0, "Reject missing shipping address");
    session = structuredClone(paid);
    const first = await call();
    assert(first.status === 200 && (await first.json()).replayed === false, "Create verified order");
    const replay = await call();
    assert(replay.status === 200 && (await replay.json()).replayed === true, "Return database replay result");
    rpcFails = true;
    assert((await call()).status === 503, "Database failures must remain retryable");
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(env)) {
      if (old[key] === undefined) Deno.env.delete(key); else Deno.env.set(key, old[key]!);
    }
  }
});
