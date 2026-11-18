// 調味料の画面:「いつも家にある」前提にしてきた調味料を、在庫と賞味期限で管理する。
// デフォルトは基本の調味料が全部「ある・賞味期限なし」で並ぶ。切らしたら「切らしてる」にすると、
// レシピでは買い足し扱いになる(サーバー側の対応は次のデプロイから)。
// 追加は「調味料を足す」ボタンから入力シートを開いて行う。
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
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const missing = PANTRY.filter((name) => !pantry.some((p) => normName(p.name) === normName(name)));
  const editingItem = editing ? pantry.find((p) => p.name === editing) : undefined;

  const toggleOut = (name: string) => {
    setPantry(pantry.map((p) => (p.name === name ? { ...p, out: !p.out } : p)));
  };
  const addQuick = (name: string) => {
    // 消した基本の調味料を戻すとき用(初期状態でそのまま足す)
    setPantry([...pantry, { name, out: false, expiresOn: null }]);
  };

  // 並べ替え:左の三本線(グリップ)を掴んで上下にドラッグする
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragDy, setDragDy] = useState(0);
  const dragRef = useRef<{ startY: number; step: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const rowH = dragRef.current?.step ?? 0;
  const targetIdx =
    dragIdx === null || !rowH ? null : Math.max(0, Math.min(pantry.length - 1, dragIdx + Math.round(dragDy / rowH)));

  const onGripDown = (e: React.PointerEvent, idx: number) => {
    const li = (e.currentTarget as HTMLElement).closest('li');
    const next = li?.nextElementSibling as HTMLElement | null;
    const step = li ? (next ? next.offsetTop - li.offsetTop : li.offsetHeight) : 0;
    dragRef.current = { startY: e.clientY, step: step || 57, moved: false };
    setDragIdx(idx);
    setDragDy(0);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // つかめなくても、動き自体は続ける
    }
  };
  const onGripMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || dragIdx === null) return;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 6) d.moved = true;
    setDragDy(dy);
  };
  const onGripUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (dragIdx !== null && targetIdx !== null && targetIdx !== dragIdx) {
      const next = [...pantry];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(targetIdx, 0, moved);
      setPantry(next);
    }
    if (d?.moved) suppressClickRef.current = true;
    setDragIdx(null);
    setDragDy(0);
  };
  const onGripCancel = () => {
    dragRef.current = null;
    setDragIdx(null);
    setDragDy(0);
  };

  return (
    <div className="screen">
      <header className="title-row">
        <h1>調味料</h1>
      </header>
      <p className="lede">レシピは「家にある」前提で考えています。切らしたら「切らしてる」にしてください。</p>

      <button className="btn btn-primary pantry-add-open" onClick={() => setAddOpen(true)}>
        <Icon name="plus" size={18} />
        調味料を足す
      </button>

      {missing.length > 0 && (
        <div className="chips" aria-label="基本の調味料を戻す">
          {missing.map((name) => (
            <button key={name} className="chip" onClick={() => addQuick(name)}>
              <Icon name="plus" size={14} />
              {name}
            </button>
          ))}
        </div>
      )}

      <ul className={`rows pantry-rows ${dragIdx !== null ? 'drag-active' : ''}`}>
        {pantry.map((p, i) => {
          const exp = expiryText(p);
          let transform: string | undefined;
          if (dragIdx !== null && targetIdx !== null && rowH) {
            if (i === dragIdx) transform = `translateY(${dragDy}px)`;
            else if (dragIdx < targetIdx && i > dragIdx && i <= targetIdx) transform = `translateY(${-rowH}px)`;
            else if (dragIdx > targetIdx && i < dragIdx && i >= targetIdx) transform = `translateY(${rowH}px)`;
          }
          return (
            <li key={p.name} className={i === dragIdx ? 'dragging' : ''} style={transform ? { transform } : undefined}>
              <div
                className="row pantry-row"
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  setEditing(p.name);
                }}
              >
                <span
                  className="grip"
                  role="button"
                  aria-label={`${p.name}を並べ替え`}
                  onPointerDown={(e) => onGripDown(e, i)}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={onGripCancel}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon name="grip" size={20} />
                </span>
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

      {addOpen && <AddSheet onClose={() => setAddOpen(false)} />}
      {editingItem && <PantrySheet item={editingItem} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** 調味料を足す入力シート:名前・在庫・賞味期限をまとめて入れる */
function AddSheet({ onClose }: { onClose: () => void }) {
  const pantry = useStore((s) => s.pantry);
  const [name, setName] = useState('');
  const [out, setOut] = useState(false);
  const [hasExp, setHasExp] = useState(false);
  const [days, setDays] = useState(180);
  const nameRef = useRef<HTMLInputElement>(null);

  const add = () => {
    const n = name.trim();
    if (!n) {
      // 空のまま押したときは、名前の入力欄にフォーカスして分かるようにする
      nameRef.current?.focus();
      return;
    }
    if (pantry.some((p) => normName(p.name) === normName(n))) {
      toast(`「${n}」はもう一覧にあります`);
      return;
    }
    setPantry([...pantry, { name: n, out, expiresOn: hasExp ? addDays(todayJst(), days) : null }]);
    onClose();
  };

  return (
    <Sheet
      title="調味料を足す"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={add}>
          追加する
        </button>
      }
    >
      <input
        ref={nameRef}
        className="field"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
        }}
        placeholder="名前(例:ラー油)"
        aria-label="調味料の名前"
      />
      <div className="sheet-row">
        <span>在庫</span>
        <button className={`stock ${out ? 'out' : ''}`} onClick={() => setOut((v) => !v)}>
          {out ? '切らしてる' : 'ある'}
        </button>
      </div>
      <div className="sheet-row">
        <span>賞味期限</span>
        {hasExp ? (
          <button className="sec-link" onClick={() => setHasExp(false)}>
            なしに戻す
          </button>
        ) : (
          <button className="sec-link" onClick={() => setHasExp(true)}>
            設定する
          </button>
        )}
      </div>
      {hasExp && <Stepper label="賞味期限までの日数" unit="日" min={0} max={365} value={days} onChange={setDays} />}
    </Sheet>
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
