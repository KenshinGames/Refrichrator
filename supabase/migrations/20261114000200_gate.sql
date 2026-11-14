-- 合言葉の当て推量を止めるための記録。
-- 接続元ごとに、まちがえた回数と数え始めた時刻を持つ(接続元はハッシュにして、IP アドレスそのものは残さない)。
create table public.gate (
  key text primary key,
  count int not null default 0,
  since timestamptz not null default now()
);
alter table public.gate enable row level security;
revoke all on public.gate from anon, authenticated;

-- 1回の試行を記録して、止めている最中かどうかを返す。
-- 行をロックしてから数えるので、同時にたくさん送られても数えもれしない。
--   p_wrong = true  : まちがえた。回数を1増やす(数え始めから p_window_seconds を過ぎていたら1からやり直す)
--   p_wrong = false : 合っていた。回数を0に戻す
-- すでに p_tries 回まちがえていて、まだ時間内なら、何もせずに true(止めている)を返す。
create or replace function public.gate_attempt(p_key text, p_wrong boolean, p_tries int, p_window_seconds int)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  r public.gate%rowtype;
  live boolean;
begin
  insert into public.gate (key, count, since) values (p_key, 0, now()) on conflict (key) do nothing;
  select * into r from public.gate where key = p_key for update;
  live := r.count > 0 and r.since > now() - make_interval(secs => p_window_seconds);
  if live and r.count >= p_tries then
    return true;
  end if;
  if p_wrong then
    if live then
      update public.gate set count = r.count + 1 where key = p_key;
    else
      update public.gate set count = 1, since = now() where key = p_key;
    end if;
  elsif r.count > 0 then
    update public.gate set count = 0, since = now() where key = p_key;
  end if;
  return false;
end;
$$;

revoke execute on function public.gate_attempt(text, boolean, int, int) from public, anon, authenticated;
grant execute on function public.gate_attempt(text, boolean, int, int) to service_role;
