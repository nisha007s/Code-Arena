-- Free-plan quota monitoring (service_role only): judge Edge Function calls this month
-- (the judge stops accepting code at 425,000 of the 500,000 free calls), database size
-- (500 MB free) and table sizes. Read with scripts/supabase/usage.mjs.
create or replace function public.ca_usage_report() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'month', date_trunc('month', now())::date,
    'judgeFunctionCalls', coalesce((select function_calls from public.usage_monthly where month = date_trunc('month', now())::date), 0),
    'judgeCallLimit', 425000,
    'freeInvocationQuota', 500000,
    'databaseBytes', pg_database_size(current_database()),
    'freeDatabaseBytes', 500 * 1024 * 1024,
    'profiles', (select count(*) from public.profiles),
    'submissionsThisMonth', (select count(*) from public.submissions where received_at >= date_trunc('month', now())),
    'submissionsTotal', (select count(*) from public.submissions),
    'openRooms', (select count(*) from public.rooms where phase <> 'closed'),
    'submissionsTableBytes', pg_total_relation_size('public.submissions'))
$$;
revoke execute on function public.ca_usage_report() from public, anon, authenticated;
grant execute on function public.ca_usage_report() to service_role;
