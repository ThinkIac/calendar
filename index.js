// packages/calendar/index.js
// Event-driven calendar.
//
// Three layers:
//   handle*        → CRUD and calendar:* events
//   router*        → thin HTTP routes
//   calendar_*     → MCP tools
//
// The 60s tick (scanCalendar) emits calendar:reminder_due and calendar:started.
// Events are the integration contract.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProxy, dispatchEvent } from 'logos';
import { runAgentTask } from '../agent/host/logos/index.js';
import {
  RECURRENCES, normalizeRecurrence, isRecurring, expandEvent,
  parseExdates, serializeExdates, occurrenceId, parseOccurrenceId,
} from './lib/recurrence.js';
import { notifyReminder, syncReminderCron, removeReminderCron } from './lib/reminders.js';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

/* Estado vivo do processo POR DIRETÓRIO do pacote. Uma cópia desta pasta dentro
 * de packages/ (agenda.bak, agenda2…) também é escaneada e re-executada pelo
 * runtime; com chave global compartilhada ela daria clearInterval no tick do
 * pacote real e os lembretes morreriam em silêncio — foi exatamente o bug do
 * flows corrigido em a22c75b. Nunca usar `let timer = null` no escopo do módulo:
 * este arquivo é reexecutado várias vezes no mesmo processo. */
const STATE_KEY = (name) => `__calendar:${name}:${PKG_DIR}`;
const TICK = (globalThis[STATE_KEY('tick')] ||= { interval: null });

const DEFAULT_CALENDAR = { name: 'Personal', color: '#38bdf8' };
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const STATUSES = ['confirmed', 'cancelled'];

/* ───────── Seed (idempotente) ───────── */

let _seeded = false;

async function ensureSeeded() {
  if (_seeded) return;
  const db = getProxy('calendar');
  if (db.calendar.query({}).length === 0) {
    await db.calendar.push({ name: DEFAULT_CALENDAR.name, color: DEFAULT_CALENDAR.color });
  }
  _seeded = true;
}

function defaultCalendarId() {
  const db = getProxy('calendar');
  return db.calendar.query({}, { sort: 'createdAt ASC', limit: 1 })[0]?.id ?? null;
}

/* ───────── Normalização ─────────
 * Tudo que entra passa por aqui antes do push/set. Dois motivos concretos:
 *  - push() preenche campo obrigatório ausente com "" e o DateTime aceita ""
 *    sem erro: push({ title }) criaria um evento com startAt = "", invisível a
 *    qualquer range query e incapaz de disparar lembrete. Validar é obrigatório.
 *  - data inválida (e não-vazia) faz o Scriba lançar um erro cru, que vazaria
 *    para a API/tool.
 */

