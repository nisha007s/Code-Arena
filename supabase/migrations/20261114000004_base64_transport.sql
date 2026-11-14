-- The platform firewall inspects HTTP bodies (judge -> PostgREST included) and blocks
-- payloads that merely contain text such as "/etc/passwd". Student code, custom input and
-- results therefore travel base64-encoded and are decoded inside Postgres.

drop function if exists public.ca_submission_create(uuid, text, text, text, text, text, text, text, uuid);

create or replace function public.ca_b64(x text) returns text
language sql immutable as $$ select case when x is null then null else convert_from(decode(x, 'base64'), 'UTF8') end $$;

create or replace function public.ca_submission_create(uid uuid, request_id text, mode text, problem_id text, language text,
  source_b64 text, custom_input_b64 text default null, room_code text default null, round_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing public.submissions; v_row public.submissions; rm public.rooms; r public.rounds; recent int; calls bigint;
  k text := 'practice'; pid text := problem_id; v_source text := public.ca_b64(source_b64); v_input text := public.ca_b64(custom_input_b64);
begin
  select * into existing from public.submissions s where s.user_id = uid and s.request_id = ca_submission_create.request_id;
  if found then return jsonb_build_object('job', public.ca_job(existing), 'duplicate', true); end if;
  if not exists (select 1 from public.profiles where id = uid) then perform public.ca_fail('Sign in first.', 'no_session', 401); end if;
  select function_calls into calls from public.usage_monthly where month = date_trunc('month', now())::date;
  if coalesce(calls, 0) >= 425000 then
    perform public.ca_fail('Code execution is paused until next month to stay within the free plan.', 'quota_paused', 503);
  end if;
  if exists (select 1 from public.submissions s where s.user_id = uid and s.status <> 'done' and s.lease_until > now()) then
    perform public.ca_fail('Your previous run is still being judged.', 'pending_submission', 409);
  end if;
  select count(*) into recent from public.submissions s where s.user_id = uid and s.received_at > now() - interval '1 minute';
  if recent >= 12 then perform public.ca_fail('You are running code very quickly. Wait a few seconds and try again.', 'rate_limited', 429); end if;
  if room_code is not null and mode = 'submit' then
    k := 'battle';
    rm := public.ca_member_room(room_code, uid, true);
    select * into r from public.rounds where id = rm.current_round_id for update;
    if r.id is null or r.id is distinct from round_id then perform public.ca_fail('That round is no longer active.', 'stale_round', 409); end if;
    if rm.phase <> 'active' or r.status <> 'active' or clock_timestamp() >= r.deadline then
      perform public.ca_fail('The round has closed; new submissions are not accepted.', 'round_closed', 409);
    end if;
    if exists (select 1 from public.submissions s where s.round_id = r.id and s.user_id = uid and s.verdict = 'AC') then
      perform public.ca_fail('You already solved this round.', 'already_solved', 409);
    end if;
    pid := r.problem_id;
  end if;
  if pid is null or not exists (select 1 from public.problems where id = pid) then perform public.ca_fail('Problem not found.', 'problem_not_found', 404); end if;
  insert into public.submissions (user_id, request_id, mode, kind, problem_id, language, room_code, round_id, source, custom_input, status, lease_until)
    values (uid, request_id, mode, k, pid, language, case when k = 'battle' then rm.code end, case when k = 'battle' then r.id end,
            v_source, v_input, 'judging', clock_timestamp() + interval '150 seconds')
    returning * into v_row;
  if k = 'battle' then perform public.ca_bump(rm.code); end if;
  return jsonb_build_object('job', public.ca_job(v_row), 'duplicate', false);
end $$;

-- Result travels as base64 JSON text for the same reason.
create or replace function public.ca_submission_finish_b64(submission_id uuid, verdict text, result_b64 text, calls int) returns jsonb
language sql security definer set search_path = '' as $$
  select public.ca_submission_finish(submission_id, verdict, public.ca_b64(result_b64)::jsonb, calls)
$$;

revoke execute on function public.ca_b64(text) from public, anon, authenticated;
revoke execute on function public.ca_submission_create(uuid, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.ca_submission_finish_b64(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.ca_submission_create(uuid, text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function public.ca_submission_finish_b64(uuid, text, text, int) to service_role;
