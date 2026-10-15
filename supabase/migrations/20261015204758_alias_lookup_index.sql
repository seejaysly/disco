create index if not exists topic_aliases_alias_lower_idx on public.topic_aliases(lower(alias));
