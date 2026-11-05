-- 在 Supabase → SQL Editor 貼上整段執行一次即可
create table if not exists public.albums (
  user_id    uuid    not null default auth.uid() references auth.users on delete cascade,
  key        text    not null,
  data       jsonb   not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at bigint  not null,
  primary key (user_id, key)
);

alter table public.albums enable row level security;

-- 每個人只能讀寫自己的資料
drop policy if exists "own rows" on public.albums;
create policy "own rows" on public.albums
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
