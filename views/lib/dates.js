// Helpers de data da view.
//
// Regra do pacote: o banco é UTC; a view é o lugar onde se converte para o fuso
// local. Todo `Date` aqui é interpretado em horário local, e só vira ISO
// absoluto (com Z) na hora de falar com a API.

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = n => String(n).padStart(2, '0');

// Só a primeira letra — `text-transform: capitalize` no CSS transformaria
// também as preposições ("Julho De 2026").
const upperFirst = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Chave local YYYY-MM-DD — usada para agrupar eventos por dia sem passar por UTC. */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function sameDay(a, b) {
  return dayKey(a) === dayKey(b);
}

/** As 6 semanas (42 células) que a grade mensal mostra, começando no domingo. */
export function monthGrid(reference) {
  const first = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Domingo da semana de `reference`. */
export function startOfWeek(reference) {
  const d = startOfDay(reference);
  return addDays(d, -d.getDay());
}

/** Os 7 dias da semana de `reference`. */
export function weekGrid(reference) {
  const start = startOfWeek(reference);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * Janela [from, to) que a visão precisa carregar, em ISO absoluto.
 * Uma função só para os três modos: é ela que garante que a consulta ao
 * servidor cubra exatamente o que a tela desenha — inclusive as células de
 * transbordo da grade mensal, que mostram dias dos meses vizinhos.
 */
export function rangeFor(mode, cursor) {
  if (mode === 'day') {
    const start = startOfDay(cursor);
    return { from: start.toISOString(), to: addDays(start, 1).toISOString() };
  }
  if (mode === 'week') {
    const start = startOfWeek(cursor);
    return { from: start.toISOString(), to: addDays(start, 7).toISOString() };
  }
  const cells = monthGrid(cursor);
  return {
    from: startOfDay(cells[0]).toISOString(),
    to: addDays(startOfDay(cells[cells.length - 1]), 1).toISOString(),
  };
}

export function weekLabel(reference) {
  const days = weekGrid(reference);
  const a = days[0];
  const b = days[6];
  const left = `${MONTHS[a.getMonth()]} ${a.getDate()}`;
  const right = `${MONTHS[b.getMonth()]} ${b.getDate()}`;
  const year = a.getFullYear() === b.getFullYear() ? a.getFullYear() : `${a.getFullYear()}/${b.getFullYear()}`;
  return upperFirst(`${left} – ${right}, ${year}`);
}

/** Valor de um <input type="datetime-local"> a partir de um ISO do servidor. */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Valor do <input type="date"> (dia inteiro). */
export function toDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dayKey(d);
}

/** Input local → instante absoluto ISO-8601, do jeito que a API espera. */
export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDayLabel(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Rótulo curto para a lista de próximos eventos ("qui, 30/07"). */
export function formatShortDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${WEEKDAYS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

export function monthLabel(date) {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}
