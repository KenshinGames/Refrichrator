// アプリの状態と、中継サーバーとのやりとり。
// 画面はいつも手元の状態をすぐに描き、サーバーとの同期は裏で行う(押してから待たせない)。
import { useSyncExternalStore } from 'react';
import { addDays, daysBetween, DEFAULT_SETTINGS, SCENES, todayJst } from '../../supabase/functions/api/core.ts';
import type { Item, Limits, NewItem, Recipe, Scene, Settings, ShoppingIdea, Staple, Usage } from '../../supabase/functions/api/core.ts';

export type { Item, NewItem, Recipe, Scene, Settings, ShoppingIdea, Staple };

const PROD_API = 'https://vphcejuxczbttkuzqnlv.supabase.co/functions/v1/api';
const API_URL: string = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? `http://${location.hostname}:8791/functions/v1/api` : PROD_API);
const CACHE_KEY = 'refricherator:v1';
const NAME_KEY = 'refricherator:name'; // 最後にログインした名前(ログアウトしても残す)
// ログイン中のしるし。食材などの大きな保存とは分けて、すぐに書く
// (大きな保存が容量で失敗しても、ログインは消えないように)
const SESSION_KEY = 'refricherator:session';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface Batch {
  ids: string[];
  fridgeKey: string;
  day: string;
}
export interface State {
  session: { token: string; name: string } | null;
  synced: boolean; // この起動で1回でもサーバーと同期できたか
  items: Item[];
  staples: Staple[];
  settings: Settings;
  usage: Usage;
  limits: Limits;
  recipes: Record<string, Recipe>;
  plan: string[]; // 「作る」を押したレシピ(開き直してすぐ開けるように)
  favs: string[]; // お気に入りのレシピ
  batches: Partial<Record<Scene, Batch>>;
  sceneLoading: Partial<Record<Scene, boolean>>;
  sceneError: Partial<Record<Scene, string>>;
  image: Record<string, 'loading' | 'capped' | 'error'>;
  shopping: { key: string; ideas: ShoppingIdea[] } | null;
  shoppingLoading: boolean;
  shoppingError: string | null;
  ideaRecipe: Record<string, string>; // 「買うもの|料理名」→ レシピの ID
  ideaLoading: Record<string, boolean>;
  ideaError: Record<string, string>;
  toast: { id: number; text: string; action?: { label: string; run: () => void } } | null;
}

let state: State = {
  session: null,
  synced: false,
  items: [],
  staples: [],
  settings: DEFAULT_SETTINGS,
  usage: { images: 0, texts: 0 },
  limits: { images: 60, allImages: 180, texts: 600 },
  recipes: {},
  plan: [],
  favs: [],
  batches: {},
  sceneLoading: {},
  sceneError: {},
  image: {},
  shopping: null,
  shoppingLoading: false,
  shoppingError: null,
  ideaRecipe: {},
  ideaLoading: {},
  ideaError: {},
  toast: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
  schedulePersist();
}
export function getState(): State {
  return state;
}
export function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pick(state),
  );
}

// ───────── 手元への保存 ─────────

let persistTimer: number | undefined;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    // レシピは新しいものから30件だけ残す(「作る」「お気に入り」に入れたものは消さない)
    const savedIds = new Set([...state.plan, ...state.favs]);
    const recent = Object.values(state.recipes)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((r, i) => i < 30 || savedIds.has(r.id))
      .map((r) => (r.imageUrl?.startsWith('data:') ? { ...r, imageUrl: null } : r));
    const keep = {
      items: state.items,
      staples: state.staples,
      settings: state.settings,
      usage: state.usage,
      limits: state.limits,
      plan: state.plan,
      favs: state.favs,
      recipes: Object.fromEntries(recent.map((r) => [r.id, r])),
      batches: state.batches,
      shopping: state.shopping,
      ideaRecipe: state.ideaRecipe,
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(keep));
    } catch {
      // 保存できなくても動きは変えない(プライベートブラウズなど)
    }
  }, 150);
}
function loadCache(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) state = { ...state, ...JSON.parse(raw), session: null };
  } catch {
    // こわれていたら使わない
  }
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    if (s && typeof s.token === 'string' && typeof s.name === 'string') state = { ...state, session: { token: s.token, name: s.name } };
  } catch {
    // こわれていたら、もう一度ログインしてもらう
  }
}
/** ログインのしるしを、その場で保存する(消すときは null) */
function saveSession(s: State['session']): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // 保存できなくても、開いている間はログインしたまま使える
  }
}
/**
 * この端末の保存を、ブラウザが容量の都合で勝手に消さないように頼む。
 * 頼めないブラウザや、断られたときは何もしない。
 */
