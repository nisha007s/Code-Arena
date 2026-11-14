-- Code Arena on Supabase: schema, row-level security and server-side game logic.
--
-- Security model
--   * Every table has RLS enabled. Browsers may only SELECT: public problems, their own
--     profile, their own submissions, and rooms they sit in (for Realtime notifications).
--   * No INSERT/UPDATE/DELETE is granted to anon/authenticated on any table. All writes go
--     through SECURITY DEFINER functions below, which check auth.uid() and validate input.
--   * Functions used by the judge (service_role) are not executable by browsers.
--   * Hidden tests are not stored in the database at all (they live in the runner functions).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 24),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table public.problems (
  id             text primary key,
  number         int not null unique,
  title          text not null,
  difficulty     text not null check (difficulty in ('easy', 'medium', 'hard')),
  tags           text[] not null,
  primary_topic  text not null,
  statement      jsonb not null,
  input_format   jsonb not null,
  output_format  jsonb not null,
  constraints    jsonb not null,
  examples       jsonb not null,
  starters       jsonb not null,
  time_limits    jsonb not null      -- { "python": ms, "javascript": ms } (informational; the judge enforces)
);

create table public.rooms (
  code              text primary key check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  host_id           uuid not null references public.profiles (id),
  difficulty        text not null check (difficulty in ('mixed', 'easy', 'medium', 'hard')),
  phase             text not null default 'lobby' check (phase in ('lobby', 'active', 'judging', 'finished', 'closed')),
  revision          bigint not null default 1,
  round_number      int not null default 0,
  current_round_id  uuid,
  last_problem_id   text references public.problems (id),
  closed_message    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index rooms_open_idx on public.rooms (phase, updated_at) where phase <> 'closed';

create table public.room_seats (
  room_code     text not null references public.rooms (code) on delete cascade,
  seat          smallint not null check (seat in (0, 1)),
  user_id       uuid not null references public.profiles (id),
  ready         boolean not null default false,
  connected     boolean not null default true,
  last_seen_at  timestamptz not null default now(),
  joined_at     timestamptz not null default now(),
  primary key (room_code, seat),
  unique (room_code, user_id)
);
create index room_seats_user_idx on public.room_seats (user_id);

create table public.rounds (
  id               uuid primary key default gen_random_uuid(),
  room_code        text not null references public.rooms (code) on delete cascade,
  number           int not null,
  problem_id       text not null references public.problems (id),
  started_at       timestamptz not null,
  deadline         timestamptz not null,
  settle_deadline  timestamptz,
  status           text not null check (status in ('active', 'judging', 'finished')),
  outcome          text check (outcome in ('win', 'draw', 'void')),
  winner_id        uuid,
  reason           text,
  result           jsonb,
  finished_at      timestamptz,
  unique (room_code, number)
);
create index rounds_due_idx on public.rounds (status, deadline) where status <> 'finished';

alter table public.rooms add constraint rooms_current_round_fk foreign key (current_round_id) references public.rounds (id);

create table public.round_players (
  round_id      uuid not null references public.rounds (id) on delete cascade,
  seat          smallint not null,
  user_id       uuid not null references public.profiles (id),
  display_name  text not null,
  primary key (round_id, seat)
);
create index round_players_user_idx on public.round_players (user_id);

create sequence public.submission_seq;

create table public.submissions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  request_id    text not null check (request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  mode          text not null check (mode in ('run', 'submit')),
  kind          text not null check (kind in ('practice', 'battle')),
  problem_id    text not null references public.problems (id),
  language      text not null check (language in ('python', 'javascript')),
  room_code     text references public.rooms (code),
  round_id      uuid references public.rounds (id),
  source        text not null check (octet_length(source) between 1 and 65536),
  custom_input  text check (custom_input is null or octet_length(custom_input) <= 65536),
  status        text not null default 'queued' check (status in ('queued', 'judging', 'done')),
  verdict       text check (verdict in ('AC', 'WA', 'RE', 'TLE', 'MLE', 'OLE', 'JU', 'OK', 'CE')),
  seq           bigint not null default nextval('public.submission_seq'),
  received_at   timestamptz not null default clock_timestamp(),
  finished_at   timestamptz,
  lease_until   timestamptz,
  result        jsonb,
  unique (user_id, request_id)
);
create index submissions_user_idx on public.submissions (user_id, received_at desc);
create index submissions_round_idx on public.submissions (round_id) where round_id is not null;
create index submissions_pending_idx on public.submissions (lease_until) where status <> 'done';

-- Idempotent lobby commands (ready/start/rematch with a client request id).
create table public.room_actions (
  user_id     uuid not null,
  request_id  text not null,
  result      jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, request_id)
);

-- Runner lanes: at most one in-flight request per runner function, so two submissions
-- can never share an Edge Function worker (and its CPU budget).
create table public.runner_lanes (
  name        text primary key,
  kind        text not null check (kind in ('js', 'pya', 'pyb')),
  busy_until  timestamptz not null default 'epoch',
  holder      uuid
);

