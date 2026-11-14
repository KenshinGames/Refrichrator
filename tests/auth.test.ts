import { describe, expect, it } from 'vitest';
import { checkPassword, cleanName, deleteAccount, hashPassword, login, logout, signup, who } from '../supabase/functions/api/auth.ts';
import type { AuthDeps } from '../supabase/functions/api/auth.ts';
import { handle, LOCK, sha256 } from '../supabase/functions/api/core.ts';
import type { Deps } from '../supabase/functions/api/core.ts';
import { prompts } from '../supabase/functions/api/gemini.ts';
import { makeFakeAI, makeMemoryDb } from '../tools/memory.ts';

const NOW = new Date('2026-11-14T03:00:00Z');
async function setup(from = '10.0.0.1') {
  const db = makeMemoryDb();
  const auth: AuthDeps = { accounts: db.accounts, gates: { attempt: db.attempt }, inviteHash: await sha256('KenshinApps'), from, now: NOW, iterations: 1000 };
  return { db, auth };
}

describe('名前とパスワード', () => {
  it('名前は全角・半角や大文字小文字、空白のちがいを同じものとして比べる', () => {
    expect(cleanName('  Ｋｅｎ　 Shin ')).toEqual({ name: 'Ken Shin', key: 'kenshin' });
    expect(() => cleanName('')).toThrow('名前を入れてください');
    expect(() => cleanName('あ'.repeat(21))).toThrow('20文字まで');
  });
  it('パスワードは塩つきで保存し、同じパスワードでも毎回ちがう形になる', async () => {
    const a = await hashPassword('correct-horse', 1000);
    const b = await hashPassword('correct-horse', 1000);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct-horse');
    expect(await checkPassword('correct-horse', a)).toBe(true);
    expect(await checkPassword('correct-hors', a)).toBe(false);
    expect(await checkPassword('correct-horse', 'こわれた値')).toBe(false);
  });
});

describe('登録とログイン', () => {
  it('招待コードがあれば登録でき、そのままログイン中になる。同じ名前では登録できない', async () => {
    const { auth, db } = await setup();
    await expect(signup({ name: 'さくら', password: 'sakura-123', invite: 'ちがう' }, auth)).rejects.toMatchObject({ code: 'invite', status: 401 });
    await expect(signup({ name: 'さくら', password: 'short', invite: 'KenshinApps' }, auth)).rejects.toMatchObject({ code: 'password' });
    const r = await signup({ name: 'さくら', password: 'sakura-123', invite: 'KenshinApps' }, auth);
    expect(r.name).toBe('さくら');
    expect(await who(r.token, db.accounts)).toMatchObject({ name: 'さくら' });
    await expect(signup({ name: ' さくら ', password: 'other-pass-1', invite: 'KenshinApps' }, auth)).rejects.toMatchObject({ code: 'taken', status: 409 });
  });
  it('ログインは名前とパスワードで。まちがえたときは、名前とパスワードのどちらが違うかを言わない', async () => {
    const { auth, db } = await setup();
    await signup({ name: 'Taro', password: 'taro-pass-1', invite: 'KenshinApps' }, auth);
    const r = await login({ name: 'taro', password: 'taro-pass-1' }, auth);
    expect(await who(r.token, db.accounts)).toMatchObject({ name: 'Taro' });
    const wrongPw = await login({ name: 'taro', password: 'nope-nope' }, auth).catch((e) => e);
    const noUser = await login({ name: 'jiro', password: 'nope-nope' }, auth).catch((e) => e);
    expect(wrongPw.message).toBe(noUser.message);
    expect(wrongPw.status).toBe(401);
  });
  it(`ログインを${LOCK.tries}回まちがえたら、正しいパスワードでも止める`, async () => {
    const { auth } = await setup();
    await signup({ name: 'Taro', password: 'taro-pass-1', invite: 'KenshinApps' }, auth);
    for (let i = 0; i < LOCK.tries; i++) await expect(login({ name: 'taro', password: 'x' + i }, auth)).rejects.toMatchObject({ status: 401 });
    await expect(login({ name: 'taro', password: 'taro-pass-1' }, auth)).rejects.toMatchObject({ code: 'locked', status: 429 });
  });
  it(`接続元を変えても、全体で${LOCK.all}回まちがえたら止める`, async () => {
    const { auth } = await setup();
    await signup({ name: 'Taro', password: 'taro-pass-1', invite: 'KenshinApps' }, auth);
    for (let i = 0; i < LOCK.all; i++) await login({ name: 'taro', password: 'x' }, { ...auth, from: `10.1.0.${i}` }).catch(() => {});
    await expect(login({ name: 'taro', password: 'taro-pass-1' }, { ...auth, from: '10.9.9.9' })).rejects.toMatchObject({ code: 'locked' });
  });
  it('自分のアカウントで正しくログインしても、狙ったアカウントの回数は消えない', async () => {
    const { auth } = await setup();
    await signup({ name: 'Taro', password: 'taro-pass-1', invite: 'KenshinApps' }, auth);
    await signup({ name: 'Mallory', password: 'mallory-pass', invite: 'KenshinApps' }, { ...auth, from: '10.5.5.5' });
    // 2回まちがえるごとに自分で正しくログインして、接続元と全体の回数を0に戻しながら試し続けても
    for (let round = 0; round < LOCK.account / 2; round++) {
      for (let i = 0; i < 2; i++) await login({ name: 'taro', password: `guess-${round}-${i}` }, auth).catch(() => {});
      await login({ name: 'mallory', password: 'mallory-pass' }, auth).catch(() => {}); // 自分で正しくログイン
    }
    await expect(login({ name: 'taro', password: 'taro-pass-1' }, auth)).rejects.toMatchObject({ code: 'locked' });
  });
  it(`接続元を変えても、同じアカウントに${LOCK.account}回まちがえたら止める。ほかのアカウントは止めない`, async () => {
    const { auth } = await setup();
    await signup({ name: 'Taro', password: 'taro-pass-1', invite: 'KenshinApps' }, auth);
    await signup({ name: 'Hana', password: 'hana-pass-1', invite: 'KenshinApps' }, { ...auth, from: '10.6.6.6' });
    for (let i = 0; i < LOCK.account; i++) await login({ name: 'taro', password: 'x' }, { ...auth, from: `10.2.0.${i}` }).catch(() => {});
    await expect(login({ name: 'taro', password: 'taro-pass-1' }, { ...auth, from: '10.3.3.3' })).rejects.toMatchObject({ code: 'locked' });
    expect(await login({ name: 'hana', password: 'hana-pass-1' }, { ...auth, from: '10.4.4.4' })).toHaveProperty('token');
  });
  it('ログアウトすると、その端末のトークンは使えなくなる', async () => {
    const { auth, db } = await setup();
    const r = await signup({ name: 'Taro', password: 'taro-pass-1', invite: 'KenshinApps' }, auth);
    await logout(r.token, db.accounts);
    expect(await who(r.token, db.accounts)).toBeNull();
    expect(await who('でたらめ', db.accounts)).toBeNull();
    expect(await who(null, db.accounts)).toBeNull();
  });
});

