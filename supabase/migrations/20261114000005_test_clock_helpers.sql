-- Test-only clock helpers for the acceptance tests (scripts/supabase/test-api.mjs).
-- They move timestamps into the past so deadline, settle-window and disconnect rules can be
-- tested without waiting 10 minutes. Executable by service_role only (never by browsers).

create or replace function public.ca_test_age_round(round_id uuid, seconds int) returns void
language sql security definer set search_path = '' as $$
  update public.rounds set started_at = started_at - make_interval(secs => seconds), deadline = deadline - make_interval(secs => seconds),
    settle_deadline = settle_deadline - make_interval(secs => seconds) where id = round_id;
$$;

create or replace function public.ca_test_age_seat(room_code text, seat int, seconds int) returns void
language sql security definer set search_path = '' as $$
  update public.room_seats set last_seen_at = last_seen_at - make_interval(secs => seconds)
  where room_seats.room_code = ca_test_age_seat.room_code and room_seats.seat = ca_test_age_seat.seat;
$$;

revoke execute on function public.ca_test_age_round(uuid, int) from public, anon, authenticated;
revoke execute on function public.ca_test_age_seat(text, int, int) from public, anon, authenticated;
grant execute on function public.ca_test_age_round(uuid, int), public.ca_test_age_seat(text, int, int) to service_role;
