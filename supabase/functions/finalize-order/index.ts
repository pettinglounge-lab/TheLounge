// Server-only payment finalization. Gateway Verify JWT OFF; the exact service
// credential is checked below. Never call this endpoint from the browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handler(req: Request) {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!url || !serviceKey || !stripeKey?.startsWith("sk_live_")) {
    return json(503, { error: "Order finalization is not configured." });
  }
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (token !== serviceKey) return json(401, { error: "Server authentication required." });
  let input;
  try { input = await req.json(); } catch { return json(400, { error: "Invalid JSON." }); }
  const sessionId = input?.sessionId;
  if (typeof sessionId !== "string" || !/^cs_live_[a-zA-Z0-9]+$/.test(sessionId)) {
    return json(400, { error: "A live Checkout Session ID is required." });
  }
  try {
    const stripeGet = async (path: string) => {
      const response = await fetch("https://api.stripe.com/v1/" + path, {
        headers: { Authorization: "Bearer " + stripeKey, "Stripe-Version": "2025-03-31.basil" },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error("stripe_read_failed");
      return await response.json();
    };
    // All payment facts come directly from Stripe, never from the request body.
    const session = await stripeGet("checkout/sessions/" + sessionId);
    if (session.livemode !== true || session.mode !== "payment" ||
      session.metadata?.purpose !== "portrait_order") {
      return json(409, { error: "This session is not a portrait purchase." });
    }
    if (session.status !== "complete" || session.payment_status !== "paid") {
      return json(409, { error: "Payment is not complete." });
    }
    const draftId = session.metadata?.draft_id;
    if (typeof draftId !== "string" || !uuid.test(draftId)) {
      return json(409, { error: "The payment has no valid draft reference." });
    }
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: draft, error } = await admin.from("order_drafts")
      .select("id,user_id,subtotal_cents,currency,quantity,unit_price_cents,artwork_path")
      .eq("id", draftId).single();
    if (error || !draft) throw new Error("draft_lookup_failed");
    const items = await stripeGet("checkout/sessions/" + sessionId + "/line_items?limit=2");
    const item = items.data?.[0];
    const details = session.total_details;
    if (session.client_reference_id !== draft.id || session.metadata?.user_id !== draft.user_id ||
      session.currency !== draft.currency || session.amount_subtotal !== draft.subtotal_cents ||
      !Number.isSafeInteger(session.amount_total) || session.amount_total > 2147483647 ||
      !Number.isSafeInteger(details?.amount_shipping) || details.amount_shipping < 0 ||
      !Number.isSafeInteger(details?.amount_tax) || details.amount_tax < 0 || details.amount_discount !== 0 ||
      session.amount_total !== draft.subtotal_cents + details.amount_shipping + details.amount_tax ||
      items.has_more !== false || items.data?.length !== 1 || item?.quantity !== draft.quantity ||
      item?.currency !== draft.currency || item?.amount_subtotal !== draft.subtotal_cents ||
      item?.price?.unit_amount !== draft.unit_price_cents) {
      return json(409, { error: "Payment does not match the saved order. Review required." });
    }
    const { data: checkout, error: checkoutError } = await admin.from("order_checkouts")
      .select("stripe_session_id,address,shipping_cents").eq("draft_id", draft.id).single();
    if (checkoutError || !checkout) throw new Error("checkout_lookup_failed");
    // A webhook can arrive before the creator saves its response. Retry then.
    if (!checkout.stripe_session_id) throw new Error("checkout_session_pending");
    if (checkout.stripe_session_id !== sessionId || checkout.shipping_cents !== details.amount_shipping) {
      return json(409, { error: "Payment shipping does not match checkout. Review required." });
    }
    const savedAddress = checkout.address;
    const shipping = { name: savedAddress.first_name + " " + savedAddress.last_name };
    const address = { line1: savedAddress.address1, line2: savedAddress.address2,
      city: savedAddress.city, state: savedAddress.region, postal_code: savedAddress.zip, country: savedAddress.country };
    const email = session.customer_details?.email;
    if (!shipping?.name || !address?.line1 || !address?.country || !email) {
      return json(409, { error: "Shipping details or customer email are missing." });
    }
    // Atomic database finalization copies the immutable draft into orders.
    // Artwork stays private in order-artwork; no new render or public URL.
    const result = await admin.rpc("finalize_paid_order", {
      p_draft_id: draft.id, p_user_id: draft.user_id, p_session_id: sessionId,
      p_subtotal: session.amount_subtotal, p_total: session.amount_total,
      p_currency: session.currency, p_email: email,
      p_ship_name: shipping.name, p_ship_address: address,
    });
    if (result.error || !result.data) throw new Error("order_commit_failed");
    return json(200, result.data);
  } catch (error) {
    console.error("Order finalization needs retry", sessionId,
      error instanceof Error ? error.message : "unexpected_error");
    return json(503, { error: "Unable to finalize order. Retry with the same session ID." });
  }
}

if (import.meta.main) Deno.serve(handler);
