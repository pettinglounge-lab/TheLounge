-- Run in Supabase SQL Editor after creating the credit tables.
begin;

create or replace function public.get_member_credit_balance()
returns public.credit_balances
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_id uuid := auth.uid();
  credit_day date := (now() at time zone 'America/Chicago')::date;
  balance public.credit_balances;
begin
  -- Confirm permanent membership against Auth, not a supplied user ID.
  if member_id is null or not exists (
    select 1 from auth.users where id = member_id and is_anonymous = false
  ) then
    raise exception 'A signed-in member account is required'
      using errcode = '42501';
  end if;

  insert into public.credit_balances (user_id, free_credit_date)
  values (member_id, credit_day)
  on conflict (user_id) do nothing;

  select * into balance from public.credit_balances
  where user_id = member_id for update;

  if balance.free_credit_date < credit_day then
    insert into public.credit_transactions
      (user_id, reference, reason, free_credit_change)
    values (
      member_id,
      'daily-reset:' || member_id::text || ':' || credit_day::text,
      'daily_reset',
      50 - balance.free_credits
    );

    update public.credit_balances
    set free_credits = 50,
        free_credit_date = credit_day,
        updated_at = now()
    where user_id = member_id
    returning * into balance;
  end if;

  return balance;
end;
$$;

revoke all on function public.get_member_credit_balance() from public, anon;
grant execute on function public.get_member_credit_balance() to authenticated;

commit;
