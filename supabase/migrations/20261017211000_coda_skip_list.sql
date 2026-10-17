-- Coda rows deliberately removed from the new Disco. The final re-copy from Coda (Phase 7) must skip these,
-- so a disco deleted here (e.g. an older copy replaced by a re-save) doesn't come back.
create table if not exists private.coda_skip (
  coda_row_id text primary key,
  reason text not null,
  created_at timestamptz not null default now()
);
alter table private.coda_skip enable row level security;
insert into private.coda_skip (coda_row_id, reason) values
  ('15807', 'older copy; CJ re-saved with the new extension 2026-10-17'),
  ('15808', 'older copy; CJ re-saved with the new extension 2026-10-17'),
  ('15810', 'older copy; CJ re-saved with the new extension 2026-10-17')
on conflict (coda_row_id) do nothing;
