// Verify JWT OFF. Real member authentication is checked inside the handler.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handler as quoteShipping } from "../quote-order-shipping/index.ts";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
export async function handler(req: Request) {
  if (req.method === "OPTIONS") return json(200, {});
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  try {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!url || !key || !stripeKey?.startsWith("sk_live_")) return json(503, { error: "Live checkout is not configured." });
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return json(401, { error: "Please sign in to check out." });
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user || auth.user.is_anonymous !== false) return json(401, { error: "Please sign in to check out." });
    let input;
    try { input = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
    if (typeof input?.orderId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.orderId)) return json(400, { error: "Save your order first." });
    const { data: draft, error } = await admin.from("order_drafts").select("*").eq("id", input.orderId).eq("user_id", auth.user.id).maybeSingle();
    if (error) throw error;
    if (!draft) return json(404, { error: "Order not found." });
    const address: Record<string, string> = {};
    for (const field of ["first_name", "last_name", "email", "phone", "country", "address1", "address2", "city", "region", "zip"]) {
      if (typeof (input.address?.[field] ?? "") !== "string") return json(400, { error: "Check your address." });
      address[field] = (input.address?.[field] ?? "").trim();
    }
    address.country = address.country.toUpperCase();
    let { data: attempt, error: attemptError } = await admin.from("order_checkouts").select("*").eq("draft_id", draft.id).maybeSingle();
    if (attemptError) throw attemptError;
    if (!attempt) {
      const quoteResponse = await quoteShipping(new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify({ orderId: draft.id, address }) }));
      const quote = await quoteResponse.json();
      if (!quoteResponse.ok) return json(quoteResponse.status, quote);
      if (quote.shippingCents !== input.shippingCents) return json(409, { error: "Shipping changed. Calculate shipping again.", code: "quote_changed" });
      const params: Record<string, string> = {
        mode: "payment", "payment_method_types[0]": "card",
        client_reference_id: draft.id,
        "metadata[purpose]": "portrait_order", "metadata[draft_id]": draft.id, "metadata[user_id]": auth.user.id,
        "line_items[0][price_data][currency]": draft.currency,
        "line_items[0][price_data][unit_amount]": String(draft.unit_price_cents),
        "line_items[0][price_data][tax_behavior]": "exclusive",
        "line_items[0][price_data][product_data][name]": String(draft.product_snapshot.title || "Custom portrait").slice(0, 250),
        "line_items[0][quantity]": String(draft.quantity),
        "shipping_options[0][shipping_rate_data][display_name]": "Standard shipping",
        "shipping_options[0][shipping_rate_data][type]": "fixed_amount",
        "shipping_options[0][shipping_rate_data][fixed_amount][amount]": String(quote.shippingCents),
        "shipping_options[0][shipping_rate_data][fixed_amount][currency]": draft.currency,
        "shipping_options[0][shipping_rate_data][tax_behavior]": "exclusive",
        "automatic_tax[enabled]": "true",
        "adaptive_pricing[enabled]": "false",
        "expires_at": String(Math.floor(Date.now() / 1000) + 3600),
        "custom_text[submit][message]": `Ships to: ${address.first_name} ${address.last_name}, ${address.address1}, ${address.address2}, ${address.city}, ${address.region} ${address.zip}, ${address.country}. Return to the store to change shipping.`,
        success_url: "https://pettinglounge.com/checkout.html?payment=success&draft_id=" + draft.id,
        cancel_url: "https://pettinglounge.com/checkout.html?payment=cancelled",
      };
      const inserted = await admin.from("order_checkouts").insert({ draft_id: draft.id, address, shipping_cents: quote.shippingCents, stripe_params: params }).select("*").single();
      if (inserted.error) {
        const raced = await admin.from("order_checkouts").select("*").eq("draft_id", draft.id).single();
        if (raced.error || !raced.data) throw inserted.error;
        attempt = raced.data;
      } else attempt = inserted.data;
    }
    if (Object.keys(address).some(k => address[k] !== attempt.address[k])) return json(409, { error: "The shipping address changed. Save a new order.", code: "new_draft_required" });
    const stripeHeaders = { Authorization: "Bearer " + stripeKey, "Stripe-Version": "2025-03-31.basil" };
    const stripe = async (path: string, params?: Record<string, string>, idempotency?: string) => {
      const response = await fetch("https://api.stripe.com/v1/" + path, { method: params ? "POST" : "GET", headers: { ...stripeHeaders, ...(params ? { "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": idempotency! } : {}) }, body: params ? new URLSearchParams(params) : undefined, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("Stripe request failed");
      return await response.json();
    };
    let session;
    if (attempt.stripe_session_id) session = await stripe("checkout/sessions/" + attempt.stripe_session_id);
    else {
      // Never recreate a potentially paid session after Stripe's idempotency window.
      if (Date.now() / 1000 >= Number(attempt.stripe_params.expires_at) - 1800) return json(409, { error: "This checkout attempt needs review before retrying.", code: "checkout_review" });
      const customerParams: Record<string, string> = { email: address.email, name: address.first_name + " " + address.last_name, "shipping[name]": address.first_name + " " + address.last_name };
      for (const [source, target] of Object.entries({ address1: "line1", address2: "line2", city: "city", region: "state", zip: "postal_code", country: "country" })) customerParams[`shipping[address][${target}]`] = address[source];
      if (address.phone) customerParams["shipping[phone]"] = address.phone;
      const customer = await stripe("customers", customerParams, "portrait-customer:" + draft.id);
      session = await stripe("checkout/sessions", { ...attempt.stripe_params, customer: customer.id }, "portrait-checkout:" + draft.id);
      const saved = await admin.from("order_checkouts").update({ stripe_session_id: session.id }).eq("draft_id", draft.id);
      if (saved.error) throw saved.error;
    }
    if (session.status === "complete") return json(409, { error: "This order has already completed checkout. Check your orders." });
    if (session.status === "expired") return json(409, { error: "Checkout expired. Calculate shipping again to start a new order.", code: "new_draft_required" });
    if (session.livemode !== true || session.status !== "open" || typeof session.url !== "string" || new URL(session.url).origin !== "https://checkout.stripe.com") throw new Error("Invalid checkout session");
    return json(200, { url: session.url });
  } catch {
    return json(503, { error: "Unable to open payment. Retry with the same order." });
  }
}
if (import.meta.main) Deno.serve(handler);
