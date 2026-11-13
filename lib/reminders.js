// packages/calendar/lib/reminders.js
//
// Entrega dos lembretes. São DOIS caminhos, e a divisão não é estética — vem de
// uma limitação real do scheduler:
//
//   evento único    → varredura interna (tick de 60s no index.js) + ntfy direto.
//   evento recorrente → cron no scheduler (action type "notify").
//
// Por que não usar o scheduler para tudo: a cron dele tem 5 campos (min hora dia
// mês dow) e NÃO tem ano — packages/scheduler/index.js. Um lembrete de
// 30/07/2026 14:00 viraria "0 14 30 7 *" e voltaria a disparar todo 30 de julho,
// para sempre. Não existe one-shot. Para o evento único, portanto, quem controla
// o disparo é o próprio pacote, com guarda de idempotência persistida.
//
// Por que não usar o tick para tudo: ele varre uma janela limitada em torno de
// agora. Uma série semanal que se estende por anos é exatamente o caso que uma
// cron resolve de graça — e, sendo recorrente, "dispara todo ano" deixa de ser
// bug e vira a semântica desejada.
//
// Nada aqui pode derrubar o CRUD: ntfy e scheduler são packages opcionais e
// podem não estar instalados. Toda função devolve um resultado e registra o
// problema, nunca propaga exceção (mesma postura do runAction do scheduler).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_BRIDGE = path.join(PKG_DIR, '..', '..', 'agent', 'core', 'runtime_bridge.js');

// O import é dinâmico e preguiçoso de propósito: carregar o bridge no topo
// acoplaria o boot da agenda ao do agent, e um pacote ausente quebraria o
// módulo inteiro em vez de só o lembrete.
async function bridge() {
  return import(RUNTIME_BRIDGE);
}

async function invoke(pkg, tool, args) {
  try {
    const { invokeRuntimeTool } = await bridge();
    return { ok: true, result: await invokeRuntimeTool(pkg, tool, args) };
  } catch (err) {
    // Caso esperado, não excepcional: ntfy/scheduler podem não estar instalados.
    console.warn(`[calendar] ${pkg}.${tool} unavailable: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/* ── Texto da notificação ──
 * Montado aqui para que o tick e a cron digam exatamente a mesma coisa. */

function formatWhen(startAt, allDay) {
  const d = startAt instanceof Date ? startAt : new Date(startAt);
  if (Number.isNaN(d.getTime())) return '';
  if (allDay) return d.toLocaleDateString('en-US');
  return d.toLocaleString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function reminderText(ev, minutesUntilStart = null) {
  const when = formatWhen(ev.startAt, ev.allDay);
  const lead = minutesUntilStart === null || minutesUntilStart <= 0
    ? 'now'
    : minutesUntilStart >= 60 && minutesUntilStart % 60 === 0
      ? `in ${minutesUntilStart / 60}h`
      : `in ${minutesUntilStart}m`;
  const parts = [`${ev.title} — ${lead}`, when ? `(${when})` : ''];
  if (ev.location) parts.push(`· ${ev.location}`);
  return parts.filter(Boolean).join(' ');
}

/** Dispara a notificação ntfy de um lembrete. Nunca lança. */
export async function notifyReminder(ev, minutesUntilStart = null, channel = null) {
  return invoke('ntfy', 'sendNtfyNotification', {
    title: 'Calendar',
    message: reminderText(ev, minutesUntilStart),
    channel: channel || undefined,
    // discreteId estável por evento: um lembrete reemitido ATUALIZA a
    // notificação existente em vez de empilhar uma nova (ver ntfy/index.js).
    discreteId: `calendar-${ev.id}`,
  });
}

/* Recurring reminders use scheduler cron jobs. The name is deterministic so
 * each event can find or remove its own job. */

export const cronName = (eventId) => `calendar:${eventId}`;

/** Instante do lembrete → expressão cron de 5 campos, na regra da série.
 *  Devolve null se a recorrência não for suportada por cron. */
export function reminderCron(startAt, reminderMinutes, recurrence) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  if (Number.isNaN(start.getTime())) return null;

  // O momento do lembrete é o início MENOS a antecedência — e é ele, não o
  // início, que vira a cron. Um lembrete de 1h antes de um evento às 00:30 cai
  // no dia anterior, e a subtração em Date já resolve dia/mês/dow corretamente.
  const at = new Date(start.getTime() - (Number(reminderMinutes) || 0) * 60000);
  const min = at.getMinutes();
  const hour = at.getHours();

  switch (recurrence) {
    case 'daily':   return `${min} ${hour} * * *`;
    case 'weekly':  return `${min} ${hour} * * ${at.getDay()}`;
    case 'monthly': return `${min} ${hour} ${at.getDate()} * *`;
    default:        return null;   // 'none' → tick interno, não cron
  }
}

async function findCronId(eventId) {
  const res = await invoke('scheduler', 'scheduler_list', {});
  if (!res.ok) return null;
  const tasks = res.result?.tasks ?? res.result ?? [];
  return (Array.isArray(tasks) ? tasks : []).find(t => t?.name === cronName(eventId))?.id ?? null;
}

/**
 * Reconcilia a cron de um evento com o estado atual dele. Idempotente: pode ser
 * chamada em todo create/update sem checar antes o que mudou.
 *
 * Cria a cron quando o evento é recorrente, tem lembrete e está confirmado;
 * remove nos demais casos (inclusive quando o evento deixa de ser recorrente ou
 * é cancelado — senão a notificação continuaria chegando para sempre).
 */
export async function syncReminderCron(ev) {
  const eventId = ev?.id;
  if (!eventId) return { synced: false };

  const cron = ev.status !== 'cancelled' && ev.reminderMinutes
    ? reminderCron(ev.startAt, ev.reminderMinutes, ev.recurrence)
    : null;

  const existingId = await findCronId(eventId);

  if (!cron) {
    if (!existingId) return { synced: true, action: 'noop' };
    await invoke('scheduler', 'scheduler_remove', { id: existingId });
    return { synced: true, action: 'removed' };
  }

  const action = {
    type: 'notify',
    title: 'Calendar',
    message: reminderText(ev, Number(ev.reminderMinutes) || 0),
  };

  if (existingId) {
    await invoke('scheduler', 'scheduler_update', { id: existingId, cron, action });
    return { synced: true, action: 'updated', cron };
  }
  const res = await invoke('scheduler', 'scheduler_add', {
    name: cronName(eventId),
    cron,
    description: `Recurring event reminder: ${ev.title}`,
    action,
  });
  return { synced: res.ok, action: 'created', cron };
}

/** Remove a cron de um evento apagado. Nunca lança. */
export async function removeReminderCron(eventId) {
  const existingId = await findCronId(eventId);
  if (!existingId) return { removed: false };
  await invoke('scheduler', 'scheduler_remove', { id: existingId });
  return { removed: true };
}
