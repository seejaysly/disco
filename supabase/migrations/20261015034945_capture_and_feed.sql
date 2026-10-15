-- CAPTURE -----------------------------------------------------------
create table public.discos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'highlight' check (kind in ('highlight','vocabulary','image','video','note')),
  quote text,
  text_captured text,
  prefix text,
  suffix text,
  note text,
  details jsonb not null default '{}',
  url text,
  source_id uuid references public.sources(id) on delete set null,
  article_id uuid references public.articles(id) on delete set null,
  captured_at timestamptz not null default now(),
  capture_method text not null default 'extension' check (capture_method in ('extension','shortcut','share','paste','feed','kindle','migrated')),
  visibility text not null default 'private' check (visibility in ('private','shared','public')),
  coda_row_id text,
  embedding extensions.vector(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, coda_row_id)
);
create index discos_user_captured_idx on public.discos(user_id, captured_at desc);
create index discos_source_idx on public.discos(source_id);
create index discos_article_idx on public.discos(article_id);
create index discos_embedding_idx on public.discos using hnsw (embedding extensions.vector_cosine_ops);
comment on column public.discos.quote is 'Summary (what CJ kept / abbreviated).';
comment on column public.discos.text_captured is 'Original captured text.';
comment on column public.discos.details is 'vocabulary: definition, pronunciation, part_of_speech, etymology, example; video: platform, start_seconds, end_seconds; kindle: asin, location.';

create table public.disco_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  disco_id uuid not null references public.discos(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, disco_id, topic_id)
);
create index disco_topics_disco_idx on public.disco_topics(disco_id);
create index disco_topics_user_topic_idx on public.disco_topics(user_id, topic_id);
create index disco_topics_topic_idx on public.disco_topics(topic_id);

create table public.disco_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  disco_id uuid not null references public.discos(id) on delete cascade,
  storage_path text not null unique,
  original_url text,
  alt_text text,
  caption text,
  width int,
  height int,
  created_at timestamptz not null default now()
);
create index disco_media_disco_idx on public.disco_media(disco_id);
create index disco_media_user_idx on public.disco_media(user_id);

create table public.revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('disco','guide_item','comment')),
  target_id uuid not null,
  field text not null,
  previous_value text,
  edited_at timestamptz not null default now()
);
create index revisions_target_idx on public.revisions(target_type, target_id);
create index revisions_user_idx on public.revisions(user_id);

create table public.vocab_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  disco_id uuid not null references public.discos(id) on delete cascade,
  first_shown_on date,
  last_shown_on date,
  times_shown int not null default 0,
  learned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, disco_id)
);
create index vocab_progress_disco_idx on public.vocab_progress(disco_id);

-- FEED --------------------------------------------------------------
create table public.editions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  edition_date date not null,
  variant text not null default 'dig' check (variant in ('dig','coda_import')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, edition_date, variant)
);

create table public.edition_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  topic_id uuid references public.topics(id) on delete set null,
  slot text not null default 'rotate' check (slot in ('core','rotate','focus','wildcard')),
  position smallint not null default 0,
  description text,
  why_text text,
  novelty_score numeric(4,3),
  created_at timestamptz not null default now()
);
create index edition_items_edition_idx on public.edition_items(edition_id, position);
create index edition_items_user_topic_idx on public.edition_items(user_id, topic_id);
create index edition_items_article_idx on public.edition_items(article_id);
create index edition_items_topic_idx on public.edition_items(topic_id);

create table public.edition_item_discos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  edition_item_id uuid not null references public.edition_items(id) on delete cascade,
  disco_id uuid not null references public.discos(id) on delete cascade,
  rank smallint not null default 0,
  score numeric(5,4),
  unique (edition_item_id, disco_id)
);
create index edition_item_discos_disco_idx on public.edition_item_discos(disco_id);
create index edition_item_discos_user_idx on public.edition_item_discos(user_id);

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  edition_item_id uuid references public.edition_items(id) on delete set null,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, article_id)
);
create index votes_article_idx on public.votes(article_id);
create index votes_item_idx on public.votes(edition_item_id);

create table public.saved_articles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  saved_at timestamptz not null default now(),
  unique (user_id, article_id)
);
create index saved_articles_article_idx on public.saved_articles(article_id);

create table public.feed_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event text not null check (event in ('open','expand_discos','show_more','doesnt_fit','hide','pause_suggested','pause_accepted')),
  edition_item_id uuid references public.edition_items(id) on delete set null,
  article_id uuid references public.articles(id) on delete set null,
  disco_id uuid references public.discos(id) on delete set null,
  topic_id uuid references public.topics(id) on delete set null,
  created_at timestamptz not null default now()
);
create index feed_events_user_time_idx on public.feed_events(user_id, created_at desc);
create index feed_events_item_idx on public.feed_events(edition_item_id);
create index feed_events_article_idx on public.feed_events(article_id);
create index feed_events_disco_idx on public.feed_events(disco_id);
create index feed_events_topic_idx on public.feed_events(topic_id);

create trigger discos_updated_at before update on public.discos for each row execute function public.set_updated_at();
create trigger votes_updated_at before update on public.votes for each row execute function public.set_updated_at();
