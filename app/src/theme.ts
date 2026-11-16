// 画面の明るさ。いつもはライトで、設定からダークに切り替えられる(端末ごとに覚える)。
// 最初の色は index.html の小さなスクリプトが先に決める(開いた瞬間にちらつかないように)。
export type Theme = 'light' | 'dark';
const KEY = 'refrichrator:theme';
const BAR: Record<Theme, string> = { light: '#faf8f2', dark: '#06110c' };

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // 保存できなくても、今の画面には反映する
  }
  applyTheme(t);
}
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[t]);
}
