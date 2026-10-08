-- Apply to your own Supabase project. Never bundle a service_role key with the app.
create table if not exists public.konh_records (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('tasks','labels','journals','sessions','completions')),
  record_id text not null,
  data jsonb not null,
  primary key (user_id, kind, record_id),
  check (jsonb_typeof(data) = 'object' and data->>'id' = record_id and jsonb_typeof(data->'updatedAt') = 'number')
);
alter table public.konh_records enable row level security;
create policy konh_owner_select on public.konh_records for select to authenticated using (auth.uid() = user_id);
create policy konh_owner_insert on public.konh_records for insert to authenticated with check (auth.uid() = user_id);
create policy konh_owner_update on public.konh_records for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- Deletion is represented by a timestamp tombstone, retained to avoid offline resurrection.
revoke all on public.konh_records from anon;
grant select, insert, update on public.konh_records to authenticated;
-- A locale-independent representation shared with the client for same-millisecond conflicts.
create or replace function public.konh_canonical(value jsonb) returns text
language plpgsql immutable strict set search_path = '' as $$
declare result text;
begin
  case jsonb_typeof(value)
    when 'object' then
      select '{' || coalesce(string_agg(to_json(key)::text || ':' || public.konh_canonical(val), ',' order by key collate "C"), '') || '}' into result from jsonb_each(value) as entries(key, val);
    when 'array' then
      select '[' || coalesce(string_agg(public.konh_canonical(val), ',' order by pos), '') || ']' into result from jsonb_array_elements(value) with ordinality as entries(val, pos);
    else result := value::text;
  end case;
  return result;
end;
$$;
create or replace function public.konh_merge_records(incoming jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(incoming) <> 'array' or jsonb_array_length(incoming) > 100 then raise exception 'Invalid batch'; end if;
  insert into public.konh_records(user_id, kind, record_id, data)
    select auth.uid(), item->>'kind', item->>'record_id', item->'data' from jsonb_array_elements(incoming) item
  on conflict(user_id, kind, record_id) do update set data = excluded.data
    where (excluded.data->>'updatedAt')::numeric > (konh_records.data->>'updatedAt')::numeric
    or ((excluded.data->>'updatedAt')::numeric = (konh_records.data->>'updatedAt')::numeric and public.konh_canonical(excluded.data) collate "C" > public.konh_canonical(konh_records.data) collate "C");
end;
$$;
revoke all on function public.konh_merge_records(jsonb) from public, anon;
grant execute on function public.konh_merge_records(jsonb) to authenticated;
