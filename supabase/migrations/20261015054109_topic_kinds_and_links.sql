-- Topics can be subjects, people, works, places or groups.
-- The parent_id tree stays for subjects (and places within subjects);
-- people and groups connect to subjects through links, and works link to their author.
alter table public.topics
  add column kind text not null default 'subject'
  check (kind in ('subject','person','work','place','group'));
create index topics_kind_idx on public.topics(kind);
comment on column public.topics.kind is 'subject (DIG tree), person, work, place, or group (organization, movement, people).';

create table public.topic_links (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics(id) on delete cascade,
  related_id uuid not null references public.topics(id) on delete cascade,
  relation text not null default 'about' check (relation in ('about','by','related')),
  created_at timestamptz not null default now(),
  unique (topic_id, related_id, relation),
  check (topic_id <> related_id)
);
create index topic_links_related_idx on public.topic_links(related_id);
comment on table public.topic_links is 'Shared links between topics: a person or group is "about" subjects; a work is "by" its author; "related" for loose ties.';

alter table public.topic_links enable row level security;
create policy "catalog read" on public.topic_links for select to authenticated using (true);
