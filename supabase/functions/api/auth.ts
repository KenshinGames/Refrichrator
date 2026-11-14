// アカウント(名前とパスワード)。メールアドレスは使わない。
// 登録には招待コードが要る(知らない人が登録して、AI の費用を使えないようにするため)。
import { AppError, gate, limit, LOCKED_MESSAGE, sha256 } from './core.ts';
import type { Store } from './core.ts';

export interface Account {
  id: string;
  name: string;
  passHash: string;
}
export interface Accounts {
  find(nameKey: string): Promise<Account | null>;
  findById(id: string): Promise<Account | null>;
  /** アカウントを作る。同じ名前がもうあれば null */
  create(name: string, nameKey: string, passHash: string): Promise<string | null>;
  addSession(tokenHash: string, userId: string): Promise<void>;
  session(tokenHash: string): Promise<{ id: string; name: string } | null>;
  dropSession(tokenHash: string): Promise<void>;
  /** アカウントと、そのログイン中の端末を消す */
  remove(userId: string): Promise<void>;
}
export interface AuthDeps {
  accounts: Accounts;
  gates: Pick<Store, 'attempt'>;
  inviteHash: string | null;
  from: string;
  now?: Date;
  iterations?: number; // テストでだけ小さくする
}

export const NAME_MAX = 20;
export const PASS_MIN = 8;
const PASS_MAX = 200;
export const PBKDF2_ITERATIONS = 600_000;

// ───────── 名前とパスワード ─────────

/** 名前を整える。比べるときは大文字小文字と空白を無視する */
export function cleanName(raw: unknown): { name: string; key: string } {
  const name = (typeof raw === 'string' ? raw : '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!name) throw new AppError('name', '名前を入れてください。');
  if ([...name].length > NAME_MAX) throw new AppError('name', `名前は${NAME_MAX}文字までにしてください。`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new AppError('name', 'その名前は使えません。');
  return { name, key: name.toLowerCase().replace(/ /g, '') };
}
function cleanPassword(raw: unknown): string {
  const pw = typeof raw === 'string' ? raw : '';
  if ([...pw].length < PASS_MIN) throw new AppError('password', `パスワードは${PASS_MIN}文字以上にしてください。`);
  if (pw.length > PASS_MAX) throw new AppError('password', 'パスワードが長すぎます。');
  return pw;
}

const enc = new TextEncoder();
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pw: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}
/** パスワードを、塩つきの PBKDF2 で元に戻せない形にする */
export async function hashPassword(pw: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await derive(pw, salt, iterations))}`;
}
export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, it, salt, hash] = stored.split('$');
  const iterations = Number(it);
  if (alg !== 'pbkdf2-sha256' || !salt || !hash || !Number.isInteger(iterations) || iterations < 1) return false;
  const got = b64(await derive(pw.slice(0, PASS_MAX), unb64(salt), iterations));
  let diff = got.length ^ hash.length;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ (hash.charCodeAt(i) || 0);
  return diff === 0;
}

// ───────── ログイン中の端末 ─────────

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function startSession(d: AuthDeps, userId: string): Promise<string> {
  const token = newToken();
  await d.accounts.addSession(await sha256(token), userId);
  return token;
}
/** トークンから、ログイン中の人を調べる */
export async function who(token: string | null, accounts: Accounts): Promise<{ id: string; name: string } | null> {
  if (!token || token.length > 100) return null;
  return accounts.session(await sha256(token));
}

// ───────── 登録・ログイン・ログアウト・削除 ─────────

const locked = () => new AppError('locked', LOCKED_MESSAGE, 429);

export async function signup(body: Record<string, unknown>, d: AuthDeps): Promise<{ token: string; name: string }> {
  const { name, key } = cleanName(body.name);
  const password = cleanPassword(body.password);
  const invite = typeof body.invite === 'string' ? body.invite.trim() : '';
  const g = await gate(d.gates, d.from, invite || null, d.inviteHash, d.now);
  if (g === 'locked') throw locked();
  if (g === 'wrong') throw new AppError('invite', '招待コードが違います。', 401);
  const id = await d.accounts.create(name, key, await hashPassword(password, d.iterations));
  if (!id) throw new AppError('taken', 'その名前はもう使われています。別の名前にしてください。', 409);
  return { token: await startSession(d, id), name };
}

export async function login(body: Record<string, unknown>, d: AuthDeps): Promise<{ token: string; name: string }> {
  const { key } = cleanName(body.name);
  const pw = typeof body.password === 'string' ? body.password : '';
  const acc = await d.accounts.find(key);
  // 名前がないときも同じだけ時間をかけて、名前があるかどうかを時間から分からないようにする
  const ok = acc ? await checkPassword(pw, acc.passHash) : (await checkPassword(pw, dummyHash(d)), false);
  if (await limit(d.gates, d.from, !ok, d.now)) throw locked();
  if (!ok || !acc) throw new AppError('login', '名前かパスワードが違います。', 401);
  return { token: await startSession(d, acc.id), name: acc.name };
}
const dummyHash = (d: AuthDeps) => `pbkdf2-sha256$${d.iterations ?? PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$x`;

export async function logout(token: string | null, accounts: Accounts): Promise<void> {
  if (token && token.length <= 100) await accounts.dropSession(await sha256(token));
}

/** アカウントを消す(パスワードの確認つき)。食材・レシピ・写真・設定もすべて消す */
export async function deleteAccount(body: Record<string, unknown>, user: { id: string }, d: AuthDeps & { store: Pick<Store, 'wipe'> }): Promise<void> {
  const acc = await d.accounts.findById(user.id);
  const ok = !!acc && (await checkPassword(typeof body.password === 'string' ? body.password : '', acc.passHash));
  if (await limit(d.gates, d.from, !ok, d.now)) throw locked();
  if (!ok) throw new AppError('login', 'パスワードが違います。', 401);
  await d.store.wipe();
  await d.accounts.remove(user.id);
}