function keepStorage(): void {
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    // 何もしない
  }
}

// ───────── 通信 ─────────

async function api<T>(action: string, body: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session': state.session?.token ?? '' },
      body: JSON.stringify({ action, ...body }),
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError('network', '通信できませんでした。電波のよいところでもう一度お試しください。');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const err = data?.error;
    // ログインが切れていたら、扉にもどす
    // (通信が切れたときやサーバーの不調では消さない。サーバーが「このしるしは無効」と答えたときだけ。
    //  その人の食材なども手元から消して、次にログインする人に見えないようにする)
    if (res.status === 401 && err?.code === 'session') clearLocal();
    throw new ApiError(err?.code ?? 'server', err?.message ?? 'うまくいきませんでした。もう一度お試しください。', res.status);
  }
  return data as T;
}
const message = (e: unknown): string => (e instanceof ApiError ? e.message : 'うまくいきませんでした。もう一度お試しください。');

// ───────── 小さな道具 ─────────

export function today(): string {
  return todayJst();
}
export function daysLeft(item: Item): number {
  return daysBetween(today(), item.expiresOn);
}
export function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.name.localeCompare(b.name, 'ja'));
}
function fridgeKey(items: Item[]): string {
  return items.map((i) => i.id).sort().join(',');
}
export const ideaKey = (i: { buy: string; dish: string }): string => `${i.buy}|${i.dish}`;

let toastSeq = 0;
export function toast(text: string, action?: { label: string; run: () => void }): void {
  const id = ++toastSeq;
  set({ toast: { id, text, action } });
  setTimeout(
    () => {
      if (state.toast?.id === id) set({ toast: null });
    },
    action ? 5000 : 2600,
  );
}
export function closeToast(): void {
  set({ toast: null });
}

// ───────── 起動とログイン ─────────

interface SyncResult {
  name?: string;
  items: Item[];
  settings: Settings;
  staples: Staple[];
  usage: Usage;
  limits: State['limits'];
}

export function boot(): void {
  loadCache();
  // 合言葉は URL からは受け取らない(リンクを送ると、トークの履歴などから見えてしまうため)。
  // 以前の形のリンク(…#k=合言葉)で開かれたときは、使わずにアドレス欄から消すだけにする。
  if (/[#&?]k=/.test(location.hash + location.search)) history.replaceState(null, '', location.pathname);
  if (state.session) {
    keepStorage();
    void sync();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.session) void sync();
  });
}

/** 最後にこの端末でログインした名前 */
export function lastName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 登録またはログインする。うまくいけば null、だめなら画面に出す文を返す */
export async function signIn(mode: 'signup' | 'login', input: { name: string; password: string; invite?: string }): Promise<string | null> {
  try {
    const r = await api<{ token: string; name: string }>(mode, input, 30_000);
    try {
      localStorage.setItem(NAME_KEY, r.name);
    } catch {
      // 何もしない
    }
    const session = { token: r.token, name: r.name };
    saveSession(session);
    set({ session });
    keepStorage();
    await sync();
    return null;
  } catch (e) {
    return message(e);
  }
}

/** ログアウトする。この端末に残した中身も消す */
export async function leave(): Promise<void> {
  await api('logout', {}, 5_000).catch(() => {});
  clearLocal();
}
function clearLocal(): void {
  saveSession(null);
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // 何もしない
  }
  location.reload();
}

/** アカウントを消す。うまくいけば null、だめなら画面に出す文を返す */
export async function deleteAccount(password: string): Promise<string | null> {
  try {
    await api('delete_account', { password }, 30_000);
    try {
      localStorage.removeItem(NAME_KEY);
    } catch {
      // 何もしない
    }
    clearLocal();
    return null;
  } catch (e) {
    return message(e);
  }
}

function applySync(r: SyncResult): void {
  set({
    items: sortItems(r.items),
    settings: r.settings,
    staples: r.staples,
    usage: r.usage,
    limits: r.limits,
    synced: true,
    ...(r.name && state.session ? { session: { ...state.session, name: r.name } } : {}),
  });
  prewarmSoon(600);
}

/** 今いちばん開きそうな場面(平日は「つかれた日」、土日は「休みの日」) */
export function likelyScene(now = new Date()): Scene {
  const day = now.getDay();
  return day === 0 || day === 6 ? 'holiday' : 'tired';
}
let prewarmTimer: number | undefined;
/**
 * 開きそうな場面の提案を、文字だけ先に用意しておく(押したときにすぐ出せるように)。
 * 写真はお金がかかるので、実際にその場面を開いたときに作る。
 */
