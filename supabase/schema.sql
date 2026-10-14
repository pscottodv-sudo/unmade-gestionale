-- =====================================================================
-- UNMADE. — gestionale di produzione · struttura del database Supabase
-- Da incollare UNA VOLTA in Supabase → SQL Editor → New query → Run.
-- Si può rieseguire senza danni: non cancella dati.
-- =====================================================================

-- ---------- 1. Profili utente: username e ruolo ----------
-- ruoli: admin (tu), editor (crea e modifica), viewer (solo consultazione)
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  role       text not null default 'editor' check (role in ('admin','editor','viewer')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- ruolo dell'utente collegato (null se non ha un profilo)
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;

-- crea il profilo di un utente: username = parte dell'email prima della @
-- (o il campo "username" nei metadati), il primo utente in assoluto diventa admin
create or replace function public.create_profile(p_uid uuid, p_email text, p_meta jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare base text; uname text; n int := 1;
begin
  if exists (select 1 from public.profiles where user_id = p_uid) then return; end if;
  base := lower(regexp_replace(coalesce(p_meta->>'username', split_part(p_email, '@', 1), ''), '[^a-zA-Z0-9._-]', '', 'g'));
  if base = '' then base := 'utente'; end if;
  uname := base;
  while exists (select 1 from public.profiles where username = uname) loop
    n := n + 1; uname := base || n;
  end loop;
  insert into public.profiles (user_id, username, role)
  values (p_uid, uname, case when exists (select 1 from public.profiles) then 'editor' else 'admin' end);
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.create_profile(new.id, new.email, new.raw_user_meta_data);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- profili per gli utenti creati prima di questo script
do $$ declare r record; begin
  for r in select id, email, raw_user_meta_data from auth.users order by created_at loop
    perform public.create_profile(r.id, r.email, r.raw_user_meta_data);
  end loop;
end $$;

-- chi è collegato vede gli username del team; solo l'admin cambia ruoli e nomi
drop policy if exists "profili: lettura" on public.profiles;
create policy "profili: lettura" on public.profiles
  for select to authenticated using (public.my_role() is not null);
drop policy if exists "profili: modifica admin" on public.profiles;
create policy "profili: modifica admin" on public.profiles
  for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
grant select, update on public.profiles to authenticated;

-- login con username: restituisce l'email collegata all'username
create or replace function public.login_email(p_username text) returns text
language sql stable security definer set search_path = public, auth as $$
  select u.email from auth.users u
  join public.profiles p on p.user_id = u.id
  where p.username = lower(trim(p_username))
$$;
revoke all on function public.login_email(text) from public;
grant execute on function public.login_email(text) to anon, authenticated;

-- ---------- 2. Dati del gestionale ----------
-- un documento JSON per ogni progetto, persona, camera, lente, accessorio, evento
create table if not exists public.docs (
  coll       text not null check (coll in ('projects','team','cameras','lenses','accessories','events')),
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (coll, id)
);
alter table public.docs enable row level security;

drop policy if exists "docs: lettura" on public.docs;
create policy "docs: lettura" on public.docs
  for select to authenticated using (public.my_role() is not null);
drop policy if exists "docs: inserimento" on public.docs;
create policy "docs: inserimento" on public.docs
  for insert to authenticated with check (public.my_role() in ('admin','editor'));
drop policy if exists "docs: modifica" on public.docs;
create policy "docs: modifica" on public.docs
  for update to authenticated using (public.my_role() in ('admin','editor')) with check (public.my_role() in ('admin','editor'));
drop policy if exists "docs: eliminazione" on public.docs;
create policy "docs: eliminazione" on public.docs
  for delete to authenticated using (public.my_role() in ('admin','editor'));
grant select, insert, update, delete on public.docs to authenticated;

-- unione profonda di due JSON (serve per aggiornare un solo call sheet senza toccare gli altri)
create or replace function public.jsonb_merge_deep(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; v jsonb; res jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then return b; end if;
  res := a;
  for k, v in select * from jsonb_each(b) loop
    res := jsonb_set(res, array[k], public.jsonb_merge_deep(res -> k, v), true);
  end loop;
  return res;
end $$;

-- aggiorna solo i campi indicati di un documento; rispetta le regole di sicurezza
create or replace function public.doc_update(p_coll text, p_id text, p_patch jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  update public.docs
     set data = public.jsonb_merge_deep(data, p_patch), updated_at = now(), updated_by = auth.uid()
   where coll = p_coll and id = p_id
  returning data into r;
  if r is null then raise exception 'documento non trovato o non modificabile' using errcode = 'P0002'; end if;
  return r;
end $$;
revoke all on function public.doc_update(text, text, jsonb) from public;
grant execute on function public.doc_update(text, text, jsonb) to authenticated;

-- aggiornamenti in tempo reale per tutti
do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;

-- ---------- 3. Immagini (moodboard e foto del team), archivio privato ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 20971520, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists "media: lettura" on storage.objects;
create policy "media: lettura" on storage.objects
  for select to authenticated using (bucket_id = 'media' and public.my_role() is not null);
drop policy if exists "media: caricamento" on storage.objects;
create policy "media: caricamento" on storage.objects
  for insert to authenticated with check (bucket_id = 'media' and public.my_role() in ('admin','editor'));
drop policy if exists "media: eliminazione" on storage.objects;
create policy "media: eliminazione" on storage.objects
  for delete to authenticated using (bucket_id = 'media' and public.my_role() in ('admin','editor'));
