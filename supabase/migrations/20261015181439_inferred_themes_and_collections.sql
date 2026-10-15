-- Collections: tags that describe what kind of disco it is rather than its subject
-- (quotes, vocabulary, wines to try, recipes). Browsable, but never used to pick feed topics
-- or to infer themes.
alter table public.topics drop constraint topics_kind_check;
alter table public.topics add constraint topics_kind_check
  check (kind in ('subject','person','work','place','group','collection'));

-- What each topic is FOR THIS USER, worked out behind the scenes from how they tag and what
-- their discos say. Never edited by the user; recomputed by a scheduled job.
create table public.user_topic_profiles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  role text not null default 'subject' check (role in ('subject','theme')),
  disco_count int not null default 0,
  spread numeric(5,2),          -- effective number of DIG areas the topic's discos draw on
  bridge numeric(4,3),          -- share held by the second-largest area (0 to 1)
  idea_score numeric(4,3),      -- 0 to 1: how much the tag names an open question or abstract idea
  confidence numeric(4,3),      -- grows with disco count
  areas jsonb not null default '{}',   -- {area_topic_id: share} the topic's discos draw on
  links jsonb not null default '[]',   -- [{topic_id, weight}] subjects that feed this theme for this user
  computed_at timestamptz not null default now(),
  primary key (user_id, topic_id)
);
create index user_topic_profiles_topic_idx on public.user_topic_profiles(topic_id);
create index user_topic_profiles_theme_idx on public.user_topic_profiles(user_id) where role = 'theme';
comment on table public.user_topic_profiles is 'Inferred per-user role of each topic (subject or theme) and the fields it draws on. Written only by server jobs.';

alter table public.user_topic_profiles enable row level security;
create policy "read own" on public.user_topic_profiles for select to authenticated using (user_id = (select auth.uid()));