function prewarmSoon(delay: number): void {
  window.clearTimeout(prewarmTimer);
  prewarmTimer = window.setTimeout(() => {
    if (document.visibilityState !== 'visible' || !state.session || !state.synced || pending > 0) return;
    void loadScene(likelyScene(), false, false);
  }, delay);
}
export async function sync(): Promise<void> {
  if (pending > 0) return;
  try {
    const r = await api<SyncResult>('sync', {}, 20_000);
    if (pending === 0) applySync(r);
  } catch {
    // 手元の内容で動かし続ける
  }
}

// ───────── 食材の変更(手元をすぐ変え、サーバーには順番に送る) ─────────

let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
function mutate(run: () => Promise<{ items: Item[]; staples?: Staple[] }>): Promise<void> {
  pending++;
  const job = queue.then(async () => {
    try {
      const r = await run();
      pending--;
      // 次の変更が待っている間は、手元の見た目を優先する
      if (pending === 0) {
        set({ items: sortItems(r.items), ...(r.staples ? { staples: r.staples } : {}) });
        prewarmSoon(2500);
      }
    } catch (e) {
      pending--;
      toast(message(e));
      if (pending === 0) await sync();
    }
  });
  queue = job;
  return job;
}
/** 送っている途中の変更が終わるのを待つ */
function settled(): Promise<unknown> {
  return queue;
}

export function addItems(rows: NewItem[]): string[] {
  if (!rows.length) return [];
  const day = today();
  const withIds = rows.map((r) => ({ ...r, id: crypto.randomUUID() }));
  const fresh: Item[] = withIds.map((r) => ({ id: r.id, name: r.name, category: r.category, addedOn: day, expiresOn: addDays(day, r.days) }));
  set({ items: sortItems([...state.items, ...fresh]) });
  void mutate(() => api('add', { items: withIds }));
  return withIds.map((r) => r.id);
}
export function setDays(id: string, days: number): void {
  const d = Math.max(0, Math.min(365, days));
  set({ items: sortItems(state.items.map((i) => (i.id === id ? { ...i, expiresOn: addDays(today(), d) } : i))) });
  void mutate(() => api('update', { id, days: d }));
}
export function removeItems(ids: string[]): void {
  if (!ids.length) return;
  set({ items: state.items.filter((i) => !ids.includes(i.id)) });
  void mutate(() => api('remove', { ids }));
}
export function restoreItems(items: Item[]): void {
  // 「元に戻す」用:同じ名前・同じ期限で入れ直す
  const day = today();
  addItems(items.map((i) => ({ name: i.name, category: i.category, days: Math.max(1, daysBetween(day, i.expiresOn)) })));
}
/** 「作る」に入れる/出す */
export function togglePlan(id: string): void {
  set({ plan: state.plan.includes(id) ? state.plan.filter((x) => x !== id) : [id, ...state.plan] });
}
/** お気に入りに入れる/出す */
export function toggleFav(id: string): void {
  set({ favs: state.favs.includes(id) ? state.favs.filter((x) => x !== id) : [id, ...state.favs] });
}

export function cooked(recipeId: string, usedUp: string[]): void {
  set({
    plan: state.plan.filter((x) => x !== recipeId),
    items: state.items.filter((i) => !usedUp.includes(i.id)),
    recipes: state.recipes[recipeId]
      ? { ...state.recipes, [recipeId]: { ...state.recipes[recipeId], cookedAt: new Date().toISOString() } }
      : state.recipes,
  });
  void mutate(() => api('cooked', { id: recipeId, usedUp }));
}

/** 文章や写真から食材を読み取る(まだ冷蔵庫には入れない) */
export async function parse(input: { text: string } | { image: { data: string; mime: string }; kind: 'receipt' | 'photo' }): Promise<NewItem[]> {
  const r = await api<{ items: NewItem[] }>('parse', input);
  return r.items;
}

// ───────── 提案 ─────────

/** その場面の提案が今の冷蔵庫に合っているか(合っていればそのまま見せる) */
export function batchFor(s: State, scene: Scene): Recipe[] | null {
  const b = s.batches[scene];
  if (!b || b.day !== today() || b.fridgeKey !== fridgeKey(s.items)) return null;
  const list = b.ids.map((id) => s.recipes[id]).filter(Boolean);
  return list.length ? list : null;
}

