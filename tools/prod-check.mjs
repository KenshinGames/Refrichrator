// 公開した中継サーバーを確かめる。確認用の一時アカウントを作り、最後に消す。
//   node tools/prod-check.mjs        登録・ログイン・人ごとの分離・削除まで(お金はかからない)
//   node tools/prod-check.mjs full   読み取り・提案・写真1枚・買い物も(数円かかる)
import { readFileSync } from 'node:fs';
const URL_ = 'https://vphcejuxczbttkuzqnlv.supabase.co/functions/v1/api';
const invite = readFileSync(new URL('../.env.local', import.meta.url), 'utf8').match(/REFRICHERATOR_INVITE=(.+)/)[1].trim();
const full = process.argv[2] === 'full';
const call = async (action, body = {}, token = '') => {
  const t = Date.now();
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session': token }, body: JSON.stringify({ action, ...body }) });
  const j = await r.json().catch(() => ({}));
  console.log(`${action} → ${r.status} ${Date.now() - t}ms`);
  return { status: r.status, j };
};
const ok = (cond, msg) => {
  if (!cond) {
    console.error('NG: ' + msg);
    process.exitCode = 1;
  } else console.log('  ok: ' + msg);
};
const tag = Math.random().toString(36).slice(2, 8);
const A = { name: `確認用A-${tag}`, password: `check-${tag}-a1` };
const B = { name: `確認用B-${tag}`, password: `check-${tag}-b1` };

let r = await call('ping');
ok(r.status === 200, `ping(接続元: ${r.j.from})`);
r = await call('sync');
ok(r.status === 401 && r.j.error?.code === 'session', 'ログインしていないと使えない');
r = await call('signup', { ...A, invite: 'ちがう招待コード' });
ok(r.status === 401 && r.j.error?.code === 'invite', '招待コードが違うと登録できない');
r = await call('signup', { ...A, invite });
ok(r.status === 200 && r.j.token, `${A.name} を登録した`);
let ta = r.j.token;
r = await call('signup', { ...B, invite });
const tb = r.j.token;
ok(r.status === 200 && tb, `${B.name} を登録した`);
r = await call('signup', { ...A, invite });
ok(r.status === 409, '同じ名前では登録できない');

r = await call('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] }, ta);
ok(r.j.items?.length === 1, 'A の冷蔵庫に卵を入れた');
r = await call('sync', {}, tb);
ok(r.j.items?.length === 0, 'B の冷蔵庫には出てこない');
await call('remove', { ids: [(await call('sync', {}, ta)).j.items[0].id] }, tb);
ok((await call('sync', {}, ta)).j.items.length === 1, 'B は A の卵を消せない');

await call('logout', {}, ta);
ok((await call('sync', {}, ta)).status === 401, 'ログアウトしたトークンは使えない');
r = await call('login', { name: A.name, password: 'ちがうパスワード' });
ok(r.status === 401, 'パスワードが違うとログインできない');
r = await call('login', A);
ta = r.j.token;
ok(r.status === 200 && (await call('sync', {}, ta)).j.items.length === 1, 'ログインし直すと、卵が残っている');

if (full) {
  r = await call('parse', { text: '豚こまと小松菜を買った' }, ta);
  ok(r.j.items?.length === 2, '文章から読み取る: ' + r.j.items?.map((i) => i.name).join(' '));
  await call('add', { items: r.j.items }, ta);
  r = await call('suggest', { scene: 'tired' }, ta);
  ok(r.j.recipes?.length === 3, '3品の提案: ' + r.j.recipes?.map((x) => x.title).join(' / '));
  const rec = r.j.recipes[0];
  r = await call('image', { id: rec.id }, ta);
  ok(/^https:\/\/.+\/dishes\//.test(r.j.url ?? ''), '写真を作った');
  ok((await call('image', { id: rec.id }, tb)).status === 404, 'B は A のレシピの写真を作れない');
  r = await call('shopping', {}, ta);
  ok(r.j.ideas?.length >= 3, '買い物の案: ' + r.j.ideas?.map((i) => `${i.buy}→${i.dish}`).join(' / '));
}

r = await call('delete_account', { password: A.password }, ta);
ok(r.status === 200, `${A.name} を削除した`);
r = await call('delete_account', { password: B.password }, tb);
ok(r.status === 200, `${B.name} を削除した`);
ok((await call('login', A)).status === 401, '削除したアカウントではログインできない');
