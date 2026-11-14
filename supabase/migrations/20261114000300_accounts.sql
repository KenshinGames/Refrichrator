-- アカウント(名前とパスワード)。メールアドレスは使わない。
-- 冷蔵庫は人ごと:食材・レシピは user_id で、設定などの kv は「u:<user_id>:」で始まるキーで分ける。
create table public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique, -- 比べるための名前(大文字小文字と空白を無視)
  pass_hash text not null,       -- PBKDF2-SHA256(塩つき)
  created_at timestamptz not null default now()
);

-- ログイン中の端末。トークンそのものは残さず、ハッシュだけを持つ
create table public.sessions (
  token_hash text primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on public.sessions (user_id);

alter table public.items add column user_id uuid references public.users (id) on delete cascade;
alter table public.recipes add column user_id uuid references public.users (id) on delete cascade;
drop index if exists public.items_have_idx;
create index items_have_idx on public.items (user_id, expires_on) where gone_at is null;
drop index if exists public.recipes_created_idx;
create index recipes_user_created_idx on public.recipes (user_id, created_at desc);
create index recipes_created_idx on public.recipes (created_at);

alter table public.users enable row level security;
alter table public.sessions enable row level security;
revoke all on public.users, public.sessions from anon, authenticated;
