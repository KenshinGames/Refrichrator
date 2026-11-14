// 手元で動かす中継サーバー。本番と同じ core と auth を、メモリ上の保存先で動かす。
//   node tools/dev-api.ts          にせものの AI(お金はかからない)
//   node tools/dev-api.ts --real   本物の Gemini(GEMINI_API_KEY を使う)
// 招待コードは test-pass。最初から「テスト」/「test-pass-123」のアカウントがある。
import { createServer } from 'node:http';
import { deleteAccount, hashPassword, login, logout, signup, who } from '../supabase/functions/api/auth.ts';
import { AppError, handle, sha256 } from '../supabase/functions/api/core.ts';
import { makeGemini, prompts } from '../supabase/functions/api/gemini.ts';
import { makeFakeAI, makeMemoryDb } from './memory.ts';

const real = process.argv.includes('--real');
const port = Number(process.env.API_PORT ?? 8791);
const invite = process.env.DEV_INVITE ?? 'test-pass';
const inviteHash = await sha256(invite);
const ITER = 20_000; // 手元では速さを優先する(本番は 600,000)
export const TEST_USER = { name: 'テスト', password: 'test-pass-123' };

let db = makeMemoryDb();
async function reset() {
  db = makeMemoryDb();
  const key = TEST_USER.name.toLowerCase();
  await db.accounts.create(TEST_USER.name, key, await hashPassword(TEST_USER.password, ITER));
}
await reset();

const state = { delay: Number(process.env.FAKE_DELAY ?? 700), fail: false };
const ai = real
  ? makeGemini({ key: process.env.GEMINI_API_KEY ?? '' })
  : makeFakeAI({ get delay() { return state.delay; }, fail: () => state.fail });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-session',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204, {});
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  // テスト用:保存先を空にする、AI の遅さや失敗を切り替える
  if (req.url === '/__test') {
    if (body.reset) await reset();
    if (typeof body.delay === 'number') state.delay = body.delay;
    if (typeof body.fail === 'boolean') state.fail = body.fail;
    return send(200, { ok: true });
  }
  try {
    const action = String(body.action ?? '');
    const from = req.socket.remoteAddress ?? 'local';
    if (action === 'ping') return send(200, { ok: true, from });
    const auth = { accounts: db.accounts, gates: { attempt: db.attempt }, inviteHash, from, iterations: ITER };
    if (action === 'signup') return send(200, await signup(body, auth));
    if (action === 'login') return send(200, await login(body, auth));
    const token = String(req.headers['x-session'] ?? '');
    const user = await who(token, db.accounts);
    if (!user) return send(401, { error: { code: 'session', message: 'もう一度ログインしてください。' } });
    if (action === 'logout') {
      await logout(token, db.accounts);
      return send(200, { ok: true });
    }
    const store = db.forUser(user.id);
    if (action === 'delete_account') {
      await deleteAccount(body, user, { ...auth, store });
      return send(200, { ok: true });
    }
    const out = await handle(action, body, { store, ai, prompts });
    send(200, action === 'sync' ? { ...(out as object), name: user.name } : out);
  } catch (e) {
    if (e instanceof AppError) return send(e.status, { error: { code: e.code, message: e.message } });
    console.error(e);
    send(500, { error: { code: 'server', message: 'うまくいきませんでした。もう一度お試しください。' } });
  }
}).listen(port, () => console.log(`dev api: http://localhost:${port}  (${real ? '本物の Gemini' : 'にせものの AI'} / 招待コード ${invite})`));
