// 冷蔵庫の画面:食材を足す4つの方法と、今あるものの一覧。
import { useEffect, useMemo, useRef, useState } from 'react';
import { normName } from '../../supabase/functions/api/core.ts';
import { lookup, quickParse, quickPicks } from './foods.ts';
import { addItems, ApiError, daysLeft, parse, removeItems, restoreItems, setDays, toast, useStore } from './store.ts';
import type { Item, NewItem } from './store.ts';
import { Icon, leftLabel, leftTone, Ring, Sheet, Stepper } from './ui.tsx';

type AddMode = 'text' | 'picks' | 'receipt' | 'photo';

/** 写真を送りやすい大きさの JPEG にする(長い辺 1400px まで) */
async function toJpeg(file: File): Promise<{ data: string; mime: string; preview: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    // 縮められない形式は、そのまま送る
    const raw = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('read'));
      fr.readAsDataURL(file);
    });
    return { data: raw.slice(raw.indexOf(',') + 1), mime: file.type || 'image/jpeg', preview: raw };
  }
  const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.82);
  return { data: url.slice(url.indexOf(',') + 1), mime: 'image/jpeg', preview: url };
}

/** 同じ名前・同じ期限の食材を1つにまとめる(見た目だけ。中身は別々のまま) */
export function stack(items: Item[]): { item: Item; count: number }[] {
  const out: { item: Item; count: number }[] = [];
  for (const item of items) {
    const hit = out.find((o) => normName(o.item.name) === normName(item.name) && o.item.expiresOn === item.expiresOn);
    if (hit) hit.count++;
    else out.push({ item, count: 1 });
  }
  return out;
}

