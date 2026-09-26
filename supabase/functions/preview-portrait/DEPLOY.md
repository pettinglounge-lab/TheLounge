# OpenAI rendering update

Deploy the complete index.ts in this folder to preview-portrait. Set OPENAI_API_KEY
in Supabase Edge Function secrets. Keep gateway Verify JWT OFF; the handler
continues to verify member tokens itself.

Uses POST https://api.openai.com/v1/images/edits with gpt-image-2.5-sunburst,
quality=max, size=2336x3504, and lossless PNG output. This is the largest exact
2:3 resolution satisfying the documented 8,294,400-pixel cap and 16px increments.
These larger custom sizes are experimental. Confirm model access for your project.
At 20x30 inches this is 116.8 PPI; 300-PPI production requires 6000x9000 pixels
and a separate upscaling step. No upscaling is performed here.

Preserves the pasted Floral prompt, optional pet-name rendering, and the catalog
Custom style. Credit reservations, replay, storage, and refunds retain their
existing behavior. Requests time out at 120 seconds; uncertain timeouts retain
reservations for review. Test max-quality latency against your deployed function
limits before rollout. Large PNG data URLs also need an end-to-end checkout test
because the website uses sessionStorage for preview handoff.

Local validation did not make a paid image request or deploy the function.
Run Deno type checking and a signed-in generation/checkout smoke test, plus a
guest generation test, before publishing. Check rejected-request refunds and
same-request replay. The original rollout notes below are historical.

---

# Preview portrait: member credits

Replace the deployed preview-portrait source with the complete index.ts in this folder.
Keep gateway Verify JWT OFF: guests are intentionally supported and the handler verifies member tokens itself.
The function uses OPENAI_API_KEY and the standard Supabase server environment variables
SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY. Never put the service key in browser code.

Prerequisites: credit tables plus SQL steps 2 and 3 already deployed.
Uses the existing portrait-renders bucket (currently public) for durable member results,
at user-id/previews/request-id.image. These previews are not portraits table records and
are not removed by the Custom project deletion flow. A retention policy is still needed.

Frontend integration is implemented locally in credits.js and preview-request.js
and wired into Pet, Home, Memories, Account, and the Custom balance display.
The website changes must be deployed separately. The implementation follows:
- Read member balances from get_member_credit_balance; do not deduct member credits in localStorage.
- Guests retain existing browser accounting. Guest limits are not server-enforced;
  callers can omit authentication and use the guest route.
- Send a UUID requestId per logical attempt. Reuse it on network retries; use a new one
  for intentional regeneration. The compatibility fallback generates an ID for old clients,
  but cannot deduplicate their retries if the response is lost.
- Parse JSON error bodies from non-2xx responses and update balances from the response.
- A request_pending / completion_pending response must not trigger a new generation automatically.

Confirmed provider failures/no-image responses refund member reservations. Network/response
interruptions or save/completion errors retain reservations for review. Retry with the same ID
recovers a saved result. If no result was saved, a backend operator must investigate before refunding;
no automatic timeout refund or reconciliation job is included.

Custom still calls the undeployed render-portrait function and is a separate integration task.
This replacement does not add purchased credits or Stripe handling.

Validation: isolated mocked handler checks covered guest/member success, insufficient credits,
invalid session, provider rejection/refund, uncertain network failure, and completed-request replay.
No live generation, deployment, or customer balance mutation was performed. Deno is unavailable
locally, so run Deno type checking and a staging smoke test before production rollout.
