import { supabase } from './supabaseClient.js';

export async function saveOrderDraft(order, preview) {
  const { data, error } = await supabase.auth.getSession();
  const user = data?.session?.user;
  if (error || !user || user.is_anonymous !== false) throw new Error('Please sign in before saving your order.');
  const response = await fetch(preview);
  if (!response.ok) throw new Error('Unable to read the approved artwork. Please try again.');
  const artwork = await response.blob();
  if (!artwork.size || artwork.size > 20 * 1024 * 1024) throw new Error('Artwork must be smaller than 20 MB.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await artwork.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('');
  const signature = JSON.stringify([user.id, order.category, order.printify_product_id, String(order.variantId), order.quantity, hash]);
  const key = 'ptl_order_draft_attempt';
  let prior;
  try { prior = JSON.parse(sessionStorage.getItem(key)); } catch {}
  const requestId = prior?.signature === signature ? prior.requestId : crypto.randomUUID();
  sessionStorage.setItem(key, JSON.stringify({ signature, requestId }));
  const form = new FormData();
  form.set('requestId', requestId);
  form.set('category', order.category);
  form.set('productId', order.printify_product_id);
  form.set('variantId', String(order.variantId));
  form.set('quantity', String(order.quantity));
  form.set('artwork', artwork, 'approved-artwork');
  const result = await supabase.functions.invoke('save-order-draft', { body: form });
  let body = result.data;
  if (result.error?.context?.json) {
    try { body = await result.error.context.json(); } catch {}
  }
  if (result.error || body?.error || !body?.orderId) throw new Error(body?.error || 'Unable to save your order. Please retry.');
  sessionStorage.setItem('ptl_saved_order', JSON.stringify(body));
  return body;
}
