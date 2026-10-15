-- Extensions
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- updated_at helper
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- PEOPLE ------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'America/Los_Angeles',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'One row per Disco user; sign-in lives in auth.users.';

create table public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  articles_per_day smallint not null default 12 check (articles_per_day between 1 and 50),
  recency_days smallint not null default 14 check (recency_days between 1 and 365),
  wildcard_enabled boolean not null default true,
  edition_hour smallint not null default 6 check (edition_hour between 0 and 23),
  email_digest boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.user_settings is 'Per-user feed settings: daily volume, recency window, wild card, delivery hour, digest.';

-- TOPICS (shared catalog) -------------------------------------------
create table public.topics (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null,
  level smallint check (level between 1 and 3),
  parent_id uuid references public.topics(id) on delete set null,
  description text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index topics_parent_idx on public.topics(parent_id);
create index topics_label_trgm_idx on public.topics using gin (label extensions.gin_trgm_ops);
comment on table public.topics is 'Single shared topic list behind DIG, capture tags and feed sections (L1 > L2 > L3).';

create table public.topic_aliases (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics(id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now()
);
create unique index topic_aliases_alias_uidx on public.topic_aliases (lower(alias));
create index topic_aliases_topic_idx on public.topic_aliases(topic_id);
create index topic_aliases_trgm_idx on public.topic_aliases using gin (alias extensions.gin_trgm_ops);

create table public.topic_art (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null unique references public.topics(id) on delete cascade,
  image_path text not null,
  credit text,
  created_at timestamptz not null default now()
);

create table public.user_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  tier text not null default 'rotate' check (tier in ('core','rotate','focus','paused')),
  paused_until date,
  angles_prefer text[] not null default '{}',
  angles_avoid text[] not null default '{}',
  origin text not null default 'manual' check (origin in ('dig','coda','manual','promoted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, topic_id)
);
create index user_topics_topic_idx on public.user_topics(topic_id);
comment on column public.user_topics.paused_until is 'Optional resume date; null = paused until switched back.';

create table public.dig_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  dig_version text not null,
  submitted_at timestamptz not null default now(),
  answers jsonb not null default '{}',
  suggested_topic_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index dig_submissions_user_idx on public.dig_submissions(user_id);

-- SOURCES (shared catalog) ------------------------------------------
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'outlet' check (kind in ('outlet','book','video_channel','podcast','other')),
  name text not null,
  author text,
  domain text,
  homepage_url text,
  external_id text,
  coda_row_id text unique,
  created_at timestamptz not null default now()
);
create unique index sources_outlet_domain_uidx on public.sources (lower(domain)) where kind = 'outlet' and domain is not null;
create index sources_name_trgm_idx on public.sources using gin (name extensions.gin_trgm_ops);
comment on column public.sources.external_id is 'e.g. Kindle ASIN or YouTube channel id.';

create table public.user_source_prefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  preference text not null check (preference in ('subscribed','prefer','block')),
  created_at timestamptz not null default now(),
  unique (user_id, source_id)
);
create index user_source_prefs_source_idx on public.user_source_prefs(source_id);

-- ARTICLES (shared catalog) -----------------------------------------
create table public.articles (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  url_hash text generated always as (md5(url)) stored unique,
  headline text,
  source_id uuid references public.sources(id) on delete set null,
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  format text check (format in ('news','essay','explainer','research','interview','review','video','podcast','other')),
  depth_score numeric(4,2),
  access text check (access in ('free','metered','paywall')),
  story_cluster_id uuid,
  embedding extensions.vector(384),
  created_at timestamptz not null default now()
);
create index articles_source_idx on public.articles(source_id);
create index articles_cluster_idx on public.articles(story_cluster_id);
create index articles_embedding_idx on public.articles using hnsw (embedding extensions.vector_cosine_ops);
comment on table public.articles is 'Every article ever surfaced (dedup by url_hash); metadata computed once and shared.';

create table public.article_topics (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  sourced_on date not null default current_date,
  unique (article_id, topic_id, sourced_on)
);
create index article_topics_topic_day_idx on public.article_topics(topic_id, sourced_on);

-- updated_at triggers
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger user_settings_updated_at before update on public.user_settings for each row execute function public.set_updated_at();
create trigger user_topics_updated_at before update on public.user_topics for each row execute function public.set_updated_at();

-- New sign-up -> profile + default settings
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
  );
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
