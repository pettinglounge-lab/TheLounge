// Deploy with Verify JWT OFF; member authentication is checked below.
// Uses existing Printify secrets. Resolves the product shop automatically unless PRINTIFY_SHOP_ID is set.
import { createClient } from "npm:@supabase/supabase-js@2";
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
  let stage = "order_lookup";
  let providerStatus: number | undefined;
  try {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const printifyKey = Deno.env.get("PRINTIFY_API_KEY");
    if (!url || !key || !printifyKey) return json(503, { error: "Shipping quotes are unavailable." });
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return json(401, { error: "Please sign in to calculate shipping." });
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user || auth.user.is_anonymous !== false) return json(401, { error: "Please sign in to calculate shipping." });
    let body;
    try { body = await req.json(); } catch { return json(400, { error: "Invalid shipping request." }); }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body?.orderId || "")) return json(400, { error: "Save your order before calculating shipping." });
    const address: Record<string, string> = {};
    for (const [field, limit] of Object.entries({ first_name: 100, last_name: 100, email: 254, phone: 40, country: 2, address1: 200, address2: 200, city: 100, region: 100, zip: 20 })) {
      const value = body?.address?.[field] ?? "";
      if (typeof value !== "string" || value.trim().length > limit) return json(400, { error: "Check your shipping address." });
      address[field] = value.trim();
    }
    address.country = address.country.toUpperCase();
    if (["first_name", "last_name", "email", "address1", "city"].some(field => !address[field]) || !/^[A-Z]{2}$/.test(address.country) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.email)) return json(400, { error: "Enter a complete shipping address and email." });
    const { data: draft, error } = await admin.from("order_drafts")
      .select("id, product_snapshot, quantity, subtotal_cents, currency")
      .eq("id", body.orderId).eq("user_id", auth.user.id).maybeSingle();
    if (error) throw error;
    if (!draft) return json(404, { error: "Saved order not found." });
    const productId = draft.product_snapshot?.printify_product_id;
    const variantId = Number(draft.product_snapshot?.variant_id);
    if (typeof productId !== "string" || !productId || !Number.isSafeInteger(variantId) || variantId <= 0 || !Number.isInteger(draft.quantity) || draft.quantity < 1 || draft.quantity > 5 || draft.currency !== "usd" || !Number.isSafeInteger(draft.subtotal_cents) || draft.subtotal_cents <= 0) throw new Error("Invalid draft");
    const headers = { Authorization: `Bearer ${printifyKey}`, "Content-Type": "application/json" };
    let shopId = Deno.env.get("PRINTIFY_SHOP_ID");
    stage = "shop_lookup";
    if (!shopId) {
      const shopsResponse = await fetch("https://api.printify.com/v1/shops.json", { headers, signal: AbortSignal.timeout(15000) });
      providerStatus = shopsResponse.status;
      if (!shopsResponse.ok) throw new Error("Shop lookup failed");
      const shops = await shopsResponse.json();
      if (!Array.isArray(shops) || shops.length === 0) return json(503, { error: "No Printify shop is available for shipping." });
      if (shops.length === 1) shopId = String(shops[0].id);
      else {
        // Product IDs are unique across Printify. Check ownership instead of
        // guessing from shop order or sending customer addresses to every shop.
        if (shops.length > 20) return json(503, { error: "Set PRINTIFY_SHOP_ID for this store to enable shipping." });
        stage = "product_shop_lookup";
        const matches = await Promise.allSettled(shops.map(async (shop: { id: unknown }) => {
          const candidate = String(shop.id);
          if (!/^\d+$/.test(candidate)) throw new Error("Invalid shop response");
          const productResponse = await fetch(`https://api.printify.com/v1/shops/${candidate}/products/${encodeURIComponent(productId)}.json`, {
            headers, signal: AbortSignal.timeout(15000),
          });
          if (!productResponse.ok && productResponse.status !== 404) providerStatus = productResponse.status;
          if (productResponse.status === 404) return null;
          if (!productResponse.ok) throw new Error("Product shop lookup failed");
          const product = await productResponse.json();
          if (product?.id !== productId || String(product.shop_id) !== candidate) throw new Error("Product shop mismatch");
          return candidate;
        }));
        const found = matches.flatMap(result => result.status === "fulfilled" && result.value !== null ? [result.value] : []);
        // A different shop may return 400 rather than 404 for this product.
        // A verified globally unique product ID and shop_id establish ownership.
        if (found.length === 0 && matches.some(result => result.status === "rejected")) throw new Error("Product shop lookup failed");
        if (found.length !== 1) return json(409, { error: "Unable to locate this product in a single Printify shop. Please refresh the product catalog." });
        shopId = found[0];
      }
    }
    if (!/^\d+$/.test(shopId)) throw new Error("Invalid shop configuration");
    stage = "shipping_quote";
    providerStatus = undefined;
    const response = await fetch(`https://api.printify.com/v1/shops/${shopId}/orders/shipping.json`, {
      method: "POST", headers, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ line_items: [{ product_id: productId, variant_id: variantId, quantity: draft.quantity }], address_to: address }),
    });
    providerStatus = response.status;
    if (response.status === 400 || response.status === 422) return json(422, { error: "Shipping is unavailable for these details. Check your address, state and postal code." });
    if (!response.ok) throw new Error("Shipping provider unavailable");
    const rates = await response.json();
    const shippingCents = rates?.standard;
    if (!Number.isSafeInteger(shippingCents) || shippingCents < 0) return json(422, { error: "Standard shipping is unavailable for this order and address." });
    const totalBeforeTaxCents = draft.subtotal_cents + shippingCents;
    if (!Number.isSafeInteger(totalBeforeTaxCents)) throw new Error("Invalid total");
    // Advisory only. Payment creation must independently revalidate the quote.
    return json(200, { orderId: draft.id, method: "standard", shippingCents, subtotalCents: draft.subtotal_cents, totalBeforeTaxCents, currency: draft.currency });
  } catch {
    // Only fixed stage labels and HTTP status: never credentials or addresses.
    console.error("Shipping quote failed", JSON.stringify({ stage, providerStatus }));
    const message = stage === "product_shop_lookup" || stage === "shop_lookup"
      ? "Unable to locate the product’s Printify shop. Please retry."
      : stage === "shipping_quote"
      ? "Printify could not return a shipping rate. Please retry."
      : "Unable to load your order for shipping. Please retry.";
    return json(503, { error: message, code: stage + "_failed" });
  }
}
if (import.meta.main) Deno.serve(handler);
