// テストと手元の確認で使う、メモリ上の保存先と、にせものの AI。
import { readFileSync } from 'node:fs';
import type { Account, Accounts } from '../supabase/functions/api/auth.ts';
import type { AI, Item, Part, Recipe, Store } from '../supabase/functions/api/core.ts';

type Owned<T> = T & { owner: string; gone?: boolean };

/** メモリ上のデータベース。人ごとの保存先(forUser)と、アカウントを持つ */
export function makeMemoryDb() {
  const users: Account[] = [];
  const userKeys = new Map<string, string>(); // name_key → id
  const sessions = new Map<string, string>(); // token_hash → user id
  const items: Owned<Item>[] = [];
  const recipes: Owned<Recipe>[] = [];
  const kv = new Map<string, unknown>();
  const gates = new Map<string, { count: number; since: number }>();
  let seq = 0;
  const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const strip = <T,>({ owner: _o, gone: _g, ...rest }: Owned<T>) => rest as unknown as T;

  async function attempt(key: string, wrong: boolean, tries: number, windowSeconds: number, now: Date) {
    // 読んでから書くまでに await をはさまないので、同時に呼ばれても数えもれしない
    const t = now.getTime();
    const r = gates.get(key) ?? { count: 0, since: t };
    const live = r.count > 0 && t - r.since < windowSeconds * 1000;
    if (live && r.count >= tries) return true;
    // 本番のデータベースの関数(gate_attempt)と同じ動き:まちがえたら1増やし、合っていたら0に戻す
    if (wrong) gates.set(key, live ? { count: r.count + 1, since: r.since } : { count: 1, since: t });
    else if (r.count > 0) gates.set(key, { count: 0, since: t });
    return false;
  }
  const imagesSince = (sinceIso: string, owner?: string) =>
    recipes.filter((r) => r.imageUrl && (!owner || r.owner === owner) && r.createdAt >= new Date(sinceIso).toISOString()).length;

  const accounts: Accounts = {
    async find(nameKey) {
      const uid = userKeys.get(nameKey);
      return uid ? { ...users.find((u) => u.id === uid)! } : null;
    },
    async findById(uid) {
      const u = users.find((x) => x.id === uid);
      return u ? { ...u } : null;
    },
    async create(name, nameKey, passHash) {
      if (userKeys.has(nameKey)) return null;
      const uid = id();
      users.push({ id: uid, name, passHash });
      userKeys.set(nameKey, uid);
      return uid;
    },
    async addSession(tokenHash, uid) {
      sessions.set(tokenHash, uid);
    },
    async session(tokenHash) {
      const uid = sessions.get(tokenHash);
      const u = uid && users.find((x) => x.id === uid);
      return u ? { id: u.id, name: u.name } : null;
    },
    async dropSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async remove(uid) {
      const i = users.findIndex((u) => u.id === uid);
      if (i >= 0) users.splice(i, 1);
      for (const [k, v] of userKeys) if (v === uid) userKeys.delete(k);
      for (const [k, v] of sessions) if (v === uid) sessions.delete(k);
    },
  };

  function forUser(owner: string): Store & { dump(): { items: Owned<Item>[]; recipes: Owned<Recipe>[]; kv: Map<string, unknown> } } {
    const p = `u:${owner}:`;
    const mine = <T extends { owner: string }>(list: T[]) => list.filter((x) => x.owner === owner);
    return {
      dump: () => ({ items: mine(items), recipes: mine(recipes), kv }),
      async listItems() {
        return mine(items)
          .filter((i) => !i.gone)
          .map((i) => strip<Item>(i))
          .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.name.localeCompare(b.name, 'ja'));
      },
      async addItems(rows) {
        for (const r of rows) items.push({ ...r, id: r.id ?? id(), owner });
      },
      async updateItem(itemId, patch) {
        const it = mine(items).find((i) => i.id === itemId);
        if (it) Object.assign(it, patch);
      },
      async removeItems(ids) {
        for (const it of mine(items)) if (ids.includes(it.id)) it.gone = true;
      },
      async getKv<T>(key: string) {
        return (kv.has(p + key) ? structuredClone(kv.get(p + key)) : null) as T | null;
      },
      async setKv(key, value) {
        kv.set(p + key, structuredClone(value));
      },
      async saveRecipes(rows) {
        const saved = rows.map((r) => ({ ...r, id: id(), imageUrl: null, cookedAt: null, createdAt: new Date().toISOString(), owner }));
        recipes.push(...saved);
        return saved.map((r) => strip<Recipe>(r));
      },
      async getRecipe(recipeId) {
        const r = mine(recipes).find((x) => x.id === recipeId);
        return r ? strip<Recipe>(r) : null;
      },
      async updateRecipe(recipeId, patch) {
        const r = mine(recipes).find((x) => x.id === recipeId);
        if (r) Object.assign(r, patch);
      },
      async recentRecipes(limit) {
        return mine(recipes).slice(-limit).reverse().map((r) => strip<Recipe>(r));
      },
      attempt,
      async countImages(sinceIso) {
        return imagesSince(sinceIso, owner);
      },
      async countAllImages(sinceIso) {
        return imagesSince(sinceIso);
      },
      async uploadImage(_path, bytes, mime) {
        return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
      },
      async wipe() {
        for (let i = items.length - 1; i >= 0; i--) if (items[i].owner === owner) items.splice(i, 1);
        for (let i = recipes.length - 1; i >= 0; i--) if (recipes[i].owner === owner) recipes.splice(i, 1);
        for (const k of [...kv.keys()]) if (k.startsWith(p)) kv.delete(k);
      },
    };
  }

  return { accounts, forUser, attempt, kv };
}

