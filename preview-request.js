import { supabase } from "./supabaseClient.js";
import { configureCreditProfile, refreshCredits, applyCreditBalance, canAffordGeneration, spendGenerationCredits, getDailyCredits, GENERATION_COST } from "./credits.js";

// Store only request metadata, never the photo, so reloads can recover the same attempt.
export async function generatePreview(form) {
  const { data: auth, error: authError } = await supabase.auth.getSession();
  if (authError) throw new Error("Please sign in again.");
  const owner = auth?.session?.user?.id || "guest";
  const image = form.get("image");
  const imageHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await image.arrayBuffer())), b => b.toString(16).padStart(2, "0")).join("");
  const signature = JSON.stringify([imageHash, form.get("productType"), form.get("style"), form.get("note")]);
  const signatureHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature))), b => b.toString(16).padStart(2, "0")).join("");
  const key = `ptl_preview_attempt:${owner}:${signatureHash}`;
  let prior;
  try { prior = JSON.parse(sessionStorage.getItem(key)); } catch {}
  const retry = prior?.signature === signature;
  const requestId = retry ? prior.requestId : crypto.randomUUID();
  await configureCreditProfile(auth?.session?.user);
  if (!retry && !canAffordGeneration()) {
    throw new Error(getDailyCredits().unavailable ? "Unable to load credits. Please try again." : `You need ${GENERATION_COST} credits to generate.`);
  }
  // Do not dispatch if the ID cannot be persisted for safe retry.
  sessionStorage.setItem(key, JSON.stringify({ signature, requestId }));
  form.set("requestId", requestId);
  const { data, error } = await supabase.functions.invoke("preview-portrait", { body: form });
  let response = data;
  if (error?.context?.json) {
    try { response = await error.context.json(); } catch {}
  }
  if (response?.balance) applyCreditBalance(response.balance);
  if (error || response?.error) {
    if (response?.creditStatus === "refunded" || ["insufficient_credits", "request_refunded", "invalid_image", "invalid_note", "invalid_category", "invalid_style", "invalid_request_id", "invalid_session", "configuration_error"].includes(response?.code)) sessionStorage.removeItem(key);
    await refreshCredits();
    throw new Error(response?.error || "Connection interrupted. Retry with the same photo and theme to recover this attempt.");
  }
  if (!response?.previewUrl) throw new Error("No preview received. Retry with the same photo and theme.");
  sessionStorage.removeItem(key);
  if (response.creditMode === "member") {
    if (!response.balance) await refreshCredits();
  } else if (!auth?.session?.user || auth.session.user.is_anonymous) {
    spendGenerationCredits();
  } else {
    // Compatibility with the old function: do not invent member deductions.
    await refreshCredits();
  }
  return response;
}