export async function loadScene(scene: Scene, another = false, withImages = true): Promise<void> {
  if (state.sceneLoading[scene]) return;
  if (!another && batchFor(state, scene)) return;
  if (!state.items.length) return;
  // ほかの場面で出している料理とはタイトルがかぶらないようにする
  // (「つかれた日」と「お弁当」で同じレシピが出る、という声への対策)
  const otherTitles = SCENES.filter((sc) => sc !== scene).flatMap((sc) => (batchFor(state, sc) ?? []).map((r) => r.title));
  const avoid = [...new Set([...(another ? (batchFor(state, scene) ?? []).map((r) => r.title) : []), ...otherTitles])];
  set({ sceneLoading: { ...state.sceneLoading, [scene]: true }, sceneError: { ...state.sceneError, [scene]: undefined } });
  try {
    await settled();
    const r = await api<{ recipes: Recipe[] }>('suggest', { scene, avoid });
    const recipes = { ...state.recipes };
    for (const rec of r.recipes) recipes[rec.id] = rec;
    set({
      recipes,
      batches: { ...state.batches, [scene]: { ids: r.recipes.map((x) => x.id), fridgeKey: fridgeKey(state.items), day: today() } },
      sceneLoading: { ...state.sceneLoading, [scene]: false },
    });
    if (withImages) for (const rec of r.recipes) void loadImage(rec.id);
  } catch (e) {
    // 先回りの用意が失敗しただけなら、何も見せない(開いたときにもう一度試す)
    set({ sceneLoading: { ...state.sceneLoading, [scene]: false }, sceneError: { ...state.sceneError, [scene]: withImages ? message(e) : undefined } });
  }
}

export async function loadImage(id: string): Promise<void> {
  const rec = state.recipes[id];
  if (!rec || rec.imageUrl || state.image[id] === 'loading' || state.image[id] === 'capped') return;
  set({ image: { ...state.image, [id]: 'loading' } });
  try {
    const r = await api<{ url?: string; capped?: boolean }>('image', { id }, 90_000);
    if (r.url) {
      await preload(r.url);
      const { [id]: _done, ...rest } = state.image;
      set({ recipes: { ...state.recipes, [id]: { ...state.recipes[id], imageUrl: r.url } }, image: rest });
    } else {
      set({ image: { ...state.image, [id]: 'capped' } });
    }
  } catch {
    set({ image: { ...state.image, [id]: 'error' } });
  }
}
function preload(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
    setTimeout(resolve, 8000);
  });
}

// ───────── 買い物 ─────────

export async function loadShopping(): Promise<void> {
  const key = today() + ':' + fridgeKey(state.items);
  if (state.shoppingLoading || state.shopping?.key === key) return;
  if (!state.items.length) {
    set({ shopping: { key, ideas: [] } });
    return;
  }
  set({ shoppingLoading: true, shoppingError: null });
  try {
    await settled();
    const r = await api<{ ideas: ShoppingIdea[] }>('shopping');
    set({ shopping: { key: today() + ':' + fridgeKey(state.items), ideas: r.ideas }, shoppingLoading: false });
  } catch (e) {
    set({ shoppingLoading: false, shoppingError: message(e) });
  }
}

/** 買い物の案から、その料理のレシピを作る */
export async function loadIdea(idea: { buy: string; dish: string }): Promise<void> {
  const key = ideaKey(idea);
  if (state.ideaLoading[key] || (state.ideaRecipe[key] && state.recipes[state.ideaRecipe[key]])) return;
  set({ ideaLoading: { ...state.ideaLoading, [key]: true }, ideaError: { ...state.ideaError, [key]: '' } });
  try {
    await settled();
    const r = await api<{ recipes: Recipe[] }>('suggest', { scene: 'tired', dish: idea.dish, buy: idea.buy });
    const rec = r.recipes[0];
    set({
      recipes: { ...state.recipes, [rec.id]: rec },
      ideaRecipe: { ...state.ideaRecipe, [key]: rec.id },
      ideaLoading: { ...state.ideaLoading, [key]: false },
    });
    void loadImage(rec.id);
  } catch (e) {
    set({ ideaLoading: { ...state.ideaLoading, [key]: false }, ideaError: { ...state.ideaError, [key]: message(e) } });
  }
}

// ───────── 設定 ─────────

export function saveSettings(next: Settings): void {
  set({ settings: next, batches: {} });
  api('settings', { settings: next }).catch((e) => toast(message(e)));
}
