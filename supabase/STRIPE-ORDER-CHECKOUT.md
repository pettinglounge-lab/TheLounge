# Portrait payment deployment

This change adds Stripe payment after a Printify shipping quote. It records a paid
order through the existing Stripe webhook. It does not submit orders to Printify
production.

1. Run `order-checkout-step-3.sql` in the Supabase SQL Editor. The existing draft
   and finalization migrations must already be installed.
2. Deploy `create-checkout` and the updated `finalize-order`, with gateway Verify
   JWT off. Both authenticate internally. `create-checkout` imports
   `../quote-order-shipping/index.ts`; deploy with the Supabase CLI so that this
   dependency is bundled, or include that relative file in the dashboard editor.
3. Keep the existing `stripe-webhook` deployed and configured for live
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
   It already routes portrait_order sessions to finalize-order.
4. Verify Stripe Tax settings are complete before enabling this frontend.
   Automatic tax is enabled; shipping uses the saved customer shipping address.
   https://docs.stripe.com/tax/checkout
5. Publish checkout.html and order-draft.js after the server deployments.

Existing secrets are reused: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
STRIPE_SECRET_KEY (live), PRINTIFY_API_KEY and PRINTIFY_SHOP_ID when needed.
Return URLs use https://pettinglounge.com.

The server refreshes shipping before creating payment, stores immutable checkout
parameters, and uses one idempotency key per draft. Repeat requests reuse the
Stripe session. Expired sessions allow a new saved draft. An uncertain creation
that remains unresolved for 30 minutes needs manual reconciliation rather than
risking a second charge. Changing shipping after opening payment requires a new
saved draft; any previous open payment page should be closed.

The return page checks the authenticated user's orders; a success URL alone does
not prove payment. Finalization verifies the session, line item, owner, currency,
subtotal and stored shipping charge. Artwork remains private.

Local mocked tests cover ownership, shipping changes, provider rates, session
reuse, completed/expired sessions and finalization. Live Stripe payment,
Stripe Tax configuration, deployment and Printify fulfillment are not verified
by these local tests. Supabase remote inspection failed due to OAuth refresh;
the deployed create-checkout contents could not be compared in this session.