/** 1人分の保存先(処理の本体のテスト用) */
export function makeMemoryStore() {
  return makeMemoryDb().forUser('00000000-0000-4000-8000-0000000000aa');
}

const KNOWN: [string, string, number][] = [
  ['豚こま肉', '肉', 3], ['鶏もも肉', '肉', 2], ['ひき肉', '肉', 2], ['鮭', '魚介', 2], ['小松菜', '野菜', 4], ['キャベツ', '野菜', 10],
  ['玉ねぎ', '野菜', 30], ['にんじん', '野菜', 14], ['トマト', '野菜', 6], ['もやし', '野菜', 2], ['卵', '卵・乳製品', 14],
  ['牛乳', '卵・乳製品', 7], ['絹豆腐', '大豆製品', 5], ['納豆', '大豆製品', 7], ['うどん', '主食', 5], ['ヨーグルト', '卵・乳製品', 10],
];

/** にせものの AI。指示文に出てくる食材名から、それらしい答えを返す */
export function makeFakeAI(opt: { delay?: number; fail?: () => boolean } = {}): AI & { calls: { kind: string; text: string }[] } {
  const wait = () => new Promise((r) => setTimeout(r, opt.delay ?? 0));
  const calls: { kind: string; text: string }[] = [];
  const dish = readFileSync(new URL('./fixtures/dish.jpg', import.meta.url));
  return {
    calls,
    async json(parts: Part[], schema: unknown) {
      await wait();
      if (opt.fail?.()) throw new Error('fake ai failure');
      const text = parts.map((p) => ('text' in p ? p.text : '')).join('\n');
      const hasImage = parts.some((p) => 'inlineData' in p);
      const props = (schema as { properties: Record<string, unknown> }).properties;
      if ('items' in props) {
        calls.push({ kind: hasImage ? 'parseImage' : 'parseText', text });
        const memo = hasImage ? '豚こま肉 小松菜 卵 牛乳 絹豆腐' : (text.split('メモ:')[1] ?? '');
        const found = KNOWN.filter(([n]) => memo.includes(n) || memo.includes(n.replace(/肉$/, '')));
        return { items: found.map(([name, category, days]) => ({ name, category, days })) };
      }
      const fridge = [...text.matchAll(/^- (.+?)[((](?:あと|今日|期限)/gm)].map((m) => m[1]);
      if ('ideas' in props) {
        calls.push({ kind: 'shopping', text });
        return {
          ideas: [
            { buy: '長ねぎ', dish: '豚こまの麻婆豆腐', uses: fridge.slice(0, 2), minutes: 15 },
            { buy: '焼きそば麺', dish: '野菜たっぷり焼きそば', uses: fridge.slice(0, 2), minutes: 12 },
            { buy: 'カレールー', dish: '時短ポークカレー', uses: fridge.slice(0, 3), minutes: 25 },
            { buy: 'しめじ', dish: 'きのこと卵のとろみ炒め', uses: fridge.slice(1, 3), minutes: 10 },
          ],
        };
      }
      calls.push({ kind: 'suggest', text });
      const one = text.match(/「([^「」]+)」のレシピを1品だけ/);
      const a = fridge[0] ?? '卵';
      const b = fridge[1] ?? '玉ねぎ';
      const c = fridge[2] ?? '牛乳';
      const mk = (title: string, lead: string, minutes: number, main: string[], buy?: string) => ({
        title,
        lead,
        minutes,
        ingredients: [
          ...main.map((name) => ({ name, amount: '適量', source: 'fridge' })),
          { name: '醤油', amount: '大さじ1', source: 'pantry' },
          { name: 'ごま油', amount: '小さじ2', source: 'pantry' },
          ...(buy ? [{ name: buy, amount: '1本', source: 'buy' }] : []),
        ],
        steps: [`${main[0]}を食べやすい大きさに切る`, 'フライパンにごま油を中火で熱し、2分炒める', '残りの材料を加えて3分炒める', '醤油を回しかけて、全体にからめる'],
        tip: '強めの火で手早く仕上げると水っぽくなりません',
      });
      if (one) {
        const buy = text.match(/「([^「」]+)」は買い足す前提/)?.[1];
        return { dishes: [mk(one[1], '買い足して作るごちそう', 20, [a, b], buy)] };
      }
      return {
        dishes: [
          mk(`${a}と${b}の香ばし炒め`, 'フライパンひとつで、ごはんが進む', 12, [a, b]),
          mk(`${c}のやさしいスープ`, '疲れた体にしみる、まろやかな一杯', 10, [c, b]),
          mk(`${a}のねぎ塩だれ`, 'さっぱり食べたい夜に', 15, [a], '長ねぎ'),
        ],
      };
    },
    async image() {
      await wait();
      calls.push({ kind: 'image', text: '' });
      return { bytes: new Uint8Array(dish), mime: 'image/jpeg' };
    },
  };
}