-- Free-plan quota guard: Edge Function calls made by the judge this month.
create table public.usage_monthly (
  month           date primary key,
  function_calls  bigint not null default 0
);

-- Membership test used by the rooms RLS policy (room_seats itself is not browser-readable).
create or replace function public.ca_is_member(room_code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_seats s where s.room_code = ca_is_member.room_code and s.user_id = auth.uid())
$$;

-- ---------------------------------------------------------------- RLS

alter table public.profiles      enable row level security;
alter table public.problems      enable row level security;
alter table public.rooms         enable row level security;
alter table public.room_seats    enable row level security;
alter table public.rounds        enable row level security;
alter table public.round_players enable row level security;
alter table public.submissions   enable row level security;
alter table public.room_actions  enable row level security;
alter table public.runner_lanes  enable row level security;
alter table public.usage_monthly enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on sequence public.submission_seq from anon, authenticated;
grant select on public.problems to anon, authenticated;
grant select on public.profiles, public.rooms, public.submissions to authenticated;

create policy problems_public_read on public.problems for select to anon, authenticated using (true);
create policy profiles_own_read on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy submissions_own_read on public.submissions for select to authenticated using (user_id = (select auth.uid()));
create policy rooms_member_read on public.rooms for select to authenticated using (public.ca_is_member(code));
-- room_seats/rounds/round_players/room_actions/runner_lanes/usage_monthly: no policies => no browser access.

-- Realtime: browsers receive UPDATE notifications for rooms they sit in (RLS-filtered).
alter publication supabase_realtime add table public.rooms;

-- ---------------------------------------------------------------- helpers

create or replace function public.ca_fail(msg text, code text, status int default 400) returns void
language plpgsql as $$
begin
  raise exception using message = msg, hint = code, detail = status::text, errcode = 'P0001';
end $$;

create or replace function public.ca_ms(t timestamptz) returns bigint
language sql immutable as $$ select (extract(epoch from t) * 1000)::bigint $$;

create or replace function public.ca_uid() returns uuid
language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then perform public.ca_fail('Sign in first.', 'no_session', 401); end if;
  return u;
end $$;

create or replace function public.ca_verdict_label(v text) returns text
language sql immutable as $$
  select case v when 'AC' then 'Accepted' when 'WA' then 'Wrong Answer' when 'CE' then 'Compile/Syntax Error'
    when 'RE' then 'Runtime Error' when 'TLE' then 'Time Limit Exceeded' when 'OLE' then 'Output Limit Exceeded'
    when 'MLE' then 'Memory Limit Exceeded' when 'JU' then 'Judge Unavailable' when 'OK' then 'Finished' else null end
$$;

create or replace function public.ca_job(s public.submissions) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'requestId', s.request_id, 'mode', s.mode, 'kind', s.kind, 'problemId', s.problem_id,
    'language', s.language, 'roomCode', s.room_code, 'roundId', s.round_id, 'status', s.status,
    'verdict', s.verdict, 'verdictLabel', public.ca_verdict_label(s.verdict),
    'receivedAt', public.ca_ms(s.received_at), 'finishedAt', public.ca_ms(s.finished_at), 'result', s.result)
$$;

create or replace function public.ca_problem_public(p public.problems) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', p.id, 'number', p.number, 'title', p.title, 'difficulty', p.difficulty,
    'tags', to_jsonb(p.tags), 'statement', p.statement, 'inputFormat', p.input_format,
    'outputFormat', p.output_format, 'constraints', p.constraints, 'examples', p.examples, 'starters', p.starters)
$$;

create or replace function public.ca_bump(room_code text) returns void
language sql as $$
  update public.rooms set revision = revision + 1, updated_at = now() where code = room_code
$$;

-- ---------------------------------------------------------------- session & catalog

create or replace function public.ca_progress(uid uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'solved', coalesce((select jsonb_agg(distinct problem_id) from public.submissions where user_id = uid and mode = 'submit' and verdict = 'AC'), '[]'::jsonb),
    'solvedCount', (select count(distinct problem_id) from public.submissions where user_id = uid and mode = 'submit' and verdict = 'AC'),
    'attemptedCount', (select count(distinct problem_id) from public.submissions where user_id = uid and mode = 'submit' and status = 'done'),
    'total', (select count(*) from public.problems))
$$;

create or replace function public.ca_session() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); p public.profiles;
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; suffix text := '';
begin
  select * into p from public.profiles where id = uid;
  if not found then
    for i in 1..4 loop suffix := suffix || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    insert into public.profiles (id, display_name) values (uid, 'Guest-' || suffix)
      on conflict (id) do nothing;
    select * into p from public.profiles where id = uid;
  else
    update public.profiles set last_seen_at = now() where id = uid and last_seen_at < now() - interval '5 minutes';
  end if;
  return jsonb_build_object('guest', jsonb_build_object('id', p.id, 'name', p.display_name), 'progress', public.ca_progress(uid));
end $$;

