# Finalize verified portrait payments

Prepared against the live orders schema inspected on September 29, 2026.
This replaces the deployed finalize-order implementation. It records a paid
order; it does not yet submit to Printify or charge a payment method.

## Deploy in order

1. Apply `supabase/finalize-order-step-2.sql` once. This adds draft/payment
   references, snapshots, and uniqueness constraints to orders, allows a null
   portrait_id for draft orders, and installs a service-role-only atomic RPC.
2. Deploy finalize-order with gateway Verify JWT OFF. The handler requires the
   exact SUPABASE_SERVICE_ROLE_KEY bearer credential. Never expose it in HTML.
   It also requires SUPABASE_URL and the existing live STRIPE_SECRET_KEY.
3. Deploy the updated stripe-webhook with Verify JWT OFF as before. Its existing
   signature verification and credit-purchase route remain in place.

Keep save-order-draft: it saves immutable approved artwork in private storage,
and a server-priced product snapshot before payment. The draft remains an unpaid
input record; the orders table is authoritative for payment/fulfillment status.
The uniqueness constraint permits only one paid order per draft. A second paid
session for that draft requires operator review, never a second fulfillment.

## Required product checkout contract (not implemented yet)

The server creating the Stripe Session must authenticate draft ownership, use
the saved price/quantity/currency, collect shipping details and email, and set:

```
mode: payment
client_reference_id: <draft UUID>
metadata[purpose]: portrait_order
metadata[draft_id]: <draft UUID>
metadata[user_id]: <draft owner UUID>
```

Use one line item, no discounts, and USD. Tax and shipping may be added by
Stripe; finalization checks the subtotal and reconciles those additions.
Prevent concurrent/repeated checkout creation for one draft and expire stale
sessions before issuing replacements. Credit checkout is not product checkout.
Stripe's verified paid webhook calls finalize-order with only `{sessionId}`.
No browser-supplied image URL, amount, shipping address, or paid status is used.

## Validation

Run `deno check supabase/functions/finalize-order/index.ts` and
`deno test --allow-env supabase/functions/finalize-order/index_test.ts`.
On an isolated database verify concurrent RPC calls for the same session yield
one order; a second session for that draft and browser RPC calls must fail.
End-to-end payment and SQL concurrency validation are required before enabling
product checkout. No live payments or production database writes were tested.

Printify submission, print-resolution validation, and tracking updates remain
separate work. A `paid` order is not a `submitted` Printify order.
