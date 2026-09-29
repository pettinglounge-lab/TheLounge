# Review — September 29, 2026

Live inspection confirmed the finalize-order migration and updated finalizer and
Stripe webhook are deployed. `finalize-order` still has gateway Verify JWT ON;
the documented configuration is OFF with exact server credential verification
inside the handler. The gateway can accept legacy service JWTs, but is an extra
compatibility dependency. Set it OFF to match the handler's documented contract.

## Deployment work still required

- Deploy save-order-draft before publishing the frontend Save order changes.
  Its table and private order-artwork bucket already exist; do not rerun step 1.
- Deploy the reviewed sync-products implementation. The existing deployed
  endpoint has no authentication. The replacement requires a POST with the
  service-role bearer credential and reads all catalog pages before deletion.
  Call it only from a trusted server/admin environment, never the website.
- Deploy the reviewed preview-portrait and save-order-draft sources for their
  TypeScript fixes. The preview rendering/prompt changes were already present
  in the pending local work and are included in this commit.

## Known limitations

This is an intermediate draft/payment-finalization implementation. The frontend
explicitly saves drafts without taking payment. Product Stripe checkout,
Printify submission, production-resolution validation, and shipment tracking are
not implemented. Credit checkout remains separate and unchanged.

Guest generation quotas are enforced only in browser storage. Server-side guest
abuse prevention remains needed. Large preview data URLs use sessionStorage and
can exceed browser quotas. Generated images are 1024x1536 (51.2 PPI at 20x30).
Neither a prompt's print-ready wording nor saving an order increases resolution.

Live security advisories also flag touch_updated_at's mutable search_path and
disabled leaked-password protection. Credit tables with no client policies are
intentional; ownership-filtered credit RPCs are intentionally member-callable.
The advisory findings are not evidence of a completed security audit.

## Verification

Deno type-check all local Edge Functions and run mocked finalization and sync
authentication tests. Parse frontend JavaScript and inline HTML scripts and run
git diff --check. These do not test real charges, live database concurrency,
browser rendering, or Printify orders. No production writes were made by this
review. Deployment and a complete product checkout smoke test remain necessary.