function toIso(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}: ${value}`);
  return date.toISOString();
}

// tags trafegam como array na API e vivem como CSV no banco (Scriba não tem String[]).
function tagsToCsv(value) {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const clean = list.map(t => String(t).trim()).filter(Boolean);
  return clean.length ? clean.join(',') : null;
}

function tagsToArray(csv) {
  if (!csv) return [];
  return String(csv).split(',').map(t => t.trim()).filter(Boolean);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return !['false', '0', 'no', ''].includes(value.toLowerCase());
  return Boolean(value);
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toStatus(value, fallback = 'confirmed') {
  const v = String(value ?? '').trim().toLowerCase();
  return STATUSES.includes(v) ? v : fallback;
}

/* Preenche os defaults que o schema.prisma NÃO aplica (§ comentário do schema)
 * e valida o que não pode passar. Caminho único do CRUD via tool e via HTTP. */
function withDefaults(data = {}) {
  const title = String(data.title ?? '').trim();
  if (!title) throw new Error('title is required');

  const startAt = toIso(data.startAt, 'startAt');
  if (!startAt) throw new Error('startAt is required (ISO-8601 date/time)');

  const allDay = toBool(data.allDay, false);
  let endAt = toIso(data.endAt, 'endAt');
  // Sem fim explícito: dia inteiro não tem duração; com hora marcada, +1h.
  if (!endAt && !allDay) endAt = new Date(Date.parse(startAt) + DEFAULT_DURATION_MS).toISOString();
  if (endAt && Date.parse(endAt) < Date.parse(startAt)) throw new Error('endAt cannot be before startAt');

  return {
    calendarId: data.calendarId || defaultCalendarId(),
    title,
    description: data.description ?? null,
    startAt,
    endAt,
    allDay,
    location: data.location ?? null,
    recurrence: normalizeRecurrence(data.recurrence),
    recurrenceUntil: toIso(data.recurrenceUntil, 'recurrenceUntil'),
    exdates: serializeExdates(data.exdates),
    reminderMinutes: toIntOrNull(data.reminderMinutes),
    reminderFiredAt: null,
    startedNotifiedAt: null,
    tags: tagsToCsv(data.tags),
    source: String(data.source ?? '').trim() || 'manual',
    externalId: data.externalId ?? null,
    status: toStatus(data.status),
  };
}

/* ───────── Serialização ─────────
 * A leitura do RecordProxy é tipada: startAt volta como Date, allDay como
 * Boolean. O payload dos eventos de domínio precisa ser PLANO e estável — é ele
 * que o tap do flows absorve e vira o contrato exposto na UI de gatilhos. */

function eventPayload(ev) {
  return {
    id: ev.id,
    title: ev.title,
    startAt: ev.startAt?.toISOString?.() ?? null,
    endAt: ev.endAt?.toISOString?.() ?? null,
    allDay: !!ev.allDay,
    calendarId: ev.calendarId ?? null,
    tags: tagsToArray(ev.tags),
    status: ev.status || 'confirmed',
    recurrence: normalizeRecurrence(ev.recurrence),
  };
}

function serialize(ev) {
  const out = {
    ...eventPayload(ev),
    description: ev.description ?? null,
    location: ev.location ?? null,
    recurrenceUntil: ev.recurrenceUntil ?? null,
    exdates: parseExdates(ev.exdates),
    reminderMinutes: ev.reminderMinutes ?? null,
    source: ev.source || 'manual',
    externalId: ev.externalId ?? null,
    createdAt: ev.createdAt ?? null,
    updatedAt: ev.updatedAt ?? null,
  };
  // Ocorrência expandida de uma série: `id` é o id da OCORRÊNCIA
  // (`<eventId>@<ISO>`), estável e devolvível para pular exatamente esta data;
  // `seriesId` é a linha real no banco, que é o que update/delete recebem.
  if (ev.seriesId) {
    out.seriesId = ev.seriesId;
    out.isOccurrence = true;
  }
  return out;
}

/* Snapshot plano de uma ocorrência expandida. Precisa ter a mesma FORMA de um
 * RecordProxy (startAt/endAt como Date, tags em CSV) porque serialize() e o
 * formatador do listEvents são compartilhados com o caminho não recorrente. */
function toOccurrence(ev, occ) {
  return {
    id: occurrenceId(ev.id, occ.start),
    seriesId: ev.id,
    calendarId: ev.calendarId ?? null,
    title: ev.title,
    description: ev.description ?? null,
    startAt: occ.start,
    endAt: occ.end,
    allDay: !!ev.allDay,
    location: ev.location ?? null,
    recurrence: normalizeRecurrence(ev.recurrence),
    recurrenceUntil: ev.recurrenceUntil ?? null,
    exdates: ev.exdates ?? null,
    reminderMinutes: ev.reminderMinutes ?? null,
    tags: ev.tags ?? null,
    source: ev.source || 'manual',
    externalId: ev.externalId ?? null,
    status: ev.status || 'confirmed',
    createdAt: ev.createdAt ?? null,
    updatedAt: ev.updatedAt ?? null,
  };
}

/* ───────── Calendários ───────── */

async function handleListCalendars() {
  await ensureSeeded();
  const db = getProxy('calendar');
  return db.calendar.query({}, { sort: 'createdAt ASC' })
    .map(c => ({ id: c.id, name: c.name, color: c.color }));
}

async function handleCreateCalendar(data = {}) {
  const name = String(data.name ?? '').trim();
  if (!name) throw new Error('name is required');
  const db = getProxy('calendar');
  const cal = await db.calendar.push({ name, color: data.color || DEFAULT_CALENDAR.color });
  return { id: cal.id, name: cal.name, color: cal.color };
}

/* ───────── Eventos (CRUD) ───────── */

async function handleCreateEvent(input) {
  await ensureSeeded();
  const data = input?.data ?? input ?? {};
  const db = getProxy('calendar');
  const ev = await db.event.push(withDefaults(data));
  await dispatchEvent('calendar:created', eventPayload(ev));
  // Série recorrente com lembrete ganha uma cron no scheduler (ver lib/reminders.js
  // para o porquê da divisão). Nunca lança — a agenda funciona sem o scheduler.
  await syncReminderCron(ev);
  return serialize(ev);
}

/* Campos aceitos num update. Whitelist obrigatória: atribuir campo inexistente
 * no RecordProxy LANÇA, e o body do PATCH vem do cliente — um campo extra
 * derrubaria a rota com 500. */
const UPDATABLE = [
  'calendarId', 'title', 'description', 'startAt', 'endAt', 'allDay',
  'location', 'recurrence', 'recurrenceUntil', 'exdates', 'reminderMinutes',
  'tags', 'source', 'externalId', 'status',
];

async function handleUpdateEvent(id, changes = {}) {
  const db = getProxy('calendar');
  const ev = db.event[id];
  if (!ev) throw new Error(`Event ${id} not found`);

  const prevStatus = ev.status;
  const patch = {};
  for (const key of UPDATABLE) {
    if (changes[key] === undefined) continue;
    switch (key) {
      case 'title': {
        const title = String(changes.title ?? '').trim();
        if (!title) throw new Error('title cannot be empty');
        patch.title = title;
        break;
      }
      case 'startAt': {
        const startAt = toIso(changes.startAt, 'startAt');
        if (!startAt) throw new Error('startAt cannot be empty');
        patch.startAt = startAt;
        break;
      }
      case 'endAt': patch.endAt = toIso(changes.endAt, 'endAt'); break;
      case 'allDay': patch.allDay = toBool(changes.allDay, !!ev.allDay); break;
      case 'reminderMinutes': patch.reminderMinutes = toIntOrNull(changes.reminderMinutes); break;
      case 'recurrence': patch.recurrence = normalizeRecurrence(changes.recurrence); break;
      case 'recurrenceUntil': patch.recurrenceUntil = toIso(changes.recurrenceUntil, 'recurrenceUntil'); break;
      case 'exdates': patch.exdates = serializeExdates(changes.exdates); break;
      case 'tags': patch.tags = tagsToCsv(changes.tags); break;
      case 'status': patch.status = toStatus(changes.status, prevStatus); break;
      default: patch[key] = changes[key] ?? null;
    }
  }

  // Remarcar sem mexer no fim PRESERVA A DURAÇÃO — mover o início de um evento
  // de 1h para amanhã não deve estourar "endAt anterior a startAt", nem deixar
  // um fim órfão no dia antigo.
  const prevStart = ev.startAt?.getTime?.();
  const prevEnd = ev.endAt?.getTime?.();
  if (patch.startAt !== undefined && patch.endAt === undefined && prevStart && prevEnd) {
    patch.endAt = new Date(Date.parse(patch.startAt) + (prevEnd - prevStart)).toISOString();
  }

  const start = patch.startAt ?? ev.startAt?.toISOString?.() ?? null;
  const end = patch.endAt !== undefined ? patch.endAt : (ev.endAt?.toISOString?.() ?? null);
  if (start && end && Date.parse(end) < Date.parse(start)) {
    throw new Error('endAt cannot be before startAt');
  }

  // Remarcar o evento (ou mexer no lembrete) devolve o direito de disparar:
  // sem esse reset, reminderFiredAt bloquearia o lembrete para sempre.
  if (patch.startAt !== undefined || patch.reminderMinutes !== undefined) {
    patch.reminderFiredAt = null;
    patch.startedNotifiedAt = null;
  }

  // O setter do RecordProxy é async e não pode ser await-ado; o valor em memória
  // muda na hora e o UPDATE completa depois. Por isso o payload é montado a
  // partir do record já atribuído, sem reler o banco.
  for (const [key, value] of Object.entries(patch)) ev[key] = value;

  await dispatchEvent('calendar:updated', { ...eventPayload(ev), changes: { ...patch } });
  if (patch.status === 'cancelled' && prevStatus !== 'cancelled') {
    await dispatchEvent('calendar:cancelled', eventPayload(ev));
  }
  // Reconcilia a cron SEMPRE: virar recorrente cria, deixar de ser (ou cancelar,
  // ou zerar o lembrete) remove. syncReminderCron é idempotente de propósito,
  // então não vale a pena tentar adivinhar aqui se algo relevante mudou.
  await syncReminderCron(ev);
  return serialize(ev);
}

async function handleGetEvent(id) {
  const db = getProxy('calendar');
  const ev = db.event[id];
  if (!ev) throw new Error(`Event ${id} not found`);
  return serialize(ev);
}

/* delete ≠ cancel: aqui é soft delete (some da listagem). Cancelar é
 * status='cancelled', o evento continua visível. Eventos distintos, de
 * propósito. */
async function handleDeleteEvent(id) {
  const db = getProxy('calendar');
  const ev = db.event[id];
  if (!ev) throw new Error(`Event ${id} not found`);
  const payload = eventPayload(ev);
  await db.event.delete(id);
  await dispatchEvent('calendar:deleted', payload);
  // Sem isso a cron do scheduler sobreviveria ao evento e notificaria para
  // sempre sobre algo que não existe mais.
  await removeReminderCron(id);
  return { deleted: true, id };
}

/* Pular UMA ocorrência de uma série, sem tocar no resto: append em `exdates`.
 * Aceita o id da ocorrência (`<eventId>@<ISO>`) — que é o que a listagem
 * devolve — ou o par explícito (id da série + data). */
async function handleSkipOccurrence(id, occurrenceStart = null) {
  const parsed = parseOccurrenceId(id);
  const seriesId = parsed.eventId;
  const startIso = occurrenceStart ? toIso(occurrenceStart, 'occurrenceStart') : parsed.occurrenceStart;
  if (!startIso) throw new Error('Provide an occurrence ID or occurrenceStart.');

  const db = getProxy('calendar');
  const ev = db.event[seriesId];
  if (!ev) throw new Error(`Event ${seriesId} not found`);
  if (!isRecurring(ev.recurrence)) throw new Error('Event is not recurring. Use calendar_deleteEvent.');

  const next = serializeExdates([...parseExdates(ev.exdates), startIso]);
  ev.exdates = next;
  await dispatchEvent('calendar:occurrence_skipped', { ...eventPayload(ev), occurrenceStart: startIso });
  return { skipped: true, seriesId, occurrenceStart: startIso, exdates: parseExdates(next) };
}

/* Filtro de intervalo direto no SQL (o Scriba suporta $gte/$lte e já exclui
 * soft-deleted). Não carregar a tabela inteira em memória — a agenda cresce sem
 * teto, diferente de um board de tasks. */
async function handleListEvents(filters = {}) {
  await ensureSeeded();
  const db = getProxy('calendar');

  const base = {};
  const from = toIso(filters.from, 'from');
  const to = toIso(filters.to, 'to');
  if (filters.calendarId) base.calendarId = filters.calendarId;
  if (filters.status) base.status = toStatus(filters.status);
  if (filters.tag) base.tags = { $like: `%${String(filters.tag).trim()}%` };

  const sort = filters.sort || 'startAt ASC';
  const window = {};
  if (from) window.$gte = from;
  if (to) window.$lte = to;

  let events = db.event.query(
    Object.keys(window).length ? { ...base, startAt: window } : base,
    { sort },
  );

  /* Expansão de séries. Só acontece com intervalo definido — sem uma janela não
   * existe resposta finita para "todas as ocorrências de um evento diário sem
   * fim". Sem from/to a listagem devolve as linhas do banco (as séries-mestre),
   * que é o que ferramentas de administração querem ver. */
  if (from && to) {
    // Uma série que começou ANTES da janela não é devolvida pela range query
    // acima, mas suas ocorrências podem cair dentro dela — é o caso do evento
    // semanal criado mês passado aparecendo na semana atual. Daí a segunda
    // consulta. ($ne 'none' também descarta NULL no SQL, que é exatamente o
    // conjunto dos não recorrentes.)
    const earlier = db.event.query(
      { ...base, recurrence: { $ne: 'none' }, startAt: { $lt: from } },
      { sort },
    );

    const expanded = [];
    for (const ev of [...earlier, ...events]) {
      if (!isRecurring(ev.recurrence)) {
        expanded.push(ev);
        continue;
      }
      for (const occ of expandEvent(ev, from, to)) expanded.push(toOccurrence(ev, occ));
    }
    // Reordena: a concatenação das duas consultas e as datas geradas não saem
    // ordenadas entre si.
    const dir = /desc/i.test(sort) ? -1 : 1;
    expanded.sort((a, b) => dir * (new Date(a.startAt) - new Date(b.startAt)));
    events = expanded;
  }

  // $like em CSV casa substring ("casa" acharia "casamento") — refina em JS.
  if (filters.tag) {
    const q = String(filters.tag).trim().toLowerCase();
    events = events.filter(ev => tagsToArray(ev.tags).some(t => t.toLowerCase() === q));
  }
  if (filters.search) {
    const q = String(filters.search).toLowerCase();
    events = events.filter(ev =>
      (ev.title ?? '').toLowerCase().includes(q) ||
      (ev.description ?? '').toLowerCase().includes(q) ||
      (ev.location ?? '').toLowerCase().includes(q));
  }
  return events;
}

/* ───────── createEventFromText ─────────
 * Uma única chamada de LLM que só CLASSIFICA (tools: [], maxSteps: 1); a
 * criação é feita em JS, determinística. Sem a data/hora atual e o fuso no
 * system prompt "sexta às 14h" é indecidível — daí a injeção explícita. */

function localTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

async function handleCreateEventFromText(input) {
  const text = (input?.text ?? input ?? '').toString().trim();
  if (!text) throw new Error('text is required');

  await ensureSeeded();
  const calendars = await handleListCalendars();
  const now = new Date();
  const tz = localTimezone();
  const localNow = now.toLocaleString('en-US', { timeZone: tz });

  const result = await runAgentTask({
    system: `Extract a calendar event from the user's text.

