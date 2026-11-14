// Which backend this frontend talks to.
//   'supabase' (default, the public deployment): Supabase Auth/Postgres/Realtime + the judge Edge Function.
//   'local': the original Express + Socket.IO + Docker backend (server/ serves its own /js/config.js).
// The anon key is a public, browser-safe key; every table is protected by row-level security.
export const CONFIG = {
  backend: 'supabase',
  supabaseUrl: 'https://kyabmrwffikjivbbqvln.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5YWJtcndmZmlraml2YmJxdmxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1ODQ1NzgsImV4cCI6MjExMDE2MDU3OH0.elaJBWBV0Qe3PZ4bBbtRvbrt3pD_0o1DDndxx0zFKT8',
  languages: [['python', 'Python 3'], ['javascript', 'JavaScript']],
};
