-- 正しく入れても、まちがえた回数を0に戻さない(時間がたつと自然に戻る)。
-- 戻してしまうと、自分のアカウントで正しくログインするたびに回数が消え、
-- ほかの人のパスワードを当て推量し続けられるため。
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
  end if;
  return false;
end;
$$;