Current time: ${localNow} (${tz}); UTC: ${now.toISOString()}.
Available calendars: ${calendars.map(c => `${c.name} (calendarId: ${c.id})`).join(', ') || 'none'}.

Rules:
- "startAt" is required and must be an absolute ISO-8601 time with offset.
- Resolve relative dates using ${tz}.
- If no time is given, set "allDay": true and use the start of that day.
- Set "endAt" only when a duration or end time is given.
- Set "reminderMinutes" only when a reminder is requested.
- Recurrence is only daily, weekly, monthly, or none.
- Keep "title" short. Exclude date and time.
Reply only with the requested JSON.`,
    goal: text,
    tools: [],
    maxSteps: 1,
    outputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        startAt: { type: 'string' },
        endAt: { type: 'string' },
        allDay: { type: 'boolean' },
        location: { type: 'string' },
        reminderMinutes: { type: 'number' },
        recurrence: { type: 'string', enum: RECURRENCES },
        recurrenceUntil: { type: 'string' },
        calendarId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'startAt'],
    },
  });
  if (!result.success) throw new Error(result.error || 'Could not parse the event.');

  // O modelo erra formato com frequência — normaliza/valida antes do push, e a
  // duração default é decidida aqui (withDefaults), nunca pelo LLM.
  const out = result.output ?? {};
  const startAt = toIso(out.startAt, 'startAt');
  if (!startAt) throw new Error('Could not find a valid event date.');

  const known = new Set(calendars.map(c => c.id));
  return handleCreateEvent({
    title: out.title,
    description: out.description ?? null,
    startAt,
    endAt: out.endAt ?? null,
    allDay: out.allDay ?? false,
    location: out.location ?? null,
    // Clamp em [0, 7 dias]: o modelo às vezes devolve "1 dia antes" como 1440 —
    // certo — mas também já devolveu segundos e números absurdos, e um lembrete
    // além do horizonte do tick nunca dispararia.
    reminderMinutes: out.reminderMinutes == null
      ? null
      : Math.min(Math.max(0, Math.trunc(Number(out.reminderMinutes) || 0)), 10080),
    recurrence: normalizeRecurrence(out.recurrence),
    recurrenceUntil: out.recurrenceUntil ?? null,
    tags: Array.isArray(out.tags) ? out.tags : null,
    calendarId: known.has(out.calendarId) ? out.calendarId : null,
  });
}

/* ───────── Tick: calendar:reminder_due + calendar:started ─────────
 * 60s (os 5min do tasks são grossos demais para lembrete de hora marcada).
 * A condição é `<= agora`, nunca `== agora`: se o processo estiver parado no
 * minuto exato o lembrete não pode sumir. A única guarda contra redisparo são
 * os campos persistidos reminderFiredAt / startedNotifiedAt. */

const TICK_INTERVAL_MS = 60 * 1000;
const MAX_REMINDER_MS = 7 * 24 * 60 * 60 * 1000; // horizonte de antecedência suportado
const LOOKBACK_MS = 24 * 60 * 60 * 1000;         // recupera ticks perdidos (processo parado)

/* Candidatos do tick: tudo cuja ocorrência possa cair na janela — inclusive as
 * séries que COMEÇARAM antes dela (o evento semanal de mês passado que tem
 * ocorrência hoje). Duas consultas com range, nunca a tabela inteira. */
function tickCandidates(db, fromISO, toISO) {
  const inWindow = db.event.query({ startAt: { $gte: fromISO, $lte: toISO } }, { sort: 'startAt ASC' });
  const earlier = db.event.query(
    { recurrence: { $ne: 'none' }, startAt: { $lt: fromISO } },
    { sort: 'startAt ASC' },
  );
  return [...earlier, ...inWindow];
}

// Ocorrências da janela, da mais recente para a mais antiga — o tick só se
// importa com a última que "venceu", não com o histórico.
function occurrencesDesc(ev, fromISO, toISO) {
  return expandEvent(ev, fromISO, toISO).sort((a, b) => b.start - a.start);
}

// Exportada (sem decorator, então não vira tool nem rota) para permitir
// disparar a varredura sob demanda em teste, sem esperar o intervalo real.
export async function scanCalendar() {
  const db = getProxy('calendar');
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  const since = new Date(now - LOOKBACK_MS).toISOString();
  const horizon = new Date(now + MAX_REMINDER_MS).toISOString();

  for (const ev of tickCandidates(db, since, horizon)) {
    // Cancelado não marca guarda nenhuma: se voltar a confirmed ainda dentro da
    // janela, o lembrete/início ainda dispara.
    if (ev.status === 'cancelled') continue;
    const recurring = isRecurring(ev.recurrence);

    /* ── Lembrete ──
     * reminderFiredAt guarda o INÍCIO DA OCORRÊNCIA já notificada, não o
     * instante do disparo. É o que dá idempotência por ocorrência numa série
     * usando um campo só: uma ocorrência nova sempre tem start MAIOR que a
     * última notificada. O reset para null no update devolve o direito de
     * disparar quando o evento é remarcado. */
    if (ev.reminderMinutes) {
      const firedAt = ev.reminderFiredAt ? Date.parse(ev.reminderFiredAt) : null;
      const due = occurrencesDesc(ev, since, horizon).find(o => {
        // `<=` e não `==`: um tick perdido (processo parado no minuto exato)
        // não pode engolir o lembrete.
        if (o.start.getTime() - ev.reminderMinutes * 60000 > now) return false;
        return !Number.isFinite(firedAt) || o.start.getTime() > firedAt;
      });
      if (due) {
        const minutesUntilStart = Math.round((due.start.getTime() - now) / 60000);
        ev.reminderFiredAt = due.start.toISOString();
        await dispatchEvent('calendar:reminder_due', {
          ...eventPayload(ev),
          startAt: due.start.toISOString(),
          reminderMinutes: ev.reminderMinutes,
          minutesUntilStart,
        });
        // A notificação ntfy do evento ÚNICO sai daqui. A da série sai da cron
        // registrada no scheduler (lib/reminders.js) — mandar as duas
        // duplicaria a notificação para eventos recorrentes.
        if (!recurring) {
          await notifyReminder({ ...eventPayload(ev), startAt: due.start, location: ev.location }, minutesUntilStart);
        }
      }
    }

    /* ── Início ── mesma disciplina de guarda, janela até agora. */
    const startedAt = ev.startedNotifiedAt ? Date.parse(ev.startedNotifiedAt) : null;
    const begun = occurrencesDesc(ev, since, nowISO)
      .find(o => o.start.getTime() <= now && (!Number.isFinite(startedAt) || o.start.getTime() > startedAt));
    if (begun) {
      ev.startedNotifiedAt = begun.start.toISOString();
      await dispatchEvent('calendar:started', { ...eventPayload(ev), startAt: begun.start.toISOString() });
    }
  }
}

/* ───────── Tools (MCP) ─────────
 * O bridge MCP entrega os argumentos ACHATADOS ("data.id", "filters.limit"),
 * não aninhados — daí o pick()/unflatten(). É a causa clássica de tool que
 * "não recebe parâmetro". */

function unflatten(input, ns) {
  const flat = input ?? {};
  const nested = flat[ns] && typeof flat[ns] === 'object' ? flat[ns] : {};
  const out = { ...nested };
  const prefix = `${ns}.`;
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    else if (k !== ns && !k.includes('.') && out[k] === undefined) out[k] = v;
  }
  return out;
}

const pick = (flat, key) => flat?.[`data.${key}`] ?? flat?.[key] ?? flat?.data?.[key];

export function calendar_createEvent(input) {
  /**
   * @register_tool calendar_createEvent
   * @description Create a calendar event.
   * @param {string} data.title - Event title
   * @param {string} data.startAt - ISO-8601 start time
   * @param {string?} data.endAt - ISO-8601 end time
   * @param {boolean?} data.allDay - All-day event
   * @param {string?} data.description - Description
   * @param {string?} data.location - Location
   * @param {number?} data.reminderMinutes - Reminder lead time in minutes
   * @param {string[]?} data.tags - Tags
   * @param {string?} data.calendarId - Calendar ID
   * @param {string?} data.recurrence - none | daily | weekly | monthly
   * @param {string?} data.recurrenceUntil - ISO-8601 recurrence end
   */
  const flat = input ?? {};
  const data = {};
  for (const k of UPDATABLE) {
    const v = pick(flat, k);
    if (v !== undefined) data[k] = v;
  }
  return handleCreateEvent(data);
}

export function calendar_createEventFromText(input) {
  /**
   * @register_tool calendar_createEventFromText
   * @description Create an event from natural language.
   * @param {string} text - Event details
   */
  const flat = input ?? {};
  return handleCreateEventFromText({ text: flat['data.text'] ?? flat.text ?? flat.data?.text ?? flat });
}

export function calendar_getEvent(input) {
  /**
   * @register_tool calendar_getEvent
   * @description Get an event by ID.
   * @param {string} data.id - Event ID
   */
  const flat = input ?? {};
  return handleGetEvent(pick(flat, 'id') ?? flat);
}

export function calendar_updateEvent(input) {
  /**
   * @register_tool calendar_updateEvent
   * @description Update an event.
   * @param {string} data.id - Event ID
   * @param {string?} data.title - New title
   * @param {string?} data.startAt - New ISO-8601 start time
   * @param {string?} data.endAt - New ISO-8601 end time
   * @param {boolean?} data.allDay - All-day event
   * @param {string?} data.description - New description
   * @param {string?} data.location - New location
   * @param {number?} data.reminderMinutes - Reminder lead time in minutes
   * @param {string[]?} data.tags - New tags
   * @param {string?} data.status - confirmed | cancelled
   * @param {string?} data.calendarId - New calendar ID
   * @param {string?} data.recurrence - none | daily | weekly | monthly
   * @param {string?} data.recurrenceUntil - New ISO-8601 recurrence end
   */
  const flat = input ?? {};
  const changes = {};
  for (const k of UPDATABLE) {
    const v = pick(flat, k);
    if (v !== undefined) changes[k] = v;
  }
  return handleUpdateEvent(pick(flat, 'id'), changes);
}

export function calendar_deleteEvent(input) {
  /**
   * @register_tool calendar_deleteEvent
   * @reach manual
   * @description Delete an event.
   * @param {string} data.id - Event ID
   */
  const flat = input ?? {};
  return handleDeleteEvent(pick(flat, 'id'));
}

export function calendar_skipOccurrence(input) {
  /**
   * @register_tool calendar_skipOccurrence
   * @description Skip one recurring occurrence.
   * @param {string} data.id - Occurrence or series ID
   * @param {string?} data.occurrenceStart - ISO-8601 occurrence start
   */
  const flat = input ?? {};
  return handleSkipOccurrence(pick(flat, 'id'), pick(flat, 'occurrenceStart') ?? null);
}

export function calendar_listEvents(input) {
  /**
   * @register_tool calendar_listEvents
   * @description List events.
   * @param {string?} filters.from - ISO-8601 range start
   * @param {string?} filters.to - ISO-8601 range end
   * @param {string?} filters.calendarId - Calendar ID
   * @param {string?} filters.tag - Exact tag
   * @param {string?} filters.search - Search title, description, or location
   * @param {string?} filters.status - confirmed | cancelled
   * @param {number?} filters.limit - Maximum results
   * @param {number?} filters.offset - Result offset
   */
  return (async () => {
    const f = unflatten(input, 'filters');
    const events = await handleListEvents(f);
    const offset = Math.max(0, parseInt(f.offset, 10) || 0);
    const limit = Math.min(Math.max(1, parseInt(f.limit, 10) || 50), 200);
    const page = events.slice(offset, offset + limit);

    const rows = page.map(ev => {
      const row = {
        id: ev.id,
        title: ev.title,
        startAt: ev.startAt?.toISOString?.() ?? null,
        allDay: !!ev.allDay,
        status: ev.status || 'confirmed',
      };
      if (ev.endAt) row.endAt = ev.endAt.toISOString();
      // Só aparece quando é ocorrência de série — o consumidor precisa do
      // seriesId para editar/apagar (o id da ocorrência não existe no banco).
      if (ev.seriesId) { row.seriesId = ev.seriesId; row.recurrence = ev.recurrence; }
      if (ev.location) row.location = ev.location;
      if (ev.reminderMinutes) row.reminderMinutes = ev.reminderMinutes;
      const tags = tagsToArray(ev.tags);
      if (tags.length) row.tags = tags;
      return row;
    });

    const out = { total: events.length, offset, showing: rows.length, events: rows };
    if (events.length > offset + rows.length) out.nextOffset = offset + rows.length;
    return out;
  })();
}

export function calendar_listCalendars() {
  /**
   * @register_tool calendar_listCalendars
   * @description List calendars.
   */
  return handleListCalendars();
}

/* ───────── Rotas HTTP ─────────
 * Mounted at /calendar/<path>. `create-from-text` has its own path to
 * propósito: `events/from-text` colidiria com `events/:id` na ordem de
 * registro. */

export function routerListEvents(req) {
  /** @register_router events
   *  @method GET */
  return (async () => ({ data: (await handleListEvents(req.query ?? {})).map(serialize) }))();
}

export function routerCreateEvent(req) {
  /** @register_router events
   *  @method POST */
  return (async () => ({ data: await handleCreateEvent(req.body) }))();
}

export function routerCreateEventFromText(req) {
  /** @register_router create-from-text
   *  @method POST */
  return (async () => ({ data: await handleCreateEventFromText(req.body) }))();
}

export function routerGetEvent(req) {
  /** @register_router events/:id
   *  @method GET */
  return (async () => ({ data: await handleGetEvent(req.params.id) }))();
}

export function routerUpdateEvent(req) {
  /** @register_router events/:id
   *  @method PATCH */
  return (async () => ({ data: await handleUpdateEvent(req.params.id, req.body ?? {}) }))();
}

export function routerDeleteEvent(req) {
  /** @register_router events/:id
   *  @method DELETE */
  return (async () => ({ data: await handleDeleteEvent(req.params.id) }))();
}

/* Caminho próprio (não `events/:id/skip`) pela mesma razão do create-from-text:
 * o id de uma ocorrência contém "@" e um ISO com ":" — mantê-lo no BODY evita
 * qualquer dependência de encoding no path. */
export function routerSkipOccurrence(req) {
  /** @register_router skip-occurrence
   *  @method POST */
  return (async () => {
    const body = req.body ?? {};
    return { data: await handleSkipOccurrence(body.id, body.occurrenceStart ?? null) };
  })();
}

export function routerListCalendars() {
  /** @register_router calendars
   *  @method GET */
  return (async () => ({ data: await handleListCalendars() }))();
}

export function routerCreateCalendar(req) {
  /** @register_router calendars
   *  @method POST */
  return (async () => ({ data: await handleCreateCalendar(req.body) }))();
}

/* ───────── Boot ───────── */

export function onBoot() {
  /**
   * @register_hook boot
   */
  const run = () => scanCalendar().catch(err => console.error('[calendar] Scan failed:', err));
  ensureSeeded()
    .then(() => {
      console.log('[calendar] Package loaded.');
      run();
      // Substitui o interval da execução anterior deste mesmo diretório: o
      // módulo é reexecutado a cada re-scan e sem isso os ticks acumulariam.
      if (TICK.interval) clearInterval(TICK.interval);
      TICK.interval = setInterval(run, TICK_INTERVAL_MS);
      if (typeof TICK.interval.unref === 'function') TICK.interval.unref();
    })
    .catch(err => console.error('[calendar] Seed failed:', err));
}
