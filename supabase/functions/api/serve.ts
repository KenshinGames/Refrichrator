// 中継サーバーの入口の中身。ログインを確かめ、その人の冷蔵庫(Postgres・Storage)と Gemini を core につなぐ。
import { createClient } from 'npm:@supabase/supabase-js@2';
import { deleteAccount, login, logout, signup, who } from './auth.ts';
import type { Accounts } from './auth.ts';
import { AppError, handle } from './core.ts';
import type { Item, NewRecipe, Recipe, Store } from './core.ts';
import { makeGemini, prompts } from './gemini.ts';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-session',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) {
    console.error('db error', res.error.message);
    throw new AppError('db', '保存先とのやりとりに失敗しました。もう一度お試しください。', 500);
  }
  return res.data;
}

const toItem = (r: any): Item => ({ id: r.id, name: r.name, category: r.category, addedOn: r.added_on, expiresOn: r.expires_on });
const toRecipe = (r: any): Recipe => ({
  id: r.id,
  scene: r.scene,
  title: r.title,
  lead: r.lead,
  minutes: r.minutes,
  servings: r.servings,
  ingredients: r.ingredients,
  steps: r.steps,
  tip: r.tip,
  imageUrl: r.image_url,
  cookedAt: r.cooked_at,
  createdAt: r.created_at,
});

async function countSince(sinceIso: string, userId?: string): Promise<number> {
  let q = sb.from('recipes').select('id', { count: 'exact', head: true }).not('image_url', 'is', null).gte('created_at', sinceIso);
  if (userId) q = q.eq('user_id', userId);
  const res = await q;
  if (res.error) {
    console.error('db error', res.error.message);
    throw new AppError('db', '保存先とのやりとりに失敗しました。もう一度お試しください。', 500);
  }
  return res.count ?? 0;
}

/** 全員で共有するもの:秘密の値、当て推量の記録 */
const root = {
  async getKv<T>(key: string): Promise<T | null> {
    const row = must(await sb.from('kv').select('value').eq('key', key).maybeSingle());
    return row ? ((row as any).value as T) : null;
  },
  async attempt(key: string, wrong: boolean, tries: number, windowSeconds: number): Promise<boolean> {
    const res = await sb.rpc('gate_attempt', { p_key: key, p_wrong: wrong, p_tries: tries, p_window_seconds: windowSeconds });
    if (res.error) {
      console.error('gate error', res.error.message);
      throw new AppError('db', '保存先とのやりとりに失敗しました。もう一度お試しください。', 500);
    }
    return res.data === true;
  },
};

/** その人の冷蔵庫。どの読み書きも、その人の行だけに絞る */
function storeFor(userId: string): Store {
  const p = `u:${userId}:`; // 設定などの kv は、この印で人ごとに分ける
  return {
    async listItems() {
      return must(await sb.from('items').select('*').eq('user_id', userId).is('gone_at', null).order('expires_on').order('name')).map(toItem);
    },
    async addItems(rows) {
      must(
        await sb
          .from('items')
          .insert(rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), user_id: userId, name: r.name, category: r.category, added_on: r.addedOn, expires_on: r.expiresOn }))),
      );
    },
    async updateItem(id, patch) {
      const row: Record<string, unknown> = {};
      if (patch.name) row.name = patch.name;
      if (patch.category) row.category = patch.category;
      if (patch.expiresOn) row.expires_on = patch.expiresOn;
      if (Object.keys(row).length) must(await sb.from('items').update(row).eq('id', id).eq('user_id', userId));
    },
    async removeItems(ids) {
      if (ids.length) must(await sb.from('items').update({ gone_at: new Date().toISOString() }).in('id', ids).eq('user_id', userId));
    },
    getKv: <T,>(key: string) => root.getKv<T>(p + key),
    async setKv(key, value) {
      must(await sb.from('kv').upsert({ key: p + key, value, updated_at: new Date().toISOString() }));
    },
    async saveRecipes(rows: NewRecipe[]) {
      return must(await sb.from('recipes').insert(rows.map((r) => ({ ...r, user_id: userId }))).select('*')).map(toRecipe);
    },
    async getRecipe(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const row = must(await sb.from('recipes').select('*').eq('id', id).eq('user_id', userId).maybeSingle());
      return row ? toRecipe(row) : null;
    },
    async updateRecipe(id, patch) {
      const row: Record<string, unknown> = {};
      if (patch.imageUrl) row.image_url = patch.imageUrl;
      if (patch.cookedAt) row.cooked_at = patch.cookedAt;
      if (Object.keys(row).length) must(await sb.from('recipes').update(row).eq('id', id).eq('user_id', userId));
    },
    async recentRecipes(limit) {
      return must(await sb.from('recipes').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit)).map(toRecipe);
    },
    countImages: (sinceIso) => countSince(sinceIso, userId),
    countAllImages: (sinceIso) => countSince(sinceIso),
    attempt: root.attempt,
    async uploadImage(path, bytes, mime) {
      const up = await sb.storage.from('dishes').upload(path, bytes, { contentType: mime, upsert: true, cacheControl: '31536000' });
      if (up.error) {
        console.error('storage error', up.error.message);
        throw new AppError('storage', '写真を保存できませんでした。', 500);
      }
      return sb.storage.from('dishes').getPublicUrl(path).data.publicUrl;
    },
    async wipe() {
      // 写真のファイルを消してから、設定などを消す(食材・レシピ・ログイン中の端末は、アカウントを消すと一緒に消える)
      const rows = must(await sb.from('recipes').select('image_url').eq('user_id', userId).not('image_url', 'is', null)) as { image_url: string }[];
      const paths = rows.map((r) => r.image_url.split('/dishes/')[1]).filter(Boolean);
      for (let i = 0; i < paths.length; i += 100) {
        const rm = await sb.storage.from('dishes').remove(paths.slice(i, i + 100));
        if (rm.error) console.error('storage remove error', rm.error.message);
      }
      must(await sb.from('kv').delete().like('key', p + '%'));
    },
  };
}

