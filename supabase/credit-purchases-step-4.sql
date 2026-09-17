-- Run after the existing credit balance and generation SQL.
-- Only the Stripe webhook may call this RPC, after signature verification
-- and checking the paid Checkout Session, line items, currency and amount.
-- Test and live purchases are recorded separately. Keep sandbox tests off
-- the public reload flow; test credits must not be sold as real purchases.
begin;

create table public.credit_purchases (
  stripe_session_id text primary key check (stripe_session_id like 'cs_%'),
  user_id uuid not null references auth.users(id),
  stripe_price_id text not null,
  credits integer not null check (credits in (100, 250, 500)),
  amount_total integer not null check (amount_total > 0),
  currency text not null check (currency = 'usd'),
  livemode boolean not null,
  created_at timestamptz not null default now(),
  check ((credits = 100 and amount_total = 499)
    or (credits = 250 and amount_total = 999)
    or (credits = 500 and amount_total = 1799))
);

alter table public.credit_purchases enable row level security;
revoke all on public.credit_purchases from public, anon, authenticated;
grant select, insert on public.credit_purchases to service_role;

create or replace function public.fulfill_credit_purchase(
  p_user_id uuid, p_session_id text, p_price_id text,
  p_credits integer, p_amount_total integer, p_currency text, p_livemode boolean
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  b public.credit_balances;
  purchase public.credit_purchases;
  inserted_session text;
begin
  if p_user_id is null or not exists (
    select 1 from auth.users where id = p_user_id and is_anonymous = false
  ) then
    raise exception 'A permanent account is required' using errcode = '42501';
  end if;

  insert into public.credit_balances (user_id, free_credit_date)
  values (p_user_id, (now() at time zone 'America/Chicago')::date)
  on conflict (user_id) do nothing;
  -- Same lock order as generation: balance first, then payment record.
  select * into b from public.credit_balances where user_id = p_user_id for update;

  insert into public.credit_purchases
    (stripe_session_id, user_id, stripe_price_id, credits, amount_total, currency, livemode)
  values (p_session_id, p_user_id, p_price_id, p_credits, p_amount_total, p_currency, p_livemode)
  on conflict (stripe_session_id) do nothing
  returning stripe_session_id into inserted_session;

  if inserted_session is null then
    select * into purchase from public.credit_purchases where stripe_session_id = p_session_id;
    if purchase.user_id is distinct from p_user_id
      or purchase.stripe_price_id is distinct from p_price_id
      or purchase.credits is distinct from p_credits
      or purchase.amount_total is distinct from p_amount_total
      or purchase.currency is distinct from p_currency
      or purchase.livemode is distinct from p_livemode then
      raise exception 'Payment details do not match the recorded purchase';
    end if;
    return jsonb_build_object('credited', false, 'balance', to_jsonb(b));
  end if;

  update public.credit_balances
    set purchased_credits = purchased_credits + p_credits, updated_at = now()
    where user_id = p_user_id returning * into b;
  insert into public.credit_transactions
    (user_id, reference, reason, free_credit_change, purchased_credit_change)
  values (p_user_id, 'stripe-checkout:' || p_session_id, 'purchase', 0, p_credits);

  return jsonb_build_object('credited', true, 'balance', to_jsonb(b));
end;
$$;

revoke all on function public.fulfill_credit_purchase(uuid, text, text, integer, integer, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fulfill_credit_purchase(uuid, text, text, integer, integer, text, boolean)
  to service_role;

commit;
