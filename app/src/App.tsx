// 全体の組み立て:扉、ホーム、買い物、設定、下のタブ。
import { useEffect, useState } from 'react';
import { IdeaScreen, PlanScreen, RecipeScreen, SCENE_INFO, SceneScreen } from './Cook.tsx';
import { Fridge, stack } from './Fridge.tsx';
import { batchFor, daysLeft, deleteAccount, lastName, leave, likelyScene, loadShopping, prewarmScenes, saveSettings, signIn, useStore } from './store.ts';
import type { Scene } from './store.ts';
import { back, go, Icon, ideaPath, leftLabel, leftTone, Ring, Sheet, Stepper, Toast, useRoute, useVisualViewport } from './ui.tsx';
import { getTheme, setTheme } from './theme.ts';
import type { Theme } from './theme.ts';

const SCENE_ORDER: Scene[] = ['tired', 'holiday', 'bento'];
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

export function App() {
  useVisualViewport();
  const signedIn = useStore((s) => !!s.session);
  const route = useRoute();
  const tab = route.name === 'home' || route.name === 'fridge' || route.name === 'plan' || route.name === 'shop' ? route.name : null;
  const key = route.name + ('scene' in route ? route.scene : '') + ('id' in route ? route.id : '') + ('dish' in route ? route.dish : '');

  return (
    <div className="app">
      {signedIn && (
        <>
          <main className={tab ? 'stage stage-tabs' : 'stage'} key={key}>
            {route.name === 'home' && <Home />}
            {route.name === 'fridge' && <Fridge />}
            {route.name === 'plan' && <PlanScreen />}
            {route.name === 'shop' && <Shop />}
            {route.name === 'settings' && <Settings />}
            {route.name === 'scene' && <SceneScreen scene={route.scene} />}
            {route.name === 'recipe' && <RecipeScreen id={route.id} />}
            {route.name === 'idea' && <IdeaScreen buy={route.buy} dish={route.dish} />}
          </main>
          {tab && (
            <nav className="tabs" aria-label="メニュー">
              {(
                [
                  ['home', '/', 'ホーム', 'home'],
                  ['fridge', '/fridge', '冷蔵庫', 'fridge'],
                  ['plan', '/plan', '作る', 'plate'],
                  ['shop', '/shop', '買い物', 'basket'],
                ] as const
              ).map(([name, path, label, icon]) => (
                <button key={name} className={tab === name ? 'on' : ''} aria-current={tab === name ? 'page' : undefined} onClick={() => tab !== name && go(path, true)}>
                  <Icon name={icon} />
                  {label}
                </button>
              ))}
            </nav>
          )}
          <Toast />
        </>
      )}
      <Door locked={!signedIn} />
    </div>
  );
}

// ───────── 扉 ─────────

