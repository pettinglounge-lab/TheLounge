import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");

export async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  try {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json(503, { error: "Order saving is unavailable." });
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return json(401, { error: "Please sign in to save your order." });
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user || auth.user.is_anonymous !== false) return json(401, { error: "Please sign in to save your order." });
    const form = await req.formData();
    const id = String(form.get("requestId") || "").toLowerCase();
    const category = String(form.get("category") || "");
    const productId = String(form.get("productId") || "");
    const variantId = String(form.get("variantId") || "");
    const quantity = Number(form.get("quantity"));
    const artwork = form.get("artwork");
    if (!uuid.test(id) || !["pet", "home", "memory"].includes(category) || !productId || productId.length > 100 || !variantId || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) return json(400, { error: "Check your product and quantity." });
    if (!(artwork instanceof Blob) || !artwork.size || artwork.size > 20 * 1024 * 1024) return json(400, { error: "Artwork must be smaller than 20 MB." });
    const bytes = await artwork.arrayBuffer();
    const b = new Uint8Array(bytes);
    const mime = b.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => b[i] === n) ? "image/png"
      : b[0] === 255 && b[1] === 216 && b[2] === 255 ? "image/jpeg"
      : b.length >= 12 && String.fromCharCode(...b.slice(0,4)) === "RIFF" && String.fromCharCode(...b.slice(8,12)) === "WEBP" ? "image/webp" : null;
    if (!mime) return json(400, { error: "Artwork must be PNG, JPEG, or WebP." });
    const imageHash = await digest(bytes);
    const hash = await digest(new TextEncoder().encode(JSON.stringify([category, productId, variantId, quantity, imageHash])).buffer as ArrayBuffer);
    const { data: prior, error: priorError } = await admin.from("order_drafts").select("id, request_hash, subtotal_cents, currency").eq("id", id).eq("user_id", auth.user.id).maybeSingle();
    if (priorError) throw priorError;
    if (prior) return prior.request_hash === hash
      ? json(200, { orderId: prior.id, subtotalCents: prior.subtotal_cents, currency: prior.currency, replayed: true })
      : json(409, { error: "Order options changed. Please start a new save attempt." });
    let { data: product, error } = await admin.from("products").select("*").eq("category", category).eq("printify_product_id", productId).maybeSingle();
    if (error) throw error;
    if (!product && category !== "pet") {
      const fallback = await admin.from("products").select("*").eq("category", "pet").eq("printify_product_id", productId).maybeSingle();
      if (fallback.error) throw fallback.error;
      product = fallback.data;
    }
    if (!product?.available || !Array.isArray(product.variants)) return json(409, { error: "This product is unavailable." });
    const variant = product.variants.find((v: { id: unknown }) => String(v.id) === variantId);
    const price = variant?.price;
    const cents = Math.round(Number(price) * 100);
    if (!variant || price === null || price === "" || !Number.isSafeInteger(cents) || cents <= 0 || cents > 10000000) return json(409, { error: "This product option is unavailable." });
    const path = `${auth.user.id}/${id}/${imageHash}`;
    const upload = await admin.storage.from("order-artwork").upload(path, bytes, { contentType: mime, upsert: false });
    if (upload.error) {
      // A retry may encounter its already-uploaded immutable artwork.
      const existing = await admin.storage.from("order-artwork").download(path);
      if (existing.error || !existing.data || await digest(await existing.data.arrayBuffer()) !== imageHash) throw upload.error;
    }
    const snapshot = {
      title: product.title, category: product.category, product_type: product.product_type,
      printify_product_id: product.printify_product_id, blueprint_id: product.blueprint_id,
      print_provider_id: product.print_provider_id, variant_id: variant.id,
      variant_label: String(variant.size || "Standard"),
    };
    const inserted = await admin.from("order_drafts").insert({ id, user_id: auth.user.id, request_hash: hash, category,
      product_snapshot: snapshot, quantity, unit_price_cents: cents, artwork_path: path,
    }).select("id, subtotal_cents, currency").single();
    if (inserted.error) {
      const raced = await admin.from("order_drafts").select("id, request_hash, subtotal_cents, currency").eq("id", id).eq("user_id", auth.user.id).maybeSingle();
      if (!raced.error && raced.data?.request_hash === hash) return json(200, { orderId: raced.data.id, subtotalCents: raced.data.subtotal_cents, currency: raced.data.currency, replayed: true });
      throw inserted.error;
    }
    return json(201, { orderId: inserted.data.id, subtotalCents: inserted.data.subtotal_cents, currency: inserted.data.currency });
  } catch {
    return json(503, { error: "Unable to save your order. Please retry." });
  }
}
Deno.serve(handler);
