// Wrapper de fetch da view da agenda.
//
// ESM obrigatório (`export function`): helpers .js first-party sob views/ são
// bundlados pelo esbuild, e um `module.exports=` seria hoisted para o topo,
// clobbando o export do componente.

const BASE = '/calendar';

class SessionExpiredError extends Error {
  constructor() {
    super('Session expired. Reload and sign in again.');
    this.name = 'SessionExpiredError';
  }
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Sem sessão o accessGate responde 302 para /view/auth/Login, não 401: o fetch
  // segue o redirect e devolve HTML, e um res.json() aqui estouraria com um erro
  // de parse enganoso. Detecta e reporta como sessão expirada.
  if (res.redirected || (res.headers.get('content-type') || '').includes('text/html')) {
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try { message = JSON.parse(text).error ?? JSON.parse(text).message ?? text; } catch {}
    throw new Error(message || `Error ${res.status}`);
  }
  // O runtime já desembrulha o `{ data }` que as rotas retornam — o corpo é o
  // objeto/array direto.
  return res.json();
}

export const listEvents = (from, to) =>
  req('GET', `/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
// Pula uma ocorrência de série. `id` é o id da ocorrência ("<eventId>@<ISO>"),
// que vai no body — ele contém "@" e ":", que não sobreviveriam bem na URL.
export const skipOccurrence = id => req('POST', '/skip-occurrence', { id });
export const getEvent = id => req('GET', `/events/${id}`);
export const createEvent = data => req('POST', '/events', data);
export const updateEvent = (id, changes) => req('PATCH', `/events/${id}`, changes);
export const deleteEvent = id => req('DELETE', `/events/${id}`);
export const createEventFromText = text => req('POST', '/create-from-text', { text });
export const listCalendars = () => req('GET', '/calendars');