const accounts: Accounts = {
  async find(nameKey) {
    const r = must(await sb.from('users').select('id, name, pass_hash').eq('name_key', nameKey).maybeSingle()) as any;
    return r ? { id: r.id, name: r.name, passHash: r.pass_hash } : null;
  },
  async findById(id) {
    const r = must(await sb.from('users').select('id, name, pass_hash').eq('id', id).maybeSingle()) as any;
    return r ? { id: r.id, name: r.name, passHash: r.pass_hash } : null;
  },
  async create(name, nameKey, passHash) {
    const res = await sb.from('users').insert({ name, name_key: nameKey, pass_hash: passHash }).select('id').single();
    if (res.error?.code === '23505') return null; // 同じ名前がもうある
    return (must(res) as { id: string }).id;
  },
  async addSession(tokenHash, userId) {
    must(await sb.from('sessions').insert({ token_hash: tokenHash, user_id: userId }));
  },
  async session(tokenHash) {
    const r = must(await sb.from('sessions').select('user_id, users(name)').eq('token_hash', tokenHash).maybeSingle()) as any;
    return r?.users ? { id: r.user_id, name: r.users.name } : null;
  },
  async dropSession(tokenHash) {
    must(await sb.from('sessions').delete().eq('token_hash', tokenHash));
  },
  async remove(userId) {
    must(await sb.from('users').delete().eq('id', userId));
  },
};

/** 接続元の IP アドレス(Supabase の前段が付ける見出しから取る) */
function clientIp(req: Request): string {
  const h = req.headers;
  return (h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim();
}

// 秘密の値は少しの間だけ覚えておく(毎回データベースを読まない)
// secret:passhash は、登録のときに入れてもらう招待コード(のハッシュ)
let cache: { at: number; inviteHash: string | null; geminiKey: string | null } | null = null;
async function secrets() {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const [inviteHash, geminiKey] = await Promise.all([root.getKv<string>('secret:passhash'), root.getKv<string>('secret:gemini')]);
  cache = { at: Date.now(), inviteHash, geminiKey: Deno.env.get('GEMINI_API_KEY') ?? geminiKey };
  return cache;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: { code: 'method', message: 'POST だけ受け付けます。' } }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';
    const from = clientIp(req);
    // from は、呼んだ本人に自分の接続元がどう見えているかを返す(当て推量を止める仕組みの確認用)
    if (action === 'ping') return json({ ok: true, from });

    const sec = await secrets();
    const auth = { accounts, gates: root, inviteHash: sec.inviteHash, from };
    if (action === 'signup') return json(await signup(body, auth));
    if (action === 'login') return json(await login(body, auth));

    const token = req.headers.get('x-session');
    const user = await who(token, accounts);
    if (!user) return json({ error: { code: 'session', message: 'もう一度ログインしてください。' } }, 401);
    if (action === 'logout') {
      await logout(token, accounts);
      return json({ ok: true });
    }
    const store = storeFor(user.id);
    if (action === 'delete_account') {
      await deleteAccount(body, user, { ...auth, store });
      return json({ ok: true });
    }

    if (!sec.geminiKey) return json({ error: { code: 'setup', message: 'AI のキーがまだ登録されていません。' } }, 503);
    const ai = makeGemini({ key: sec.geminiKey, textModel: Deno.env.get('TEXT_MODEL'), imageModel: Deno.env.get('IMAGE_MODEL') });
    const out = await handle(action, body, { store, ai, prompts });
    return json(action === 'sync' ? { ...(out as object), name: user.name } : out);
  } catch (e) {
    if (e instanceof AppError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error('unexpected', e);
    return json({ error: { code: 'server', message: 'うまくいきませんでした。もう一度お試しください。' } }, 500);
  }
});
