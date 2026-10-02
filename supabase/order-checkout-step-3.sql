-- Apply before deploying create-checkout and the updated finalize-order.
-- Server-only immutable payment attempt: one Stripe session per saved draft.
create table public.order_checkouts (
  draft_id uuid primary key references public.order_drafts(id),
  address jsonb not null,
  shipping_cents integer not null check (shipping_cents >= 0),
  stripe_params jsonb not null,
  stripe_session_id text unique,
  created_at timestamptz not null default now()
);
alter table public.order_checkouts enable row level security;
revoke all on public.order_checkouts from public, anon, authenticated;
grant all on public.order_checkouts to service_role;