export function Fridge() {
  const items = useStore((s) => s.items);
  const [mode, setMode] = useState<AddMode | null>(null);
  const [shot, setShot] = useState<{ file: File; kind: 'receipt' | 'photo' } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const receiptInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const soon: Item[] = [];
    const week: Item[] = [];
    const later: Item[] = [];
    for (const i of items) {
      const d = daysLeft(i);
      (d <= 2 ? soon : d <= 7 ? week : later).push(i);
    }
    return [
      { title: 'そろそろ使い切りたい', list: soon },
      { title: '今週のうちに', list: week },
      { title: 'まだ大丈夫', list: later },
    ].filter((g) => g.list.length);
  }, [items]);

  const pick = (kind: 'receipt' | 'photo') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setShot({ file, kind });
    setMode(kind);
  };
  const editingItem = items.find((i) => i.id === editing);

  return (
    <div className="screen">
      <header className="title-row">
        <h1>冷蔵庫</h1>
        {items.length > 0 && <span className="count">{items.length}品</span>}
      </header>

      <div className="add-panel" aria-label="食材を足す">
        <button onClick={() => receiptInput.current?.click()}>
          <Icon name="receipt" />
          レシートを撮る
        </button>
        <button onClick={() => photoInput.current?.click()}>
          <Icon name="camera" />
          食材を撮る
        </button>
        <button onClick={() => setMode('text')}>
          <Icon name="pen" />
          書く・話す
        </button>
        <button onClick={() => setMode('picks')}>
          <Icon name="star" />
          いつもの
        </button>
      </div>
      <input ref={receiptInput} type="file" accept="image/*" capture="environment" hidden onChange={pick('receipt')} data-testid="receipt-input" />
      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={pick('photo')} data-testid="photo-input" />

      {items.length === 0 ? (
        <div className="empty">
          <p className="empty-title">冷蔵庫は空です</p>
          <p>買ってきたものを、上の4つのどれかで入れてください。レシートを撮るのがいちばん早く済みます。</p>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.title} className="group">
              <h2>{g.title}</h2>
              <ul className="rows">
                {stack(g.list).map(({ item: i, count }) => (
                  <li key={i.id}>
                    <button className="row" onClick={() => setEditing(i.id)}>
                      <Ring item={i} />
                      <span className="row-main">
                        <span className="row-name">
                          {i.name}
                          {count > 1 && <span className="times">×{count}</span>}
                        </span>
                        <span className={`left left-${leftTone(daysLeft(i))}`}>{leftLabel(daysLeft(i))}</span>
                      </span>
                      <Icon name="right" size={18} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <button className="danger-link" onClick={() => setResetting(true)}>
            食材を全部リセット
          </button>
        </>
      )}

      {mode && (
        <AddSheet
          mode={mode}
          shot={shot}
          onClose={() => {
            setMode(null);
            setShot(null);
          }}
          onRetake={() => (mode === 'receipt' ? receiptInput : photoInput).current?.click()}
        />
      )}
      {editingItem && <ItemSheet item={editingItem} onClose={() => setEditing(null)} />}
      {resetting && <ResetSheet items={items} onClose={() => setResetting(false)} />}
    </div>
  );
}

/** 冷蔵庫を空にする(まちがえても「元に戻す」で戻せる) */
function ResetSheet({ items, onClose }: { items: Item[]; onClose: () => void }) {
  return (
    <Sheet
      title="全部リセットしますか?"
      onClose={onClose}
      footer={
        <button
          className="btn btn-danger"
          onClick={() => {
            const gone = items;
            removeItems(gone.map((i) => i.id));
            toast(`${gone.length}品を全部出しました`, { label: '元に戻す', run: () => restoreItems(gone) });
            onClose();
          }}
        >
          全部出す
        </button>
      }
    >
      <p className="hint">冷蔵庫の{items.length}品を、すべて出します。まちがえたときは、直後に出る「元に戻す」で戻せます。</p>
    </Sheet>
  );
}

// ───────── 足す ─────────

const TITLES: Record<AddMode, string> = { text: '書く・話す', picks: 'いつもの', receipt: 'レシートから', photo: '写真から' };

function AddSheet({ mode, shot, onClose, onRetake }: { mode: AddMode; shot: { file: File; kind: 'receipt' | 'photo' } | null; onClose: () => void; onRetake: () => void }) {
  const staples = useStore((s) => s.staples);
  const items = useStore((s) => s.items);
  const have = useMemo(() => new Set(items.map((i) => normName(i.name))), [items]);
  const [held, setHeld] = useState<NewItem[]>([]); // 写真に写っていたが、もう冷蔵庫にあるもの
  const [phase, setPhase] = useState<'input' | 'reading' | 'confirm' | 'error'>(mode === 'receipt' || mode === 'photo' ? 'reading' : 'input');
  const [text, setText] = useState('');
  const [found, setFound] = useState<NewItem[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<Record<string, string>>({}); // 押して入れたもの(名前 → 食材の ID)
  const [openRow, setOpenRow] = useState<number | null>(null);
  const run = useRef(0);

  // 写真が渡されたら、すぐ読み取りを始める
  useEffect(() => {
    if (!shot) return;
    const id = ++run.current;
    setPhase('reading');
    setPreview(null);
    (async () => {
      try {
        const img = await toJpeg(shot.file);
        if (id !== run.current) return;
        setPreview(img.preview);
        const read = await parse({ image: { data: img.data, mime: img.mime }, kind: shot.kind });
        if (id !== run.current) return;
        // 冷蔵庫の中を撮ったときは、もう入っているものまで二重に入らないよう外しておく
        const dup = shot.kind === 'photo' ? read.filter((r) => have.has(normName(r.name))) : [];
        setHeld(dup);
        setFound(read.filter((r) => !dup.includes(r)));
        setPhase('confirm');
      } catch (e) {
        if (id !== run.current) return;
        setError(e instanceof ApiError ? e.message : '写真を読み取れませんでした。もう一度撮ってみてください。');
        setPhase('error');
      }
    })();
    return () => {
      run.current++;
    };
  }, [shot]);

  const readText = async () => {
    const value = text.trim();
    if (!value) return;
    // 食材名だけが並んでいて、どれも知っているものなら、AI を呼ばずにすぐ出す
    const quick = quickParse(value, staples);
    if (quick) {
      setFound(quick);
      setPhase('confirm');
      return;
    }
    const id = ++run.current;
    setPhase('reading');
    try {
      const items = await parse({ text: value });
      if (id !== run.current) return;
      setFound(items);
      setPhase('confirm');
    } catch (e) {
      if (id !== run.current) return;
      setError(e instanceof ApiError ? e.message : 'うまく読み取れませんでした。もう一度お試しください。');
      setPhase('error');
    }
  };

  const commit = () => {
    addItems(found);
    toast(`${found.length}品を冷蔵庫に入れました`);
    onClose();
  };

  if (mode === 'picks') {
    const picks = quickPicks(staples);
    const count = Object.keys(added).length;
    return (
      <Sheet
        title="いつもの"
        onClose={onClose}
        footer={
          <button className="btn" onClick={onClose}>
            完了
          </button>
        }
      >
        <p className="hint">{count ? `${count}品を入れました。もう一度押すと取り消せます。` : '押すとすぐ冷蔵庫に入ります。よく買うものが、だんだんここに並びます。'}</p>
        <div className="picks">
          {picks.map((p) => {
            const id = added[p.name];
            return (
              <button
                key={p.name}
                className={`pick ${id ? 'pick-on' : ''}`}
                aria-pressed={!!id}
                onClick={() => {
                  if (id) {
                    // 押しまちがい:もう一度押すと取り消す
                    removeItems([id]);
                    setAdded(({ [p.name]: _gone, ...rest }) => rest);
                  } else {
                    const [newId] = addItems([p]);
                    setAdded((a) => ({ ...a, [p.name]: newId }));
                  }
                }}
              >
                {id && <Icon name="check" size={16} />}
                {p.name}
              </button>
            );
          })}
        </div>
      </Sheet>
    );
  }

  if (phase === 'input') {
    return (
      <Sheet
        title={TITLES[mode]}
        onClose={onClose}
        footer={
          <button className="btn" disabled={!text.trim()} onClick={readText}>
            読み取る
          </button>
        }
      >
        <textarea
          className="field"
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="卵と牛乳、あと豚こま買った"
          aria-label="買ってきたもの"
        />
        <p className="hint">ふだんの言葉のままで大丈夫です。キーボードのマイクで話しても入ります。</p>
      </Sheet>
    );
  }

  if (phase === 'reading') {
    return (
      <Sheet title={TITLES[mode]} onClose={onClose}>
        {preview && <img className="shot" src={preview} alt="撮った写真" />}
        <div className="reading" role="status">
          <span className="pulse" />
          読み取っています
        </div>
        <ul className="rows" aria-hidden="true">
          {[72, 54, 64].map((w) => (
            <li key={w} className="row row-skel">
              <span className="skel" style={{ width: `${w}%` }} />
            </li>
          ))}
        </ul>
      </Sheet>
    );
  }

  if (phase === 'error') {
    return (
      <Sheet
        title={TITLES[mode]}
        onClose={onClose}
        footer={
          mode === 'text' ? (
            <button className="btn" onClick={() => setPhase('input')}>
              書き直す
            </button>
          ) : (
            <button className="btn" onClick={onRetake}>
              もう一度撮る
            </button>
          )
        }
      >
        <p className="problem">{error}</p>
      </Sheet>
    );
  }

  // 確認
  return (
    <Sheet
      title={found.length ? `${found.length}品を見つけました` : held.length ? '新しいものはありません' : '見つかりませんでした'}
      onClose={onClose}
      footer={
        found.length ? (
          <button className="btn" onClick={commit}>
            {found.length}品を冷蔵庫に入れる
          </button>
        ) : mode === 'text' ? (
          <button className="btn" onClick={() => setPhase('input')}>
            書き直す
          </button>
        ) : (
          <button className="btn" onClick={onRetake}>
            もう一度撮る
          </button>
        )
      }
    >
      {held.length > 0 && (
        <p className="held">
          冷蔵庫にもうある{held.length}品({held.map((h) => h.name).join('・')})は入れていません。
          <button
            onClick={() => {
              setFound((l) => [...l, ...held]);
              setHeld([]);
            }}
          >
            この{held.length}品も入れる
          </button>
        </p>
      )}
      {found.length === 0 && held.length > 0 ? null : found.length === 0 ? (
        <p className="problem">食材を読み取れませんでした。{mode === 'text' ? '食材の名前を入れてみてください。' : '明るいところで、全体が入るように撮ってみてください。'}</p>
      ) : (
        <>
          <p className="hint">数字は日持ちの目安です(押すと直せます)。ちがうものは × で外せます。</p>
          <ul className="rows">
            {found.map((f, idx) => (
              <li key={`${f.name}-${idx}`} className={`row row-edit ${openRow === idx ? 'open' : ''}`}>
                <span className="row-name">
                  {f.name}
                  {have.has(normName(f.name)) && <small className="dup">冷蔵庫にもあります</small>}
                </span>
                <span className="mini-step">
                  <button className="mini-btn" aria-label={`${f.name}の日数を減らす`} disabled={f.days <= 1} onClick={() => setFound((l) => l.map((x, i) => (i === idx ? { ...x, days: Math.max(1, x.days - 1) } : x)))}>
                    <Icon name="minus" size={16} />
                  </button>
                  <button className="mini-value" aria-label={`${f.name}の日数を直す`} aria-expanded={openRow === idx} onClick={() => setOpenRow(openRow === idx ? null : idx)}>
                    <b>{f.days}</b>日
                  </button>
                  <button className="mini-btn" aria-label={`${f.name}の日数を増やす`} onClick={() => setFound((l) => l.map((x, i) => (i === idx ? { ...x, days: Math.min(365, x.days + 1) } : x)))}>
                    <Icon name="plus" size={16} />
                  </button>
                </span>
                <button
                  className="row-x"
                  aria-label={`${f.name}を外す`}
                  onClick={() => {
                    setOpenRow(null);
                    setFound((l) => l.filter((_, i) => i !== idx));
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </li>
            ))}
          </ul>
          <AddOne
            onAdd={(name) => {
              if (found.some((f) => f.name === name)) return;
              setFound((l) => [...l, lookup(name, staples) ?? { name, category: 'その他', days: 5 }]);
            }}
          />
        </>
      )}
    </Sheet>
  );
}

/** 読み取りからもれたものを、1つ足す */
function AddOne({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  const submit = () => {
    const v = name.trim().slice(0, 30);
    if (!v) return;
    onAdd(v);
    setName('');
  };
  return (
    <form
      className="add-one"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="ほかの食材を足す" aria-label="ほかの食材を足す" enterKeyHint="done" />
      <button type="submit" className="round" aria-label="足す" disabled={!name.trim()}>
        <Icon name="plus" size={20} />
      </button>
    </form>
  );
}

// ───────── 1つを直す ─────────

function ItemSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const all = useStore((s) => s.items);
  // 一覧で1つにまとめて見せている、同じ名前・同じ期限の分もまとめて扱う
  const mates = all.filter((i) => normName(i.name) === normName(item.name) && i.expiresOn === item.expiresOn);
  const count = Math.max(1, mates.length);
  const days = Math.max(0, daysLeft(item));
  const quick: [string, number][] = [
    ['今日', 0],
    ['3日', 3],
    ['1週間', 7],
    ['2週間', 14],
  ];
  const useAll = () => {
    const gone = mates.length ? mates : [item];
    removeItems(gone.map((i) => i.id));
    toast(`${item.name}を使い切りました`, { label: '元に戻す', run: () => restoreItems(gone) });
    onClose();
  };
  const useHalf = () => {
    // 量そのものは管理していないので、1つだけのときは「半分残っている」扱いで残す。
    // 2つ以上あるときは、半分の個数を出す
    if (count <= 1) {
      toast(`${item.name}は半分残っているので、そのままにしておきます`);
      onClose();
      return;
    }
    const n = Math.max(1, Math.round(count / 2));
    const gone = mates.slice(0, n);
    removeItems(gone.map((i) => i.id));
    toast(`${item.name}を半分使いました(残り${count - n}つ)`, { label: '元に戻す', run: () => restoreItems(gone) });
    onClose();
  };
  return (
    <Sheet
      title={count > 1 ? `${item.name} ×${count}` : item.name}
      onClose={onClose}
      footer={
        <button
          className="btn btn-line"
          onClick={() => {
            removeItems([item.id]);
            toast(`${item.name}を出しました`, { label: '元に戻す', run: () => restoreItems([item]) });
            onClose();
          }}
        >
          冷蔵庫から出す
        </button>
      }
    >
      <p className="hint">おいしく食べられる日数の目安です。</p>
      <Stepper value={days} min={0} max={365} label="残りの日数" unit="日" onChange={(v) => setDays(item.id, v)} />
      <div className="picks picks-center">
        {quick.map(([label, d]) => (
          <button key={label} className={`pick ${days === d ? 'pick-on' : ''}`} onClick={() => setDays(item.id, d)}>
            {label}
          </button>
        ))}
      </div>
      <h3 className="sheet-sub">使ったとき</h3>
      <div className="use-row">
        <button className="btn btn-line" onClick={useHalf}>
          半分使った
        </button>
        <button className="btn" onClick={useAll}>
          全部使った
        </button>
      </div>
      <p className="hint">{count > 1 ? `同じものが${count}つあるので、「全部使った」で${count}つとも出します。` : '半分使ったときは、残り半分としてそのまま残ります。'}</p>
    </Sheet>
  );
}
