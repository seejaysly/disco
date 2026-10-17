-- A video moment can carry one still frame (stored like an image, in the user's private folder).
do $$
declare d text := pg_get_functiondef('public.capture_disco(jsonb)'::regprocedure);
begin
  d := replace(d, $r$if v_kind = 'image' and jsonb_typeof(p->'image') = 'object' then$r$,
                  $r$if v_kind in ('image', 'video') and jsonb_typeof(p->'image') = 'object' and nullif(p->'image'->>'storage_path', '') is not null then$r$);
  if d not like $r$%v_kind in ('image', 'video')%$r$ then raise exception 'replace did not apply'; end if;
  execute d;
end $$;