create or replace function public.ca_rename(display_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); clean text;
begin
  clean := btrim(regexp_replace(coalesce(display_name, ''), '[[:cntrl:]<>]', '', 'g'));
  clean := regexp_replace(clean, '\s+', ' ', 'g');
  if char_length(clean) = 0 or char_length(clean) > 24 then
    perform public.ca_fail('Display names have 1 to 24 characters.', 'invalid_name', 400);
  end if;
  perform public.ca_session(); -- make sure the profile exists
  update public.profiles set display_name = clean where id = uid;
  -- Names shown in open rooms come from profiles, so opponents see the change on their next snapshot.
  update public.rooms r set revision = revision + 1, updated_at = now()
    where r.phase <> 'closed' and exists (select 1 from public.room_seats s where s.room_code = r.code and s.user_id = uid);
  return jsonb_build_object('guest', jsonb_build_object('id', uid, 'name', clean));
end $$;

create or replace function public.ca_problems() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  return jsonb_build_object('problems', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'number', p.number, 'title', p.title, 'difficulty', p.difficulty, 'tags', to_jsonb(p.tags),
      'primaryTopic', p.primary_topic,
      'solved', exists (select 1 from public.submissions s where s.user_id = uid and s.problem_id = p.id and s.mode = 'submit' and s.verdict = 'AC'),
      'attempted', exists (select 1 from public.submissions s where s.user_id = uid and s.problem_id = p.id and s.mode = 'submit' and s.status = 'done'))
      order by p.number)
    from public.problems p), '[]'::jsonb));
end $$;

create or replace function public.ca_problem(problem_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.problems;
begin
  select * into p from public.problems where id = problem_id;
  if not found then perform public.ca_fail('Problem not found.', 'problem_not_found', 404); end if;
  return jsonb_build_object('problem', public.ca_problem_public(p));
end $$;

-- The recommender runs in the browser on the user's own verdict history (no source code).
create or replace function public.ca_attempts() returns jsonb
language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('problem_id', problem_id, 'verdict', verdict, 'received_at', public.ca_ms(received_at), 'seq', seq) order by seq), '[]'::jsonb)
  from public.submissions where user_id = auth.uid() and mode = 'submit' and status = 'done'
$$;

