-- ca_uid() raises when there is no session, so it must not be declared STABLE (db lint warning).
alter function public.ca_uid() volatile;
