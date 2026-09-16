-- Run after credit-balance-step-2.sql in Supabase SQL Editor.
-- Backend contract:
-- 1. Verify the customer's JWT and permanent-account status in the Edge Function.
-- 2. Reserve using that verified user ID and one UUID per generation attempt.
-- 3. Call the image provider ONLY when should_generate is true.
-- 4. On success, durably save the result, then complete the reservation.
-- 5. On confirmed failure, refund. Do not refund an uncertain provider outcome.
-- Repeated reserve calls never authorize another provider call.
-- These functions require a backend service-role client, never browser access.
begin;

create table public.credit_reservations (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  credit_date date not null,
  free_credits integer not null check (free_credits between 0 and 10),
  purchased_credits integer not null check (purchased_credits between 0 and 10),
  status text not null default 'reserved'
    check (status in ('reserved', 'completed', 'refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, request_id),
  check (free_credits + purchased_credits = 10)
);

alter table public.credit_reservations enable row level security;
revoke all on public.credit_reservations from public, anon, authenticated;
grant all on public.credit_reservations to service_role;

-- Every mutation locks the member's balance first, then the reservation.
-- This serializes concurrent requests, including refunds and daily resets.
create or replace function public.reserve_generation_credits(
  p_user_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  b public.credit_balances;
  r public.credit_reservations;
  today date := (now() at time zone 'America/Chicago')::date;
  free_cost integer;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'User ID and request ID are required';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id and is_anonymous = false) then
    raise exception 'A permanent account is required' using errcode = '42501';
  end if;

  insert into public.credit_balances (user_id, free_credit_date)
  values (p_user_id, today) on conflict (user_id) do nothing;
  select * into b from public.credit_balances where user_id = p_user_id for update;

  if b.free_credit_date < today then
    insert into public.credit_transactions
      (user_id, reference, reason, free_credit_change)
    values (p_user_id, 'daily-reset:' || p_user_id::text || ':' || today::text,
      'daily_reset', 50 - b.free_credits);
    update public.credit_balances
      set free_credits = 50, free_credit_date = today, updated_at = now()
      where user_id = p_user_id returning * into b;
  end if;

  select * into r from public.credit_reservations
    where user_id = p_user_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('should_generate', false, 'status', r.status,
      'request_id', p_request_id, 'balance', to_jsonb(b));
  end if;
  if b.free_credits::bigint + b.purchased_credits::bigint < 10 then
    return jsonb_build_object('should_generate', false, 'status', 'insufficient_credits',
      'request_id', p_request_id, 'balance', to_jsonb(b));
  end if;

  free_cost := least(10, b.free_credits);
  insert into public.credit_reservations
    (user_id, request_id, credit_date, free_credits, purchased_credits)
  values (p_user_id, p_request_id, b.free_credit_date, free_cost, 10 - free_cost);

  update public.credit_balances
    set free_credits = free_credits - free_cost,
        purchased_credits = purchased_credits - (10 - free_cost), updated_at = now()
    where user_id = p_user_id returning * into b;
  insert into public.credit_transactions
    (user_id, reference, reason, free_credit_change, purchased_credit_change)
  values (p_user_id, 'generation:' || p_user_id::text || ':' || p_request_id::text,
    'generation', -free_cost, -(10 - free_cost));

  return jsonb_build_object('should_generate', true, 'status', 'reserved',
    'request_id', p_request_id, 'balance', to_jsonb(b));
end;
$$;

create or replace function public.complete_generation_credits(
  p_user_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.credit_reservations;
begin
  perform 1 from public.credit_balances where user_id = p_user_id for update;
  select * into r from public.credit_reservations
    where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if r.status = 'refunded' then raise exception 'Reservation was already refunded'; end if;
  if r.status = 'reserved' then
    update public.credit_reservations set status = 'completed', updated_at = now()
      where user_id = p_user_id and request_id = p_request_id;
  end if;
  return jsonb_build_object('status', 'completed', 'request_id', p_request_id);
end;
$$;

create or replace function public.refund_generation_credits(
  p_user_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  b public.credit_balances;
  r public.credit_reservations;
  today date := (now() at time zone 'America/Chicago')::date;
  free_refund integer;
begin
  select * into b from public.credit_balances where user_id = p_user_id for update;
  if not found then raise exception 'Credit balance not found'; end if;
  select * into r from public.credit_reservations
    where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if r.status = 'completed' then raise exception 'Completed generations cannot be refunded by this function'; end if;

  if b.free_credit_date < today then
    insert into public.credit_transactions
      (user_id, reference, reason, free_credit_change)
    values (p_user_id, 'daily-reset:' || p_user_id::text || ':' || today::text,
      'daily_reset', 50 - b.free_credits);
    update public.credit_balances
      set free_credits = 50, free_credit_date = today, updated_at = now()
      where user_id = p_user_id returning * into b;
  end if;
  if r.status = 'refunded' then
    return jsonb_build_object('status', 'refunded', 'already_refunded', true,
      'request_id', p_request_id, 'balance', to_jsonb(b));
  end if;

  -- Expired daily credits do not roll into another day. Purchased credits
  -- always return to the purchased pool, even when failure crosses midnight.
  free_refund := case when r.credit_date = b.free_credit_date
    then least(r.free_credits, 50 - b.free_credits) else 0 end;
  update public.credit_balances
    set free_credits = free_credits + free_refund,
        purchased_credits = purchased_credits + r.purchased_credits,
        updated_at = now()
    where user_id = p_user_id returning * into b;
  insert into public.credit_transactions
    (user_id, reference, reason, free_credit_change, purchased_credit_change)
  values (p_user_id, 'generation-refund:' || p_user_id::text || ':' || p_request_id::text,
    'refund', free_refund, r.purchased_credits);
  update public.credit_reservations set status = 'refunded', updated_at = now()
    where user_id = p_user_id and request_id = p_request_id;
  return jsonb_build_object('status', 'refunded', 'already_refunded', false,
    'request_id', p_request_id, 'balance', to_jsonb(b));
end;
$$;

revoke all on function public.reserve_generation_credits(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_generation_credits(uuid, uuid) from public, anon, authenticated;
revoke all on function public.refund_generation_credits(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_generation_credits(uuid, uuid) to service_role;
grant execute on function public.complete_generation_credits(uuid, uuid) to service_role;
grant execute on function public.refund_generation_credits(uuid, uuid) to service_role;

commit;