create or replace function public.ca_history() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid();
begin
  return jsonb_build_object(
    'submissions', coalesce((select jsonb_agg(x order by (x->>'receivedAt')::bigint desc) from (
      select jsonb_build_object('id', s.id, 'problemId', s.problem_id, 'problemTitle', coalesce(p.title, s.problem_id), 'language', s.language,
        'kind', s.kind, 'roomCode', s.room_code, 'status', s.status, 'verdict', s.verdict,
        'receivedAt', public.ca_ms(s.received_at), 'finishedAt', public.ca_ms(s.finished_at)) x
      from public.submissions s left join public.problems p on p.id = s.problem_id
      where s.user_id = uid and s.mode = 'submit' order by s.received_at desc, s.seq desc limit 200) q), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(x order by (x->>'finishedAt')::bigint desc) from (
      select jsonb_build_object('roundId', r.id, 'roomCode', r.room_code, 'roundNumber', r.number, 'problemId', r.problem_id,
        'problemTitle', coalesce(p.title, r.problem_id), 'opponentName', coalesce(opp.display_name, '—'),
        'outcome', case when r.outcome = 'win' then (case when r.winner_id = uid then 'won' else 'lost' end) else r.outcome end,
        'myStatus', (select e->>'status' from jsonb_array_elements(coalesce(r.result->'players', '[]'::jsonb)) e where (e->>'seat')::int = me.seat limit 1),
        'reason', r.reason, 'startedAt', public.ca_ms(r.started_at), 'finishedAt', public.ca_ms(r.finished_at)) x
      from public.rounds r
      join public.round_players me on me.round_id = r.id and me.user_id = uid
      left join public.round_players opp on opp.round_id = r.id and opp.seat <> me.seat
      left join public.problems p on p.id = r.problem_id
      where r.status = 'finished' order by r.finished_at desc limit 100) q), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- rounds: decide & finalize

create or replace function public.ca_finalize_round(round_id uuid, reason_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rounds; rm public.rooms; p public.problems;
  win_seq bigint; win_user uuid; win_seat int; could_change boolean; v_outcome text; v_reason text; players jsonb;
begin
  select * into r from public.rounds where id = round_id for update;
  if not found or r.status = 'finished' then return; end if;
  select * into rm from public.rooms where code = r.room_code for update;
  -- Earliest server-received Accepted wins (by sequence number, never by judge finish time).
  select s.seq, s.user_id into win_seq, win_user from public.submissions s
    where s.round_id = r.id and s.mode = 'submit' and s.verdict = 'AC' order by s.seq limit 1;
  select seat into win_seat from public.round_players where round_players.round_id = r.id and user_id = win_user;
  -- A timely submission that could not be judged (pending or JU) and could change the result voids the round.
  select exists (select 1 from public.submissions s where s.round_id = r.id and s.mode = 'submit'
      and (s.status <> 'done' or s.verdict = 'JU')
      and (win_user is null or (s.user_id <> win_user and s.seq < win_seq))) into could_change;
  if could_change then v_outcome := 'void'; win_user := null; win_seat := null;
  elsif win_user is not null then v_outcome := 'win';
  else v_outcome := 'draw'; end if;
  v_reason := case when v_outcome = 'void' then 'A timely submission could not be judged and might have changed the result, so this round has no winner.'
    else case reason_key
      when 'both_solved' then 'Both players solved it; the earlier accepted submission wins.'
      when 'deadline' then 'Time ran out.'
      when 'settled' then 'Time ran out and every timely submission has been judged.'
      when 'settle_timeout' then 'Time ran out and the settling window closed.'
      else 'The round ended.' end end;
  select jsonb_agg(jsonb_build_object('seat', rp.seat, 'name', rp.display_name,
      'submissions', (select count(*) from public.submissions s where s.round_id = r.id and s.user_id = rp.user_id and s.mode = 'submit'),
      'status', case
        when exists (select 1 from public.submissions s where s.round_id = r.id and s.user_id = rp.user_id and s.verdict = 'AC') then 'solved'
        when exists (select 1 from public.submissions s where s.round_id = r.id and s.user_id = rp.user_id and (s.status <> 'done' or s.verdict = 'JU')) then 'unjudged'
        else 'not_solved' end,
      'solvedSeq', (select min(s.seq) from public.submissions s where s.round_id = r.id and s.user_id = rp.user_id and s.verdict = 'AC')) order by rp.seat)
    into players from public.round_players rp where rp.round_id = r.id;
  select * into p from public.problems where id = r.problem_id;
  update public.rounds set status = 'finished', outcome = v_outcome, winner_id = win_user, reason = v_reason, finished_at = now(),
    result = jsonb_build_object('outcome', v_outcome, 'winnerSeat', win_seat,
      'winnerName', (select display_name from public.round_players where round_players.round_id = r.id and seat = win_seat),
      'reason', v_reason, 'players', coalesce(players, '[]'::jsonb),
      'problem', jsonb_build_object('id', p.id, 'title', p.title, 'difficulty', p.difficulty),
      'roundNumber', r.number, 'finishedAt', public.ca_ms(now()))
    where id = r.id;
  update public.rooms set phase = 'finished', last_problem_id = r.problem_id, revision = revision + 1, updated_at = now()
    where code = r.room_code and phase in ('active', 'judging');
end $$;

-- Re-evaluate a round after time passes or a job finishes.
create or replace function public.ca_round_check(round_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rounds; pending boolean; solvers int;
begin
  select * into r from public.rounds where id = round_id for update;
  if not found or r.status = 'finished' then return; end if;
  select exists (select 1 from public.submissions s where s.round_id = r.id and s.mode = 'submit' and s.status <> 'done') into pending;
  select count(distinct s.user_id) into solvers from public.submissions s where s.round_id = r.id and s.mode = 'submit' and s.verdict = 'AC';
  if r.status = 'active' then
    if solvers >= 2 then perform public.ca_finalize_round(r.id, 'both_solved'); return; end if;
    if now() >= r.deadline then
      if not pending then perform public.ca_finalize_round(r.id, 'deadline'); return; end if;
      update public.rounds set status = 'judging', settle_deadline = r.deadline + interval '180 seconds' where id = r.id;
      update public.rooms set phase = 'judging', revision = revision + 1, updated_at = now() where code = r.room_code;
    end if;
  elsif r.status = 'judging' then
    if not pending then perform public.ca_finalize_round(r.id, 'settled');
    elsif now() >= r.settle_deadline then perform public.ca_finalize_round(r.id, 'settle_timeout'); end if;
  end if;
end $$;

-- ---------------------------------------------------------------- rooms

create or replace function public.ca_room_snapshot_for(room_code text, uid uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare rm public.rooms; r public.rounds; my_seat int := -1; players jsonb; prob jsonb := null; mine jsonb;
begin
  select * into rm from public.rooms where code = room_code;
  select seat into my_seat from public.room_seats where room_seats.room_code = rm.code and user_id = uid;
  my_seat := coalesce(my_seat, -1);
  if rm.current_round_id is not null then select * into r from public.rounds where id = rm.current_round_id; end if;
  select jsonb_agg(case when s.seat is null then 'null'::jsonb else jsonb_build_object(
      'seat', s.seat, 'name', pr.display_name, 'isHost', s.seat = 0, 'isYou', s.seat = my_seat, 'connected', s.connected, 'ready', s.ready,
      'status', case
        when rm.phase = 'lobby' then (case when s.ready then 'ready' else 'not_ready' end)
        when exists (select 1 from public.submissions x where x.round_id = r.id and x.user_id = s.user_id and x.verdict = 'AC') then 'solved'
        when exists (select 1 from public.submissions x where x.round_id = r.id and x.user_id = s.user_id and x.status <> 'done') then 'judging'
        when rm.phase = 'finished' then 'finished' else 'solving' end) end order by g.seat)
    into players
    from generate_series(0, 1) g(seat)
    left join public.room_seats s on s.room_code = rm.code and s.seat = g.seat
    left join public.profiles pr on pr.id = s.user_id;
  if r.id is not null and rm.phase <> 'lobby' then
    select public.ca_problem_public(p) into prob from public.problems p where p.id = r.problem_id;
  end if;
  select coalesce(jsonb_agg(public.ca_job(x) order by x.seq), '[]'::jsonb) into mine
    from public.submissions x where r.id is not null and x.round_id = r.id and x.user_id = uid;
  return jsonb_build_object(
    'revision', rm.revision, 'serverTime', public.ca_ms(clock_timestamp()), 'code', rm.code, 'phase', rm.phase,
    'difficulty', rm.difficulty, 'invitePath', '/arena.html?room=' || rm.code,
    'you', jsonb_build_object('seat', my_seat, 'isHost', my_seat = 0),
    'players', players,
    'round', case when r.id is null then null else jsonb_build_object('id', r.id, 'number', r.number,
      'startedAt', public.ca_ms(r.started_at), 'deadline', public.ca_ms(r.deadline),
      'settleDeadline', public.ca_ms(r.settle_deadline), 'durationMs', public.ca_ms(r.deadline) - public.ca_ms(r.started_at),
      'problem', prob) end,
    'result', case when rm.phase = 'finished' then r.result else null end,
    'closedMessage', rm.closed_message,
    'mySubmissions', mine);
end $$;

create or replace function public.ca_member_room(room_code text, uid uuid, lock boolean default false) returns public.rooms
language plpgsql security definer set search_path = '' as $$
declare rm public.rooms;
begin
  if room_code !~ '^[A-Za-z0-9]{6}$' then perform public.ca_fail('Room codes have six letters or digits.', 'invalid_code', 400); end if;
  if lock then select * into rm from public.rooms where code = upper(room_code) for update;
  else select * into rm from public.rooms where code = upper(room_code); end if;
  if not found or rm.phase = 'closed' then perform public.ca_fail('That room does not exist or has expired.', 'room_not_found', 404); end if;
  if not exists (select 1 from public.room_seats where room_seats.room_code = rm.code and user_id = uid) then
    perform public.ca_fail('You are not a player in this room.', 'not_member', 403);
  end if;
  return rm;
end $$;

create or replace function public.ca_active_room(uid uuid) returns public.rooms
language sql stable security definer set search_path = '' as $$
  select r.* from public.rooms r join public.room_seats s on s.room_code = r.code
  where s.user_id = uid and r.phase <> 'closed' order by r.updated_at desc limit 1
$$;

create or replace function public.ca_close_room(room_code text, message text) returns void
language sql security definer set search_path = '' as $$
  update public.rooms set phase = 'closed', closed_message = message, revision = revision + 1, updated_at = now() where code = room_code;
$$;

create or replace function public.ca_room_leave_internal(rm public.rooms, uid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare my_seat int;
begin
  select seat into my_seat from public.room_seats where room_code = rm.code and user_id = uid;
  if my_seat is null then return; end if;
  if rm.phase in ('active', 'judging') then
    perform public.ca_fail('You cannot leave during a round. The clock keeps running if you disconnect.', 'round_in_progress', 409);
  end if;
  if my_seat = 0 then perform public.ca_close_room(rm.code, 'The host closed the room.'); return; end if;
  delete from public.room_seats where room_code = rm.code and seat = 1;
  update public.room_seats set ready = false where room_code = rm.code and seat = 0;
  update public.rooms set phase = case when phase = 'finished' then 'lobby' else phase end,
    current_round_id = case when phase = 'finished' then null else current_round_id end,
    revision = revision + 1, updated_at = now() where code = rm.code;
end $$;

create or replace function public.ca_room_create(difficulty text default 'mixed') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); cur public.rooms; new_code text; alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; recent int;
begin
  perform public.ca_session();
  if difficulty is null or difficulty not in ('mixed', 'easy', 'medium', 'hard') then
    perform public.ca_fail('Difficulty must be mixed, easy, medium or hard.', 'invalid_difficulty', 400);
  end if;
  select count(*) into recent from public.rooms where host_id = uid and created_at > now() - interval '1 minute';
  if recent >= 5 then perform public.ca_fail('Too many room requests. Wait a moment and try again.', 'rate_limited', 429); end if;
  cur := public.ca_active_room(uid);
  if cur.code is not null then
    if cur.phase <> 'finished' and cur.phase <> 'lobby' then
      perform public.ca_fail(format('You are already in room %s. Leave it first.', cur.code), 'already_in_room', 409);
    end if;
    if cur.phase = 'lobby' then
      perform public.ca_fail(format('You are already in room %s. Leave it first.', cur.code), 'already_in_room', 409);
    end if;
    perform public.ca_room_leave_internal(cur, uid);
  end if;
  loop
    new_code := '';
    for i in 1..6 loop new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.rooms where code = new_code);
  end loop;
  insert into public.rooms (code, host_id, difficulty) values (new_code, uid, difficulty);
  insert into public.room_seats (room_code, seat, user_id) values (new_code, 0, uid);
  return jsonb_build_object('room', public.ca_room_snapshot_for(new_code, uid));
end $$;

create or replace function public.ca_room_join(room_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); rm public.rooms; other public.rooms; recent int;
begin
  perform public.ca_session();
  if room_code is null or room_code !~ '^[A-Za-z0-9]{6}$' then perform public.ca_fail('Room codes have six letters or digits.', 'invalid_code', 400); end if;
  select * into rm from public.rooms where code = upper(room_code) for update;
  if not found or rm.phase = 'closed' then perform public.ca_fail('That room does not exist or has expired.', 'room_not_found', 404); end if;
  if exists (select 1 from public.room_seats s where s.room_code = rm.code and s.user_id = uid) then
    update public.room_seats set last_seen_at = now() where room_seats.room_code = rm.code and user_id = uid;
    return jsonb_build_object('room', public.ca_room_snapshot_for(rm.code, uid)); -- reclaim own seat
  end if;
  if exists (select 1 from public.room_seats s where s.room_code = rm.code and s.seat = 1) then
    perform public.ca_fail('This room already has two players.', 'room_full', 409);
  end if;
  if rm.phase <> 'lobby' then perform public.ca_fail('This match has already started.', 'match_in_progress', 409); end if;
  other := public.ca_active_room(uid);
  if other.code is not null then
    if other.phase <> 'finished' then perform public.ca_fail(format('You are already in room %s. Leave it first.', other.code), 'already_in_room', 409); end if;
    perform public.ca_room_leave_internal(other, uid);
  end if;
  insert into public.room_seats (room_code, seat, user_id) values (rm.code, 1, uid);
  perform public.ca_bump(rm.code);
  return jsonb_build_object('room', public.ca_room_snapshot_for(rm.code, uid));
end $$;

create or replace function public.ca_room_current() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); rm public.rooms;
begin
  rm := public.ca_active_room(uid);
  if rm.code is null then return jsonb_build_object('room', null); end if;
  return jsonb_build_object('room', public.ca_room_snapshot_for(rm.code, uid));
end $$;

-- Snapshot + heartbeat + clock check. Called on subscribe, on every Realtime notification,
-- every few seconds as a heartbeat, and when the countdown reaches zero.
create or replace function public.ca_room_snapshot(room_code text, heartbeat boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); rm public.rooms; was_connected boolean;
begin
  -- A closed room still answers its former players once, with the reason it closed.
  select r.* into rm from public.rooms r where r.code = upper(room_code) and r.phase = 'closed'
    and exists (select 1 from public.room_seats s where s.room_code = r.code and s.user_id = uid);
  if found then return jsonb_build_object('snapshot', jsonb_build_object('code', rm.code, 'phase', 'closed', 'closedMessage', rm.closed_message, 'revision', rm.revision)); end if;
  rm := public.ca_member_room(room_code, uid);
  if heartbeat then
    select connected into was_connected from public.room_seats s where s.room_code = rm.code and s.user_id = uid;
    update public.room_seats s set last_seen_at = now(), connected = true where s.room_code = rm.code and s.user_id = uid;
    if not was_connected then perform public.ca_bump(rm.code); end if;
  end if;
  if rm.current_round_id is not null and rm.phase in ('active', 'judging') then perform public.ca_round_check(rm.current_round_id); end if;
  return jsonb_build_object('snapshot', public.ca_room_snapshot_for(rm.code, uid));
end $$;

create or replace function public.ca_room_leave(room_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); rm public.rooms;
begin
  rm := public.ca_member_room(room_code, uid, true);
  perform public.ca_room_leave_internal(rm, uid);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.ca_once(uid uuid, request_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select result from public.room_actions where user_id = uid and room_actions.request_id = ca_once.request_id
$$;

create or replace function public.ca_room_ready(room_code text, ready boolean, request_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); rm public.rooms; prev jsonb;
begin
  if request_id is not null then prev := public.ca_once(uid, request_id); if prev is not null then return prev; end if; end if;
  rm := public.ca_member_room(room_code, uid, true);
  if rm.phase <> 'lobby' then perform public.ca_fail('Readiness can only change in the lobby.', 'wrong_phase', 409); end if;
  update public.room_seats s set ready = coalesce(ca_room_ready.ready, false), last_seen_at = now(), connected = true where s.room_code = rm.code and s.user_id = uid;
  perform public.ca_bump(rm.code);
  if request_id is not null then insert into public.room_actions values (uid, request_id, '{"ok":true}', now()) on conflict do nothing; end if;
  return '{"ok":true}'::jsonb;
end $$;

create or replace function public.ca_room_start(room_code text, request_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); rm public.rooms; prev jsonb; s record; pick text; rid uuid; n int; out jsonb;
begin
  if request_id is not null then prev := public.ca_once(uid, request_id); if prev is not null then return prev; end if; end if;
  rm := public.ca_member_room(room_code, uid, true);
  if (select seat from public.room_seats x where x.room_code = rm.code and x.user_id = uid) <> 0 then
    perform public.ca_fail('Only the host can start the match.', 'not_host', 403);
  end if;
  if rm.phase <> 'lobby' then perform public.ca_fail('The match is not in the lobby.', 'wrong_phase', 409); end if;
  if not exists (select 1 from public.room_seats x where x.room_code = rm.code and x.seat = 1) then
    perform public.ca_fail('Wait for your friend to join.', 'waiting_for_player', 409);
  end if;
  for s in select x.*, p.display_name from public.room_seats x join public.profiles p on p.id = x.user_id where x.room_code = rm.code order by x.seat loop
    if not s.connected or s.last_seen_at < now() - interval '40 seconds' then
      perform public.ca_fail(format('%s is not connected.', s.display_name), 'player_disconnected', 409);
    end if;
    if not s.ready then perform public.ca_fail('Both players must be ready.', 'not_ready', 409); end if;
  end loop;
  select id into pick from public.problems
    where (rm.difficulty = 'mixed' or difficulty = rm.difficulty)
      and (rm.last_problem_id is null or id <> rm.last_problem_id
           or (select count(*) from public.problems q where rm.difficulty = 'mixed' or q.difficulty = rm.difficulty) <= 1)
    order by random() limit 1;
  n := rm.round_number + 1;
  insert into public.rounds (room_code, number, problem_id, started_at, deadline, status)
    values (rm.code, n, pick, now(), now() + interval '10 minutes', 'active') returning id into rid;
  insert into public.round_players (round_id, seat, user_id, display_name)
    select rid, x.seat, x.user_id, p.display_name from public.room_seats x join public.profiles p on p.id = x.user_id where x.room_code = rm.code;
  update public.rooms set phase = 'active', round_number = n, current_round_id = rid, last_problem_id = pick,
    revision = revision + 1, updated_at = now() where code = rm.code;
  out := jsonb_build_object('ok', true, 'roundId', rid);
  if request_id is not null then insert into public.room_actions values (uid, request_id, out, now()) on conflict do nothing; end if;
  return out;
end $$;

create or replace function public.ca_room_rematch(room_code text, request_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.ca_uid(); rm public.rooms; prev jsonb;
begin
  if request_id is not null then prev := public.ca_once(uid, request_id); if prev is not null then return prev; end if; end if;
  rm := public.ca_member_room(room_code, uid, true);
  if (select seat from public.room_seats x where x.room_code = rm.code and x.user_id = uid) <> 0 then
    perform public.ca_fail('Only the host can start a rematch.', 'not_host', 403);
  end if;
  if rm.phase <> 'finished' then perform public.ca_fail('The round has not finished.', 'wrong_phase', 409); end if;
  if (select count(*) from public.room_seats x where x.room_code = rm.code) < 2 then
    perform public.ca_fail('A rematch needs both players in the room.', 'waiting_for_player', 409);
  end if;
  update public.room_seats x set ready = false where x.room_code = rm.code;
  update public.rooms set phase = 'lobby', current_round_id = null, revision = revision + 1, updated_at = now() where code = rm.code;
  if request_id is not null then insert into public.room_actions values (uid, request_id, '{"ok":true}', now()) on conflict do nothing; end if;
  return '{"ok":true}'::jsonb;
end $$;

-- ---------------------------------------------------------------- judge (service_role only)

-- Admit a Run/Submit. Called by the judge Edge Function after it verified the user's token.
create or replace function public.ca_submission_create(uid uuid, request_id text, mode text, problem_id text, language text,
  source text, custom_input text default null, room_code text default null, round_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing public.submissions; v_row public.submissions; rm public.rooms; r public.rounds; recent int; calls bigint; k text := 'practice'; pid text := problem_id;
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
  if not exists (select 1 from public.problems where id = pid) then perform public.ca_fail('Problem not found.', 'problem_not_found', 404); end if;
  insert into public.submissions (user_id, request_id, mode, kind, problem_id, language, room_code, round_id, source, custom_input, status, lease_until)
    values (uid, request_id, mode, k, pid, language, case when k = 'battle' then rm.code end, case when k = 'battle' then r.id end,
            source, custom_input, 'judging', clock_timestamp() + interval '150 seconds')
    returning * into v_row;
  if k = 'battle' then perform public.ca_bump(rm.code); end if;
  return jsonb_build_object('job', public.ca_job(v_row), 'duplicate', false);
end $$;

create or replace function public.ca_submission_finish(submission_id uuid, verdict text, result jsonb, calls int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.submissions;
begin
  update public.submissions x set status = 'done', verdict = ca_submission_finish.verdict, result = ca_submission_finish.result,
    finished_at = clock_timestamp(), lease_until = null
    where x.id = submission_id and x.status <> 'done' returning * into s;
  insert into public.usage_monthly (month, function_calls) values (date_trunc('month', now())::date, greatest(calls, 0) + 1)
    on conflict (month) do update set function_calls = public.usage_monthly.function_calls + excluded.function_calls;
  if s.id is null then return null; end if;
  if s.round_id is not null then
    perform public.ca_bump(s.room_code);
    perform public.ca_round_check(s.round_id);
  end if;
  return public.ca_job(s);
end $$;

create or replace function public.ca_lane_acquire(lane_kind text, holder uuid, battle boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare picked text; free_count int;
begin
  select count(*) into free_count from public.runner_lanes where kind = lane_kind and busy_until < clock_timestamp();
  -- Keep one lane of each kind free for battle submissions.
  if free_count = 0 or (not battle and free_count < 2) then return null; end if;
  update public.runner_lanes set busy_until = clock_timestamp() + interval '12 seconds', holder = ca_lane_acquire.holder
    where name = (select name from public.runner_lanes where kind = lane_kind and busy_until < clock_timestamp()
                  order by random() limit 1 for update skip locked)
    returning name into picked;
  return picked;
end $$;

create or replace function public.ca_lane_release(lane text, holder uuid) returns void
language sql security definer set search_path = '' as $$
  update public.runner_lanes set busy_until = 'epoch', holder = null where name = lane and runner_lanes.holder = ca_lane_release.holder
$$;

-- ---------------------------------------------------------------- maintenance (cron)

create or replace function public.ca_maintenance() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x record; n_rounds int := 0; n_jobs int := 0; n_seats int := 0; n_rooms int := 0;
begin
  -- Jobs whose judge died (lease expired) become Judge Unavailable.
  for x in select id from public.submissions where status <> 'done' and lease_until < now() limit 200 loop
    perform public.ca_submission_finish(x.id, 'JU', jsonb_build_object('compile', null, 'cases', '[]'::jsonb, 'hidden', null,
      'message', 'The judge did not finish this run. Please submit again.'), 0);
    n_jobs := n_jobs + 1;
  end loop;
  -- Rounds past their deadline / settle deadline.
  for x in select id from public.rounds where status <> 'finished' and (deadline <= now() or settle_deadline <= now()) loop
    perform public.ca_round_check(x.id); n_rounds := n_rounds + 1;
  end loop;
  -- Heartbeats: mark seats disconnected after 35 s of silence (notify the opponent).
  for x in select distinct s.room_code from public.room_seats s join public.rooms r on r.code = s.room_code
           where r.phase <> 'closed' and s.connected and s.last_seen_at < now() - interval '35 seconds' loop
    update public.room_seats set connected = false where room_code = x.room_code and connected and last_seen_at < now() - interval '35 seconds';
    perform public.ca_bump(x.room_code);
  end loop;
  -- Lobby grace: free seats silent for 2 minutes; close the room if the host is gone.
  for x in select s.room_code, s.seat from public.room_seats s join public.rooms r on r.code = s.room_code
           where r.phase = 'lobby' and s.last_seen_at < now() - interval '2 minutes' loop
    if x.seat = 0 then perform public.ca_close_room(x.room_code, 'The host left, so the room expired.'); n_rooms := n_rooms + 1;
    else
      delete from public.room_seats where room_code = x.room_code and seat = 1;
      update public.room_seats set ready = false where room_code = x.room_code and seat = 0;
      perform public.ca_bump(x.room_code); n_seats := n_seats + 1;
    end if;
  end loop;
  -- Finished rooms nobody looked at for 30 minutes expire.
  for x in select r.code from public.rooms r where r.phase = 'finished' and r.updated_at < now() - interval '30 minutes'
           and not exists (select 1 from public.room_seats s where s.room_code = r.code and s.last_seen_at > now() - interval '30 minutes') loop
    perform public.ca_close_room(x.code, 'The room expired.'); n_rooms := n_rooms + 1;
  end loop;
  delete from public.room_actions where created_at < now() - interval '1 day';
  return jsonb_build_object('jobs', n_jobs, 'rounds', n_rounds, 'seats', n_seats, 'rooms', n_rooms);
end $$;

-- ---------------------------------------------------------------- privileges

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.ca_session(), public.ca_rename(text), public.ca_problems(), public.ca_problem(text), public.ca_attempts(),
  public.ca_history(), public.ca_room_create(text), public.ca_room_join(text), public.ca_room_current(),
  public.ca_room_snapshot(text, boolean), public.ca_room_leave(text), public.ca_room_ready(text, boolean, text),
  public.ca_room_start(text, text), public.ca_room_rematch(text, text)
  to authenticated;
grant execute on function public.ca_problems(), public.ca_problem(text) to anon;
grant execute on function public.ca_is_member(text) to authenticated;
grant execute on function
  public.ca_submission_create(uuid, text, text, text, text, text, text, text, uuid),
  public.ca_submission_finish(uuid, text, jsonb, int),
  public.ca_lane_acquire(text, uuid, boolean), public.ca_lane_release(text, uuid), public.ca_maintenance()
  to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Runner lanes (3 per kind; see supabase/functions).
insert into public.runner_lanes (name, kind) values
  ('run-js-1', 'js'), ('run-js-2', 'js'), ('run-js-3', 'js'),
  ('run-pya-1', 'pya'), ('run-pya-2', 'pya'), ('run-pya-3', 'pya'),
  ('run-pyb-1', 'pyb'), ('run-pyb-2', 'pyb'), ('run-pyb-3', 'pyb');
