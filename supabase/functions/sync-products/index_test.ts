import { handler } from "./index.ts";

Deno.test("product sync rejects callers before reaching Printify or the database", async () => {
  const previous = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "server-only-fixture");
  try {
    // No network permission: any unexpected provider call fails the test.
    for (const token of ["", "customer-token", "public-anon-key"]) {
      const response = await handler(new Request("https://local.test", {
        method: "POST", headers: { Authorization: "Bearer " + token },
      }));
      if (response.status !== 401) throw new Error("Untrusted sync request was not rejected");
    }
    const response = await handler(new Request("https://local.test"));
    if (response.status !== 405) throw new Error("GET must not mutate catalog");
  } finally {
    if (previous === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", previous);
  }
});
