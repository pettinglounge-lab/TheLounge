# Deploy custom-portrait

In Supabase Edge Functions, create a function named `custom-portrait` and replace
its source with this folder's complete `index.ts`. Keep gateway Verify JWT off;
the function verifies customer tokens through Supabase Auth and rejects guests.

Requires the credit-aware `preview-portrait` already deployed and the standard
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY environment variables.
It forwards the customer's token to preview-portrait, which uses GEMINI_API_KEY.
Never expose service-role credentials to the browser.

Input: JSON `{ "portraitId": "uuid", "requestId": "uuid" }`.
The backend reads the owned project's original image and full saved prompt;
it does not trust photo paths or user IDs supplied in the request.
The selected category/style and customer prompt are passed to preview-portrait.
The optional inside-card message stays in project config, not in the cover artwork.

Success attaches the generated storage path to the project and marks it rendered.
The shared preview function charges 10 credits and handles retry/refund behavior.
Retry the same ID after uncertain failure. A successful new regeneration uses a new ID.
Deploy the local Custom page changes separately after deploying this function.

The existing preview function accepts JPEG, PNG, and WebP up to 15 MB.
No live generation or balance changes were performed during local checks.
Run Deno type checking and a signed-in end-to-end test before production use.
