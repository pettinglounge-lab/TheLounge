import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type Product = { id: string; shop_id: number; blueprint_id: number; print_provider_id: number;
  variants: { id: number; is_enabled: boolean; is_available: boolean }[];
  print_areas: { variant_ids: number[]; placeholders: { position: string; images: unknown[] }[] }[];
  print_details?: Record<string, unknown> };
const base = "https://api.printify.com/v1/";

// A dispatched request is never automatically sent twice. Lost responses are
// reconciled by our stable external ID; unresolved outcomes require review.
export async function fulfillOrder(admin: SupabaseClient, orderId: string) {
  const key = Deno.env.get("PRINTIFY_API_KEY");
  if (!key) throw new Error("printify_not_configured");
  const token = crypto.randomUUID();
  const claim = await admin.rpc("claim_order_fulfillment", { p_order_id: orderId, p_token: token });
  if (claim.error || !claim.data) throw new Error("fulfillment_claim_failed");
  if (claim.data.action === "submitted") return claim.data.printify_order_id;
  if (claim.data.action === "busy") throw new Error("fulfillment_in_progress");
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "User-Agent": "PettingLounge/1.0" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error("printify_http_" + response.status);
    return response.json();
  };
  let dispatched = claim.data.action === "reconcile";
  try {
    const { data: order, error } = await admin.from("orders").select("id,user_id,draft_id,product_snapshot,quantity,artwork_path")
      .eq("id", orderId).single();
    if (error || !order) throw new Error("fulfillment_order_missing");
    const snapshot = order.product_snapshot;
    const variantId = Number(snapshot?.variant_id);
    if (!snapshot?.printify_product_id || !Number.isSafeInteger(variantId) || variantId<=0 ||
      !Number.isInteger(order.quantity) || order.quantity<1 || order.quantity>5) throw new Error("invalid_fulfillment_snapshot");
    const finish = async (shop: string, id: string) => {
      const done = await admin.rpc("complete_order_fulfillment", { p_order_id: orderId, p_shop_id: shop, p_printify_id: id });
      if (done.error) throw new Error("fulfillment_save_pending");
      return id;
    };
    if (dispatched) {
      const shop = claim.data.shop_id;
      if (!/^\d+$/.test(shop)) throw new Error("fulfillment_shop_missing");
      // Bound reconciliation work; never infer a failed creation from absence.
      for (let page=1;page<=10;page++) {
        const list = await request(`shops/${shop}/orders.json?limit=10&page=${page}`);
        if (!Array.isArray(list.data)) throw new Error("invalid_printify_orders");
        const matches = list.data.filter((o: { external_id?: string; metadata?: { shop_order_label?: string } }) =>
          o.external_id === orderId || o.metadata?.shop_order_label === orderId);
        if (matches.length>1) throw new Error("duplicate_printify_orders_review");
        if (matches.length===1) {
          const found = matches[0];
          const item = found.line_items?.[0];
          if (!found.id || found.line_items.length!==1 || item.variant_id!==variantId || item.quantity!==order.quantity ||
            item.print_provider_id!==Number(snapshot.print_provider_id)) throw new Error("printify_order_mismatch");
          return await finish(shop, found.id);
        }
        if (!list.next_page_url) break;
      }
      throw new Error("fulfillment_outcome_needs_review");
    }
    const configuredShop = Deno.env.get("PRINTIFY_SHOP_ID");
    const shops = configuredShop ? [{ id: configuredShop }] : await request("shops.json");
    if (!Array.isArray(shops) || !shops.length || shops.length>20) throw new Error("invalid_printify_shops");
    const candidates = await Promise.allSettled(shops.map(async (s: { id: unknown }) => {
      const shop = String(s.id);
      if (!/^\d+$/.test(shop)) throw new Error("invalid_shop_id");
      const product: Product = await request(`shops/${shop}/products/${encodeURIComponent(snapshot.printify_product_id)}.json`);
      if (product.id!==snapshot.printify_product_id || String(product.shop_id)!==shop) throw new Error("product_shop_mismatch");
      return { shop, product };
    }));
    const matches = candidates.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
    if (matches.length!==1) throw new Error("product_shop_lookup_failed");
    const { shop, product } = matches[0];
    if (product.blueprint_id!==Number(snapshot.blueprint_id) || product.print_provider_id!==Number(snapshot.print_provider_id)) {
      throw new Error("product_changed_since_purchase");
    }
    const variant = product.variants.find(v=>v.id===variantId);
    if (!variant?.is_enabled || !variant.is_available) throw new Error("purchased_variant_unavailable");
    const area = product.print_areas.find(a=>a.variant_ids.includes(variantId));
    if (!area) throw new Error("print_area_missing");
    // One uploaded artwork cannot safely replace a multi-surface template.
    const decorated = area.placeholders.filter(p=>p.images?.length);
    const positions = decorated.length ? decorated : area.placeholders.filter(p=>p.position==="front");
    if (positions.length!==1) throw new Error("multiple_print_areas_need_review");
    const position = positions[0].position;
    const catalog = await request(`catalog/blueprints/${product.blueprint_id}/print_providers/${product.print_provider_id}/variants.json`);
    const placeholder = catalog.variants?.find((v: { id: number })=>v.id===variantId)?.placeholders?.find((p: { position: string })=>p.position===position);
    if (!(placeholder?.width>0 && placeholder?.height>0)) throw new Error("print_dimensions_missing");
    if (typeof order.artwork_path!=="string" || !order.artwork_path.startsWith(order.user_id+"/") || order.artwork_path.split("/").includes("..")) {
      throw new Error("invalid_order_artwork");
    }
    const signed = await admin.storage.from("order-artwork").createSignedUrl(order.artwork_path, 7*24*60*60);
    if (signed.error || !signed.data?.signedUrl) throw new Error("artwork_url_failed");
    // Upload the original file unchanged, preserving PNG alpha. Metadata gives
    // real dimensions so the artwork fits inside the selected print surface.
    const image = await request("uploads/images.json", { file_name: orderId+".png", url: signed.data.signedUrl });
    if (!(image.width>0 && image.height>0)) throw new Error("artwork_upload_failed");
    const scale = Math.min(1, placeholder.height*image.width/(placeholder.width*image.height));
    const checkout = await admin.from("order_checkouts").select("address").eq("draft_id",order.draft_id).single();
    if (checkout.error || !checkout.data?.address) throw new Error("fulfillment_address_missing");
    const body = {
      external_id: orderId, label: orderId,
      line_items: [{ blueprint_id: product.blueprint_id, print_provider_id: product.print_provider_id,
        variant_id: variantId, quantity: order.quantity, external_id: orderId+"-1",
        print_areas: { [position]: [{ src: signed.data.signedUrl, x:0.5, y:0.5, scale, angle:0 }] },
        ...(product.print_details ? { print_details: product.print_details } : {}),
      }], shipping_method:1, send_shipping_notification:false, address_to:checkout.data.address,
    };
    // Persist the dispatch boundary before the network call. Only the lease
    // holder may cross it; a timeout or process crash cannot cause a repost.
    const marked = await admin.from("order_fulfillments").update({ state:"dispatched",shop_id:shop,updated_at:new Date().toISOString() })
      .eq("order_id",orderId).eq("state","preparing").eq("claim_token",token)
      .gt("lease_until",new Date().toISOString()).select("order_id");
    if (marked.error || marked.data?.length!==1) throw new Error("fulfillment_claim_lost");
    dispatched = true;
    const created = await request(`shops/${shop}/orders.json`, body);
    if (typeof created?.id!=="string" || !created.id) throw new Error("printify_order_response_invalid");
    return await finish(shop,created.id);
  } catch (error) {
    const code = error instanceof Error ? error.message : "fulfillment_failed";
    // Do not log provider bodies, signed artwork URLs, or customer addresses.
    await admin.from("order_fulfillments").update({ last_error:code,updated_at:new Date().toISOString(),
      ...(!dispatched ? { lease_until:new Date(0).toISOString() } : {}) })
      .eq("order_id",orderId).eq("claim_token",token);
    throw new Error(code);
  }
}
