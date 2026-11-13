// packages/agenda/lib/recurrence.js
//
// Expansão de eventos recorrentes. A regra é a ÚNICA coisa persistida — nenhuma
// ocorrência vira linha no banco. Motivos, nessa ordem de importância:
//   - editar/cancelar a série inteira é um UPDATE só;
//   - "pular esta ocorrência" é um append em `exdates`, sem apagar nada;
//   - uma regra diária sem fim não gera linhas infinitas.
// O preço é que toda consulta por intervalo tem de expandir em memória — daí o
// MAX_OCCURRENCES, que existe para que uma janela absurda (ou uma regra diária
// sem recurrenceUntil) degrade em resultado truncado, nunca em travamento.
//
// FUSO: o passo de dia/semana/mês é dado sobre os COMPONENTES LOCAIS da data
// (getFullYear/getDate/setDate), não somando 24h em ms. É o que mantém "toda
// terça às 14h" às 14h depois de uma virada de horário de verão — somar
// 86400000 ms deslocaria o horário em uma hora. Alinhado com a dívida de fuso
// já registrada no pacote: o fuso de referência é o do runtime.

export const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'];

// Teto por consulta. 500 cobre "todo dia por um ano" (365) com folga; acima
// disso a resposta vem truncada e sinalizada em vez de crescer sem limite.
export const MAX_OCCURRENCES = 500;

/** Normaliza o campo `recurrence`. Valor desconhecido vira 'none' (nunca lança:
 *  uma regra inválida não pode derrubar a listagem inteira da agenda). */
export function normalizeRecurrence(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return RECURRENCES.includes(v) ? v : 'none';
}

export function isRecurring(value) {
  const v = normalizeRecurrence(value);
  return v !== 'none';
}

/* ── exdates ──
 * Persistidas como JSON array de ISO-8601 (o instante de INÍCIO da ocorrência
 * pulada). Comparação por timestamp, não por string: o mesmo instante escrito
 * com offset diferente ("...T14:00:00-03:00" vs "...T17:00:00Z") tem de casar. */

export function parseExdates(raw) {
  if (!raw) return [];
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map(v => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); })
    .filter(Boolean);
}

export function serializeExdates(list) {
  const clean = [...new Set(parseExdates(list))].sort();
  return clean.length ? JSON.stringify(clean) : null;
}

/* ── Passo da regra ──
 * `index` é o número da ocorrência (0 = a original). O passo mensal é calculado
 * a partir da data BASE, nunca acumulando sobre a ocorrência anterior: somar
 * "+1 mês" doze vezes a partir de 31/jan derivaria para 28/fev e ficaria preso
 * lá; a partir da base, cada ocorrência é (mês da base + index). */
function occurrenceStart(base, rule, index) {
  const d = new Date(base);
  if (rule === 'daily') d.setDate(d.getDate() + index);
  else if (rule === 'weekly') d.setDate(d.getDate() + index * 7);
  else if (rule === 'monthly') {
    const target = base.getMonth() + index;
    d.setFullYear(base.getFullYear(), target, 1);   // dia 1 evita o overflow do set
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    // Mês curto: 31/jan mensal NÃO vira 3/mar (overflow) nem 28/fev (clamp
    // silencioso, que duplicaria a data em fevereiro). A ocorrência
    // simplesmente não existe nesse mês — mesma decisão do BYMONTHDAY do RRULE.
    if (base.getDate() > lastDay) return null;
    d.setDate(base.getDate());
  }
  return d;
}

/**
 * Expande um evento dentro de [from, to].
 *
 * Devolve ocorrências no formato { start: Date, end: Date|null, index }. Evento
 * não recorrente devolve no máximo uma. A janela é testada contra o INTERVALO
 * da ocorrência (start..end), não só contra o start: um evento que começou
 * ontem às 23h e termina hoje à 1h precisa aparecer na consulta de hoje.
 *
 * @param {{startAt: Date|string, endAt?: Date|string|null, recurrence?: string,
 *          recurrenceUntil?: Date|string|null, exdates?: string|string[]|null}} event
 * @param {Date|string} from
 * @param {Date|string} to
 */
export function expandEvent(event, from, to) {
  const baseStart = event.startAt instanceof Date ? event.startAt : new Date(event.startAt);
  if (Number.isNaN(baseStart?.getTime?.())) return [];

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return [];

  const baseEnd = event.endAt ? new Date(event.endAt) : null;
  // Duração é preservada de ocorrência para ocorrência; sem fim, trata como
  // instantânea para efeito de sobreposição com a janela.
  const durationMs = baseEnd && !Number.isNaN(baseEnd.getTime())
    ? Math.max(0, baseEnd.getTime() - baseStart.getTime())
    : 0;

  const rule = normalizeRecurrence(event.recurrence);
  const overlaps = (startMs) => startMs + durationMs >= fromMs && startMs <= toMs;

  if (rule === 'none') {
    return overlaps(baseStart.getTime())
      ? [{ start: baseStart, end: baseEnd, index: 0 }]
      : [];
  }

  const untilMs = event.recurrenceUntil ? new Date(event.recurrenceUntil).getTime() : null;
  const hardStop = Number.isFinite(untilMs) ? Math.min(toMs, untilMs) : toMs;
  const skip = new Set(parseExdates(event.exdates).map(iso => Date.parse(iso)));

  const out = [];
  // Teto de iterações independente do teto de resultados: o passo mensal pode
  // devolver null (mês curto) e a janela pode começar bem depois da base, então
  // muitos índices são examinados sem produzir ocorrência.
  const maxIterations = MAX_OCCURRENCES * 12;

  for (let i = 0; i < maxIterations && out.length < MAX_OCCURRENCES; i++) {
    const start = occurrenceStart(baseStart, rule, i);
    if (!start) continue;                 // mês sem esse dia
    const startMs = start.getTime();
    if (startMs > hardStop) break;        // passou da janela / do fim da série
    if (startMs + durationMs < fromMs) continue;  // ainda antes da janela
    if (skip.has(startMs)) continue;      // ocorrência pulada
    out.push({
      start,
      end: durationMs ? new Date(startMs + durationMs) : null,
      index: i,
    });
  }
  return out;
}

/** ID estável de uma ocorrência: `<eventId>@<ISO do início>`. Determinístico,
 *  então a view pode usá-lo como chave de lista e o cliente pode devolvê-lo
 *  para pular exatamente aquela data. */
export function occurrenceId(eventId, start) {
  return `${eventId}@${new Date(start).toISOString()}`;
}

/** Inverso de occurrenceId. Aceita também um id cru (evento não recorrente). */
export function parseOccurrenceId(id) {
  const raw = String(id ?? '');
  const at = raw.lastIndexOf('@');
  if (at === -1) return { eventId: raw, occurrenceStart: null };
  const iso = raw.slice(at + 1);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { eventId: raw, occurrenceStart: null };
  return { eventId: raw.slice(0, at), occurrenceStart: new Date(ms).toISOString() };
}
