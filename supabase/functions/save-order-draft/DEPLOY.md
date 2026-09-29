# Order drafts: first fulfillment step

1. Run supabase/order-drafts-step-1.sql once in the Supabase SQL Editor.
2. Deploy this folder's complete index.ts as save-order-draft. Turn gateway
   Verify JWT off; the handler verifies the bearer token and requires a real
   signed-in member. Standard SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY secrets
   are required. Never put the service key in the website.
3. Publish checkout.html and order-draft.js together.

The Save order button stores an unpaid draft and a private immutable copy of the
approved artwork. Price, variant label (including size/color), and Printify IDs
come from the server-side products catalog. The subtotal excludes shipping and
tax. Changing options or artwork creates a new draft; retrying the same attempt
returns its original snapshot and price. Guests must sign in first.

No Stripe product payment or Printify submission is implemented in this step.
The artwork is customer-supplied image data, not proof of paid generation. Drafts
must never be treated as paid orders. Production resolution checks, shipping,
payment confirmation, and fulfillment are later steps. Interrupted uploads may
leave private unreferenced files; establish a retention policy before scaling.

Deployment checks: run Deno type checking, then save an order while signed in.
Verify the private artwork and server-selected price. Retry the same save and
confirm the same ID. Change quantity and confirm a new ID. Reject invalid
variants, unavailable products, unauthenticated users, and forged prices.
Verify customers cannot read another customer's drafts or write draft rows.
No paid API calls or live database writes were made during local preparation.
