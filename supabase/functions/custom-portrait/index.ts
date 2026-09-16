// Signed-in Custom generation. Deploy with Verify JWT OFF; verified below.
// Uses the deployed preview-portrait function for themes, image generation,
// credit reservations, refunds, and durable retry results.
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

export async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  let requestId: string | undefined;
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !serviceKey || !anonKey) return json(503, { error: "Generation is unavailable." });
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return json(401, { error: "Sign in to generate a custom project.", code: "invalid_session" });
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user || auth.user.is_anonymous !== false) {
      return json(401, { error: "Sign in to generate a custom project.", code: "invalid_session" });
    }
    let input;
    try { input = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
    const portraitId = input?.portraitId;
    requestId = input?.requestId;
    if (typeof portraitId !== "string" || !uuid.test(portraitId) || typeof requestId !== "string" || !uuid.test(requestId)) {
      return json(400, { error: "Valid project and request IDs are required.", code: "invalid_request_id" });
    }
    requestId = requestId.toLowerCase();
    const { data: project, error } = await admin.from("portraits")
      .select("id, photo_path, config, updated_at")
      .eq("id", portraitId).eq("user_id", auth.user.id).maybeSingle();
    if (error) return json(503, { error: "Unable to load your project." });
    if (!project) return json(404, { error: "Project not found." });
    // Never let a user-controlled project record read another customer's upload.
    if (!project.photo_path?.startsWith(auth.user.id + "/") || project.photo_path.split("/").includes("..")) {
      return json(400, { error: "Invalid reference photo." });
    }
    const config = project.config || {};
    const category = config.category;
    const prompt = config.prompt ?? config.note ?? "";
    if (!["pet", "home", "memory"].includes(category) || typeof prompt !== "string" || prompt.length > 5000) {
      return json(400, { error: "Check the project's category and description.", code: "invalid_note" });
    }
    const photo = await admin.storage.from("pet-photos").download(project.photo_path);
    if (photo.error || !photo.data) return json(503, { error: "Unable to load your reference photo." });
    const form = new FormData();
    form.set("image", photo.data, "reference");
    form.set("productType", category);
    form.set("style", typeof config.style === "string" ? config.style : "");
    form.set("note", prompt); // Customer's complete saved text accompanies their photo.
    form.set("requestId", requestId);
    // Forward the verified CUSTOMER token, not the service role key.
    const result = await fetch(url + "/functions/v1/preview-portrait", {
      method: "POST", headers: { Authorization: "Bearer " + token, apikey: anonKey },
      body: form, signal: AbortSignal.timeout(140000),
    });
    const generated = await result.json();
    if (!result.ok || generated.error) return json(result.ok ? 502 : result.status, generated);
    if (generated.creditMode !== "member" || !generated.previewUrl) {
      return json(502, { error: "Unexpected generation response. Retry this request.", requestId });
    }
    const renderPath = auth.user.id + "/previews/" + requestId + ".image";
    // Do not overwrite edits made in a different tab while generation was running.
    const saved = await admin.from("portraits")
      .update({ render_path: renderPath, status: "rendered", updated_at: new Date().toISOString() })
      .eq("id", portraitId).eq("user_id", auth.user.id)
      .eq("config", JSON.stringify(project.config)).eq("photo_path", project.photo_path)
      .select("id");
    if (saved.error || saved.data?.length !== 1) {
      return json(409, { error: "Artwork is saved, but the project could not be updated. Your project may have changed. Retry the same attempt.", code: "project_save_pending", requestId, balance: generated.balance });
    }
    return json(200, { portraitId, requestId, renderPath, balance: generated.balance, creditMode: "member" });
  } catch {
    return json(503, { error: "Generation was interrupted. Retry the same attempt to avoid a duplicate charge.", code: "generation_interrupted", requestId });
  }
}

Deno.serve(handler);