function Door({ locked }: { locked: boolean }) {
  // 鍵がかかっている間は閉じたまま。開いたら、開く動きのあとで片づける
  const [gone, setGone] = useState(false);
  const [mode, setMode] = useState<'signup' | 'login'>(() => (lastName() ? 'login' : 'signup'));
  const [name, setName] = useState(lastName);
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (locked) {
      setGone(false);
      return;
    }
    const t = setTimeout(() => setGone(true), 900);
    return () => clearTimeout(t);
  }, [locked]);
  if (gone) return null;

  const signup = mode === 'signup';
  const ready = name.trim() && password && (!signup || invite.trim());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    const problem = await signIn(mode, { name, password, ...(signup ? { invite } : {}) });
    setBusy(false);
    if (problem) setError(problem);
  };
  const switchTo = (m: 'signup' | 'login') => {
    setMode(m);
    setError('');
  };

  return (
    <div className={`door ${locked ? 'door-locked' : 'door-open'}`} aria-hidden={!locked}>
      <div className="door-leaf">
        <span className="door-handle" />
        <div className="door-face">
          <div className="door-inner">
            <p className="wordmark">Refrichrator</p>
            <p className="door-tag">冷蔵庫を、リッチに使い切る。</p>
            {locked && (
              <form className="door-form" onSubmit={submit}>
                <div className="door-modes" role="tablist" aria-label="入り方">
                  <button type="button" role="tab" aria-selected={signup} className={signup ? 'on' : ''} onClick={() => switchTo('signup')}>
                    はじめて使う
                  </button>
                  <button type="button" role="tab" aria-selected={!signup} className={!signup ? 'on' : ''} onClick={() => switchTo('login')}>
                    ログイン
                  </button>
                </div>
                <label htmlFor="name">名前</label>
                <input id="name" className="field field-dark" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={20} enterKeyHint="next" />
                <label htmlFor="password">パスワード{signup && <small>8文字以上</small>}</label>
                <input
                  id="password"
                  className="field field-dark"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  enterKeyHint={signup ? 'next' : 'go'}
                />
                {signup && (
                  <>
                    <label htmlFor="invite">招待コード</label>
                    <input id="invite" className="field field-dark" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="go" />
                  </>
                )}
                {error && (
                  <p className="door-error" role="alert">
                    {error}
                  </p>
                )}
                <button className="btn btn-light" disabled={!ready || busy}>
                  {busy ? '確かめています' : signup ? 'はじめる' : 'ログイン'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────── ホーム ─────────

function SceneCard({ scene, big }: { scene: Scene; big: boolean }) {
  const info = SCENE_INFO[scene];
  // 提案がもう用意できていれば、その1品目を見せる(写真があれば写真も)
  const ids = useStore((s) => batchFor(s, scene)?.map((r) => r.id).join(',') ?? '');
  const recipes = useStore((s) => s.recipes);
  const ready = ids ? ids.split(',').map((id) => recipes[id]).filter(Boolean) : [];
  const photo = ready.find((r) => r.imageUrl)?.imageUrl;
  return (
    <button className={`scene ${big ? 'scene-big' : ''}`} onClick={() => go(`/s/${scene}`)}>
      <img src={photo ?? `./covers/${scene}.jpg`} alt="" decoding="async" />
      <span className="scene-name">{info.name}</span>
      <span className="scene-note">{big && ready.length ? (photo ? `${ready.find((r) => r.imageUrl)!.title} ほか${ready.length - 1}品` : `${ready.length}品の提案ができています`) : info.note}</span>
    </button>
  );
}

function Home() {
  const items = useStore((s) => s.items);
  const synced = useStore((s) => s.synced);
  // ホームに来たら、3つの場面の提案を裏で確定させておく(登録のたびには呼ばない)
  useEffect(() => {
    if (synced) void prewarmScenes();
  }, [synced, items]);
  const now = new Date();
  const soon = stack(items.filter((i) => daysLeft(i) <= 3)).slice(0, 6);
  // いま開きそうな場面(平日はつかれた日、土日は休みの日)を大きく出す
  const first = likelyScene(now);
  const order = [first, ...SCENE_ORDER.filter((s) => s !== first)];
  return (
    <div className="screen home">
      <header className="home-head">
        <p className="date">
          {now.getMonth() + 1}月{now.getDate()}日 {WEEK[now.getDay()]}曜日
        </p>
        <button className="round" aria-label="設定" onClick={() => go('/settings')}>
          <Icon name="gear" size={22} />
        </button>
      </header>
      <h1 className="ask">{now.getHours() < 15 ? '今日、なに作る？' : '今夜、なに作る？'}</h1>

      {items.length === 0 && (
        <div className="empty">
          <p className="empty-title">まず、家にあるものを入れましょう</p>
          <p>冷蔵庫の中身に合わせて、今日の料理を提案します。</p>
          <button className="btn" onClick={() => go('/fridge', true)}>
            食材を入れる
          </button>
        </div>
      )}

      <div className="scenes">
        {order.map((s, n) => (
          <SceneCard key={s} scene={s} big={n === 0} />
        ))}
      </div>

      {items.length > 0 && (
        <section className="soon">
          <>
            <div className="sec-head">
              <h2>そろそろ使い切りたい</h2>
              <button className="sec-link" onClick={() => go('/fridge', true)}>
                冷蔵庫を見る
              </button>
            </div>
            {soon.length === 0 ? (
              <p className="quiet">急いで使うものはありません。</p>
            ) : (
              <ul className="soon-list">
                {soon.map(({ item: i }) => (
                  <li key={i.id}>
                    <button onClick={() => go('/fridge', true)} aria-label={`${i.name} ${leftLabel(daysLeft(i))}`}>
                      <Ring item={i} size={52} />
                      {i.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        </section>
      )}
    </div>
  );
}

// ───────── 買い物 ─────────

function Shop() {
  const items = useStore((s) => s.items);
  const shopping = useStore((s) => s.shopping);
  const loading = useStore((s) => s.shoppingLoading);
  const error = useStore((s) => s.shoppingError);
  useEffect(() => {
    void loadShopping();
  }, [items]);
  const ideas = shopping?.ideas ?? [];

  return (
    <div className="screen">
      <header className="title-row">
        <h1>買い物</h1>
      </header>
      {items.length === 0 ? (
        <div className="empty">
          <p className="empty-title">冷蔵庫は空です</p>
          <p>家にあるものを入れておくと、「あと1つ買えば作れる料理」をここに出します。</p>
          <button className="btn" onClick={() => go('/fridge', true)}>
            食材を入れる
          </button>
        </div>
      ) : (
        <>
          <p className="lede">あと1つ買えば、今夜これが作れます。</p>
          {loading && !ideas.length ? (
            <ul className="ideas" aria-hidden="true">
              {[0, 1, 2, 3].map((n) => (
                <li key={n} className="idea idea-skel">
                  <span className="skel" style={{ width: '34%', height: 20 }} />
                  <span className="skel" style={{ width: '72%' }} />
                </li>
              ))}
            </ul>
          ) : error && !ideas.length ? (
            <div className="empty">
              <p>{error}</p>
              <button className="btn" onClick={() => void loadShopping()}>
                もう一度ためす
              </button>
            </div>
          ) : (
            <ul className="ideas">
              {ideas.map((i) => (
                <li key={i.buy + i.dish}>
                  <button className="idea" onClick={() => go(ideaPath(i))}>
                    <span className="idea-buy">
                      <b>{i.buy}</b>を買うと
                    </span>
                    <span className="idea-dish">{i.dish}</span>
                    <span className="idea-uses">
                      {i.uses.length > 0 && <>{[...new Set(i.uses)].join('・')}を使う</>}
                      <span className="meta">
                        <Icon name="clock" size={15} />
                        {i.minutes}分
                      </span>
                    </span>
                    <Icon name="right" size={20} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <section className="group">
            <h2>家にあるもの</h2>
            <ul className="have">
              {stack(items).map(({ item: i }) => (
                <li key={i.id} className={`have-${leftTone(daysLeft(i))}`}>
                  {i.name}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

// ───────── 設定 ─────────

function Settings() {
  const settings = useStore((s) => s.settings);
  const usage = useStore((s) => s.usage);
  const limits = useStore((s) => s.limits);
  const name = useStore((s) => s.session?.name ?? '');
  const [deleting, setDeleting] = useState(false);
  const [dislikes, setDislikes] = useState(settings.dislikes);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const pickTheme = (t: Theme) => {
    setTheme(t);
    setThemeState(t);
  };
  useEffect(() => setDislikes(settings.dislikes), [settings.dislikes]);
  return (
    <div className="screen">
      <header className="bar">
        <button className="round" aria-label="もどる" onClick={() => back('/')}>
          <Icon name="left" size={22} />
        </button>
        <h1>設定</h1>
      </header>

      <section className="set">
        <h2>何人分</h2>
        <Stepper value={settings.servings} min={1} max={6} label="人数" unit="人分" onChange={(v) => saveSettings({ ...settings, servings: v })} />
      </section>

      <section className="set">
        <h2>使わないもの</h2>
        <p className="hint">苦手なものやアレルギーがあれば書いてください。提案から外します。</p>
        <input
          className="field"
          value={dislikes}
          onChange={(e) => setDislikes(e.target.value)}
          onBlur={() => dislikes.trim() !== settings.dislikes && saveSettings({ ...settings, dislikes: dislikes.trim() })}
          placeholder="例:パクチー、えび"
          aria-label="使わないもの"
          enterKeyHint="done"
        />
      </section>

      <section className="set">
        <h2>画面の明るさ</h2>
        <div className="seg" role="radiogroup" aria-label="画面の明るさ">
          {(
            [
              ['light', 'ライト', 'sun'],
              ['dark', 'ダーク', 'moon'],
            ] as const
          ).map(([value, label, icon]) => (
            <button key={value} role="radio" aria-checked={theme === value} className={theme === value ? 'on' : ''} onClick={() => pickTheme(value)}>
              <Icon name={icon} size={18} />
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="set">
        <h2>今月の料理写真</h2>
        <p className="usage">
          <b>{usage.images}</b> / {limits.images} 枚
        </p>
        <p className="hint">上限に達すると、その月は写真なしで提案します。</p>
      </section>

      <section className="set">
        <h2>アカウント</h2>
        <p className="hint">{name}さんでログイン中</p>
        <button className="btn btn-line" onClick={() => void leave()}>
          ログアウト
        </button>
        <button className="danger-link" onClick={() => setDeleting(true)}>
          アカウントを削除
        </button>
      </section>
      {deleting && <DeleteSheet onClose={() => setDeleting(false)} />}
    </div>
  );
}

function DeleteSheet({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    const problem = await deleteAccount(password);
    setBusy(false);
    if (problem) setError(problem);
  };
  return (
    <Sheet
      title="アカウントを削除"
      onClose={onClose}
      footer={
        <button className="btn btn-danger" disabled={!password || busy} onClick={run}>
          {busy ? '削除しています' : '削除する'}
        </button>
      }
    >
      <p className="hint">冷蔵庫の中身、これまでの提案と写真、設定がすべて消え、元に戻せません。確かめのため、パスワードを入れてください。</p>
      <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" aria-label="パスワード" />
      {error && (
        <p className="problem" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
