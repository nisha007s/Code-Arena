-- Housekeeping every 15 seconds: deadlines, settle windows, dead judge jobs, lobby
-- grace periods and idle rooms (see public.ca_maintenance). pg_cron runs inside Postgres.
create extension if not exists pg_cron;

select cron.schedule('code-arena-maintenance', '15 seconds', $$select public.ca_maintenance()$$);