describe('冷蔵庫は人ごと', () => {
  it('ほかの人の食材・レシピ・設定は見えず、さわれない', async () => {
    const { auth, db } = await setup();
    const a = await who((await signup({ name: 'A', password: 'aaaa-aaaa', invite: 'KenshinApps' }, auth)).token, db.accounts);
    const b = await who((await signup({ name: 'B', password: 'bbbb-bbbb', invite: 'KenshinApps' }, auth)).token, db.accounts);
    const ai = makeFakeAI();
    const as: Deps = { store: db.forUser(a!.id), ai, prompts, now: () => NOW };
    const bs: Deps = { store: db.forUser(b!.id), ai, prompts, now: () => NOW };
    const added: any = await handle('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] }, as);
    await handle('settings', { settings: { servings: 3, dislikes: 'えび' } }, as);
    const { recipes }: any = await handle('suggest', { scene: 'tired' }, as);
    const bSync: any = await handle('sync', {}, bs);
    expect(bSync.items).toEqual([]);
    expect(bSync.settings).toEqual({ servings: 1, dislikes: '' });
    expect(bSync.staples).toEqual([]);
    // B が A の食材 ID やレシピ ID を知っていても、さわれない
    await handle('remove', { ids: [added.items[0].id] }, bs);
    await handle('update', { id: added.items[0].id, days: 0 }, bs);
    expect(((await handle('sync', {}, as)) as any).items[0]).toMatchObject({ name: '卵', expiresOn: '2026-11-28' });
    await expect(handle('image', { id: recipes[0].id }, bs)).rejects.toMatchObject({ status: 404 });
  });
  it('写真は1人の上限と、全員の合計の上限の両方で止まる', async () => {
    const { auth, db } = await setup();
    const ai = makeFakeAI();
    const limits = { images: 2, allImages: 3, texts: 100 };
    const people = [];
    for (const n of ['A', 'B']) {
      const u = await who((await signup({ name: n, password: 'pass-pass', invite: 'KenshinApps' }, auth)).token, db.accounts);
      const d: Deps = { store: db.forUser(u!.id), ai, prompts, now: () => NOW, limits };
      await handle('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] }, d);
      people.push({ d, recipes: ((await handle('suggest', { scene: 'tired' }, d)) as any).recipes });
    }
    const [A, B] = people;
    expect(await handle('image', { id: A.recipes[0].id }, A.d)).toHaveProperty('url');
    expect(await handle('image', { id: A.recipes[1].id }, A.d)).toHaveProperty('url');
    expect(await handle('image', { id: A.recipes[2].id }, A.d)).toEqual({ capped: true }); // 1人の上限
    expect(await handle('image', { id: B.recipes[0].id }, B.d)).toHaveProperty('url');
    expect(await handle('image', { id: B.recipes[1].id }, B.d)).toEqual({ capped: true }); // 全員の合計の上限
  });
  it('アカウントを消すと、その人のデータもすべて消え、ログインできなくなる', async () => {
    const { auth, db } = await setup();
    const r = await signup({ name: 'A', password: 'aaaa-aaaa', invite: 'KenshinApps' }, auth);
    const user = (await who(r.token, db.accounts))!;
    const store = db.forUser(user.id);
    await handle('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] }, { store, ai: makeFakeAI(), prompts, now: () => NOW });
    await expect(deleteAccount({ password: 'ちがう' }, user, { ...auth, store })).rejects.toMatchObject({ status: 401 });
    await deleteAccount({ password: 'aaaa-aaaa' }, user, { ...auth, store });
    expect(await who(r.token, db.accounts)).toBeNull();
    expect(await store.listItems()).toEqual([]);
    expect([...db.kv.keys()].filter((k) => k.startsWith(`u:${user.id}:`))).toEqual([]);
    await expect(login({ name: 'A', password: 'aaaa-aaaa' }, auth)).rejects.toMatchObject({ status: 401 });
  });
});
