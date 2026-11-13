// Theme sync helper for views outside Agent's .shell (mesma situação de
// packages/tasks e packages/terminal — ver apps/thinkiac/AGENTS.md).
// A fonte de verdade continua sendo localStorage['agent:theme'], escrita pelo
// setTheme() de packages/agent/views/theme.js; este módulo só lê e notifica,
// já que a view abre no próprio iframe (window/document próprios) e precisa da
// sua própria assinatura de sincronização ao vivo.

const KEY = 'agent:theme';

export function getTheme() {
  if (typeof window === 'undefined') return 'dark';
  try {
    const saved = window.localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  } catch {
    return 'dark';
  }
}

export function onThemeChange(callback) {
  if (typeof window === 'undefined') return () => {};
  function handler(event) {
    if (event.key === KEY) callback(event.newValue === 'light' ? 'light' : 'dark');
  }
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
