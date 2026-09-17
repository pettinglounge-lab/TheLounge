// Deploy with Verify JWT OFF. Stripe authenticates with Stripe-Signature.
// Live payments only. Sandbox events cannot grant credits.
import Stripe from "npm:stripe@18.3.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const PACKAGES = {
  "price_1UGoKfJFj8lbKHzEKSFcFM4c": { credits: 100, amount: 499 },
  "price_1UGoKlJFj8lbKHzEPA81SwV6": { credits: 250, amount: 999 },
  "price_1UGoKoJFj8lbKHzEWPisGvQf": { credits: 500, amount: 1799 },
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export async function handler(req: Request) {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key?.startsWith("sk_live_") || !secret || !url || !serviceKey) {
    return json(503, { error: "Webhook is not configured." });
  }
  const signature = req.headers.get("stripe-signature");
  if (!signature) return json(400, { error: "Missing signature." });
  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient(), timeout: 20000, maxNetworkRetries: 1 });
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(), signature, secret, undefined, Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return json(400, { error: "Invalid signature." });
  }
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
    return json(200, { received: true, ignored: true });
  }
  if (event.livemode !== true) return json(400, { error: "Expected a live event." });
  try {
    const eventSession = event.data.object as Stripe.Checkout.Session;
    // Retrieve current payment details directly from Stripe before granting.
    const session = await stripe.checkout.sessions.retrieve(eventSession.id);
    if (session.metadata?.purpose !== "credit_reload") {
      return json(200, { received: true, ignored: true });
    }
    if (session.payment_status !== "paid") return json(200, { received: true, pending: true });
    const userId = session.client_reference_id;
    if (session.livemode !== true || session.mode !== "payment" || session.status !== "complete" ||
      !userId || session.metadata.user_id !== userId) {
      throw new Error("Invalid purchase owner or mode");
    }
    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 2 });
    const item = items.data[0];
    const priceId = item?.price?.id;
    if (items.has_more || items.data.length !== 1 || item.quantity !== 1 ||
      !priceId || !Object.hasOwn(PACKAGES, priceId)) throw new Error("Invalid purchase items");
    const pack = PACKAGES[priceId as keyof typeof PACKAGES];
    if (session.currency !== "usd" || session.amount_total !== pack.amount ||
      session.amount_subtotal !== pack.amount || item.amount_total !== pack.amount ||
      item.currency !== "usd" || item.price?.unit_amount !== pack.amount ||
      session.metadata.credits !== String(pack.credits)) throw new Error("Invalid purchase amount");

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await admin.rpc("fulfill_credit_purchase", {
      p_user_id: userId, p_session_id: session.id, p_price_id: priceId,
      p_credits: pack.credits, p_amount_total: session.amount_total,
      p_currency: session.currency, p_livemode: session.livemode,
    });
    if (error) throw new Error("Credit fulfillment failed");
    return json(200, { received: true });
  } catch {
    // Non-2xx makes Stripe retry. The SQL session key prevents double credit.
    console.error("Stripe credit fulfillment needs retry", event.id);
    return json(500, { error: "Unable to fulfill payment. Retry delivery." });
  }
}

Deno.serve(handler);
