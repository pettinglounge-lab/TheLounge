// Deploy with gateway Verify JWT OFF. Customer authentication is checked here.
// Sandbox-only until live prices and the payment webhook are configured.
import { createClient } from "npm:@supabase/supabase-js@2";

const PACKAGES = {
  "100": { price: "price_1UGSVxJjLQheprQIouysm85r", amount: 499 },
  "250": { price: "price_1UGSWVJjLQheprQIBHse76X9", amount: 999 },
  "500": { price: "price_1UGSWwJjLQheprQIorXQ8W5W", amount: 1799 },
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!url || !serviceKey || !stripeKey?.startsWith("sk_test_")) {
      return json(503, { error: "Sandbox checkout is not configured." });
    }
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return json(401, { error: "Sign in to purchase credits." });
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user || data.user.is_anonymous !== false) {
      return json(401, { error: "Sign in to purchase credits." });
    }
    // Until launch, only explicitly listed accounts can create test purchases.
    const testers = (Deno.env.get("STRIPE_TEST_USER_IDS") || "").split(",").map(s => s.trim());
    if (!testers.includes(data.user.id)) return json(403, { error: "Credit purchases are not available yet." });
    let input;
    try { input = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
    const packageId = String(input?.packageId || "");
    const requestId = input?.requestId;
    if (!Object.hasOwn(PACKAGES, packageId) || typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return json(400, { error: "Choose a valid credit package and request ID." });
    }
    const pack = PACKAGES[packageId as keyof typeof PACKAGES];
    const headers = { Authorization: "Bearer " + stripeKey };
    const priceResponse = await fetch("https://api.stripe.com/v1/prices/" + pack.price, {
      headers, signal: AbortSignal.timeout(15000),
    });
    const price = await priceResponse.json();
    if (!priceResponse.ok || !price.active || price.livemode !== false ||
      price.type !== "one_time" || price.currency !== "usd" || price.unit_amount !== pack.amount) {
      return json(503, { error: "This credit package is not configured correctly." });
    }
    const body = new URLSearchParams({
      mode: "payment",
      "payment_method_types[0]": "card",
      "line_items[0][price]": pack.price,
      "line_items[0][quantity]": "1",
      client_reference_id: data.user.id,
      "metadata[purpose]": "credit_reload",
      "metadata[user_id]": data.user.id,
      "metadata[credits]": packageId,
      success_url: "https://pettinglounge.com/account.html?credit_payment=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://pettinglounge.com/account.html?credit_payment=cancelled",
    });
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": "credits:" + data.user.id + ":" + packageId + ":" + requestId.toLowerCase() },
      body, signal: AbortSignal.timeout(20000),
    });
    const checkout = await response.json();
    if (!response.ok || !checkout.url) return json(502, { error: "Unable to open checkout. Please retry." });
    return json(200, { url: checkout.url, sessionId: checkout.id });
  } catch {
    return json(503, { error: "Checkout was interrupted. Please retry with the same request ID." });
  }
}

Deno.serve(handler);
