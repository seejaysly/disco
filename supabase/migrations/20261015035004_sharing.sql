create table public.guides (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('topic','source')),
  topic_id uuid references public.topics(id) on delete cascade,
  source_id uuid references public.sources(id) on delete cascade,
  title text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'topic' and topic_id is not null) or (kind = 'source' and source_id is not null))
);
create unique index guides_owner_topic_uidx on public.guides(owner_id, topic_id) where topic_id is not null;
create unique index guides_owner_source_uidx on public.guides(owner_id, source_id) where source_id is not null;
create index guides_topic_idx on public.guides(topic_id);
create index guides_source_idx on public.guides(source_id);

create table public.guide_members (
  id uuid primary key default gen_random_uuid(),
  guide_id uuid not null references public.guides(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'viewer' check (role in ('owner','editor','viewer')),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (guide_id, user_id)
);
create index guide_members_user_idx on public.guide_members(user_id);
create index guide_members_invited_by_idx on public.guide_members(invited_by);

create table public.guide_items (
  id uuid primary key default gen_random_uuid(),
  guide_id uuid not null references public.guides(id) on delete cascade,
  disco_id uuid references public.discos(id) on delete cascade,
  header_text text,
  note text,
  rank double precision not null default 0,
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (disco_id is not null or header_text is not null)
);
create index guide_items_guide_rank_idx on public.guide_items(guide_id, rank);
create index guide_items_disco_idx on public.guide_items(disco_id);
create index guide_items_added_by_idx on public.guide_items(added_by);
comment on column public.guide_items.rank is 'Fractional ordering: insert between two items without renumbering.';

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index connections_addressee_idx on public.connections(addressee_id);

create table public.shares (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  to_user_id uuid not null references public.profiles(id) on delete cascade,
  disco_id uuid references public.discos(id) on delete cascade,
  guide_id uuid references public.guides(id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  check ((disco_id is not null)::int + (guide_id is not null)::int = 1)
);
create index shares_to_idx on public.shares(to_user_id);
create index shares_from_idx on public.shares(from_user_id);
create index shares_disco_idx on public.shares(disco_id);
create index shares_guide_idx on public.shares(guide_id);

create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  disco_id uuid not null references public.discos(id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  channel text not null default 'copy' check (channel in ('email','text','copy')),
  revoked_at timestamptz,
  views int not null default 0,
  signups int not null default 0,
  created_at timestamptz not null default now()
);
create index share_links_disco_idx on public.share_links(disco_id);
create index share_links_creator_idx on public.share_links(created_by);

create table public.disco_saves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  disco_id uuid not null references public.discos(id) on delete cascade,
  share_id uuid references public.shares(id) on delete set null,
  saved_at timestamptz not null default now(),
  unique (user_id, disco_id)
);
create index disco_saves_disco_idx on public.disco_saves(disco_id);
create index disco_saves_share_idx on public.disco_saves(share_id);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('disco','guide','guide_item')),
  target_id uuid not null,
  parent_id uuid references public.comments(id) on delete cascade,
  body text not null,
  edited_at timestamptz,
  created_at timestamptz not null default now()
);
create index comments_target_idx on public.comments(target_type, target_id, created_at);
create index comments_parent_idx on public.comments(parent_id);
create index comments_user_idx on public.comments(user_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  kind text not null,
  target_type text,
  target_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_unread_idx on public.notifications(user_id, created_at desc) where read_at is null;
create index notifications_actor_idx on public.notifications(actor_id);

create trigger guides_updated_at before update on public.guides for each row execute function public.set_updated_at();
create trigger guide_items_updated_at before update on public.guide_items for each row execute function public.set_updated_at();
create trigger connections_updated_at before update on public.connections for each row execute function public.set_updated_at();

-- A new guide automatically lists its owner as a member
create or replace function public.add_guide_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.guide_members (guide_id, user_id, role, invited_by)
  values (new.id, new.owner_id, 'owner', new.owner_id)
  on conflict (guide_id, user_id) do nothing;
  return new;
end;
$$;
create trigger guides_add_owner after insert on public.guides
  for each row execute function public.add_guide_owner();
