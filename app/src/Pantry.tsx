// 調味料の画面:「いつも家にある」前提にしてきた調味料を、在庫と賞味期限で管理する。
// デフォルトは基本の調味料が全部「ある・賞味期限なし」で並ぶ。切らしたら「切らしてる」にすると、
// レシピでは買い足し扱いになる(サーバー側の対応は次のデプロイから)。
import { useRef, useState } from 'react';
import { addDays, daysBetween, normName, PANTRY, todayJst } from '../../supabase/functions/api/core.ts';
import { setPantry, toast, useStore } from './store.ts';
import type { Seasoning } from './store.ts';
import { Icon, Sheet, Stepper } from './ui.tsx';

function expiryText(p: Seasoning): { text: string; hot: boolean } {
  if (!p.expiresOn) return { text: '賞味期限なし', hot: false };
  const left = daysBetween(todayJst(), p.expiresOn);
  const [, m, d] = p.expiresOn.split('-');
  if (left < 0) return { text: `賞味期限 ${Number(m)}月${Number(d)}日(期限切れ)`, hot: true };
  return { text: `賞味期限 ${Number(m)}月${Number(d)}日まで`, hot: left <= 30 };
}

export function Pantry() {
  const pantry = useStore((s) => s.pantry);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const missing = PANTRY.filter((name) => !pantry.some((p) => normName(p.name) === normName(name)));
  const editingItem = editing ? pantry.find((p) => p.name === editing) : undefined;

  const toggleOut = (name: string) => {
    setPantry(pantry.map((p) => (p.name === name ? { ...p, out: !p.out } : p)));
  };
  const addName = (raw: string) => {
    const name = raw.trim();
    if (!name) {
      // 空のまま押したときは、入力欄にフォーカスして「まず名前を入れる」ことが分かるようにする
      addInputRef.current?.focus();
      return;
    }
    if (pantry.some((p) => normName(p.name) === normName(name))) {
      toast(`「${name}」はもう一覧にあります`);
      return;
    }
    setPantry([...pantry, { name, out: false, expiresOn: null }]);
    setAdding('');
  };

  return (
    <div className="screen">
      <header className="title-row">
        <h1>調味料</h1>
      </header>
      <p className="lede">レシピは「家にある」前提で考えています。切らしたら「切らしてる」にしてください。</p>

      <div className="pantry-add">
        <input
          ref={addInputRef}
          className="field"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addName(adding);
          }}
          placeholder="調味料を足す(例:ラー油)"
          aria-label="足す調味料の名前"
        />
        <button className="btn btn-sub" onClick={() => addName(adding)}>
          足す
        </button>
      </div>

      {missing.length > 0 && (
        <div className="chips" aria-label="基本の調味料を戻す">
          {missing.map((name) => (
            <button key={name} className="chip" onClick={() => addName(name)}>
              <Icon name="plus" size={14} />
              {name}
            </button>
          ))}
        </div>
      )}

      <ul className="rows pantry-rows">
        {pantry.map((p) => {
          const exp = expiryText(p);
          return (
            <li key={p.name}>
              <div className="row pantry-row" onClick={() => setEditing(p.name)}>
                <span className="row-main">
                  <span className="row-name">{p.name}</span>
                  <span className={`pantry-sub ${exp.hot ? 'hot' : ''}`}>{exp.text}</span>
                </span>
                <button
                  className={`stock ${p.out ? 'out' : ''}`}
                  aria-label={`${p.name}を${p.out ? 'あるにする' : '切らしてるにする'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOut(p.name);
                  }}
                >
                  {p.out ? '切らしてる' : 'ある'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {editingItem && <PantrySheet item={editingItem} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PantrySheet({ item, onClose }: { item: Seasoning; onClose: () => void }) {
  const pantry = useStore((s) => s.pantry);
  const cur = pantry.find((p) => p.name === item.name) ?? item;
  const today = todayJst();
  const days = cur.expiresOn ? Math.max(0, Math.min(365, daysBetween(today, cur.expiresOn))) : 180;

  const replace = (next: Seasoning) => setPantry(pantry.map((p) => (p.name === cur.name ? next : p)));
  const remove = () => {
    const prev = pantry;
    setPantry(pantry.filter((p) => p.name !== cur.name));
    toast(`「${cur.name}」を一覧から消しました`, { label: '元に戻す', run: () => setPantry(prev) });
    onClose();
  };

  return (
    <Sheet
      title={cur.name}
      onClose={onClose}
      footer={
        <button className="btn btn-line" onClick={remove}>
          一覧から消す
        </button>
      }
    >
      <div className="sheet-row">
        <span>在庫</span>
        <button className={`stock ${cur.out ? 'out' : ''}`} onClick={() => replace({ ...cur, out: !cur.out })}>
          {cur.out ? '切らしてる' : 'ある'}
        </button>
      </div>

      <h3 className="sheet-sub">賞味期限</h3>
      <div className="sheet-row">
        <span>{cur.expiresOn ? `${cur.expiresOn.replace(/-/g, '/')} まで` : '設定なし(表示しっぱなし)'}</span>
        {cur.expiresOn ? (
          <button className="sec-link" onClick={() => replace({ ...cur, expiresOn: null })}>
            なしに戻す
          </button>
        ) : (
          <button className="sec-link" onClick={() => replace({ ...cur, expiresOn: addDays(today, days) })}>
            設定する
          </button>
        )}
      </div>
      {cur.expiresOn && (
        <Stepper label="賞味期限までの日数" unit="日" min={0} max={365} value={days} onChange={(v) => replace({ ...cur, expiresOn: addDays(today, v) })} />
      )}
    </Sheet>
  );
}
