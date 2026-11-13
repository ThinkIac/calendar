<script>
  import { onMount, onDestroy } from 'svelte';
  import { getTheme, onThemeChange } from './lib/theme.js';
  import * as api from './lib/api.js';
  import {
    WEEKDAYS, monthGrid, weekGrid, monthLabel, weekLabel, rangeFor,
    addMonths, addDays, startOfDay, dayKey,
    sameDay, formatTime, formatDayLabel, formatShortDay,
    toLocalInput, toDateInput, fromLocalInput,
  } from './lib/dates.js';

  let theme = getTheme();
  let offTheme;

  const MODES = [
    { id: 'day', label: 'Day' },
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
  ];

  let mode = 'month';                    // 'day' | 'week' | 'month'
  let cursor = startOfDay(new Date());   // período exibido
  let selected = startOfDay(new Date()); // dia da lista lateral
  let today = startOfDay(new Date());

  let events = [];
  let upcoming = [];
  let calendars = [];
  let loading = true;
  let error = '';

  let mounted = false; // guarda o SSR: load() só roda no browser
  let quickText = '';
  let quickBusy = false;

  let panel = null;    // rascunho do evento em edição (null = painel fechado)
  let saving = false;
  let confirmingDelete = false;
  let confirmingSkip = false;

  $: grid = monthGrid(cursor);
  $: week = weekGrid(cursor);
  $: periodLabel = mode === 'month' ? monthLabel(cursor)
    : mode === 'week' ? weekLabel(cursor)
    : formatDayLabel(cursor);

  // Agrupa por dia LOCAL: o servidor devolve UTC e um evento das 22h viraria o
  // dia seguinte se agrupássemos pela string ISO.
  $: byDay = events.reduce((acc, ev) => {
    const key = dayKey(ev.startAt);
    (acc[key] ??= []).push(ev);
    return acc;
  }, {});
  $: dayEvents = byDay[dayKey(selected)] ?? [];

  /* Visão de dia: faixa de dia inteiro no topo, o resto ancorado na hora de
   * início. Só as horas COM evento viram linha — um rail de 24 linhas vazias é
   * ruído, e a agenda real é esparsa. */
  $: dayAllDay = dayEvents.filter(ev => ev.allDay);
  $: dayHours = Object.entries(
    dayEvents.filter(ev => !ev.allDay).reduce((acc, ev) => {
      const h = new Date(ev.startAt).getHours();
      (acc[h] ??= []).push(ev);
      return acc;
    }, {}),
  )
    .map(([hour, list]) => ({ hour: Number(hour), list }))
    .sort((a, b) => a.hour - b.hour);

  async function load() {
    error = '';
    try {
      // rangeFor cobre exatamente o que a tela desenha em cada modo (na visão
      // mensal, as 6 semanas inteiras — as células de transbordo mostram os
      // eventos dos meses vizinhos). O servidor expande as séries recorrentes
      // dentro dessa janela, então cada ocorrência chega como um item próprio.
      const { from, to } = rangeFor(mode, cursor);
      events = await api.listEvents(from, to);
    } catch (err) {
      error = err.message;
      events = [];
    } finally {
      loading = false;
    }
  }

  /* "Próximos eventos" é uma janela PRÓPRIA (agora → +30 dias), independente do
   * período navegado: a lista continua útil depois de o usuário navegar para
   * março do ano que vem. */
  async function loadUpcoming() {
    try {
      const now = new Date();
      const list = await api.listEvents(now.toISOString(), addDays(now, 30).toISOString());
      upcoming = list.filter(ev => ev.status !== 'cancelled').slice(0, 8);
    } catch {
      upcoming = [];
    }
  }

  async function reload() {
    await Promise.all([load(), loadUpcoming()]);
  }

  // Trocar de período/modo recarrega a janela; `mounted` impede que dispare no SSR.
  $: if (mounted && (cursor || mode)) load();

  onMount(async () => {
    offTheme = onThemeChange(t => (theme = t));
    try { calendars = await api.listCalendars(); } catch { calendars = []; }
    mounted = true;
    loadUpcoming();
  });
  onDestroy(() => offTheme?.());

  function goToday() {
    today = startOfDay(new Date());
    cursor = today;
    selected = today;
  }

  // Um botão de navegação só, para os três modos — o passo é o do período.
  function step(direction) {
    if (mode === 'month') cursor = addMonths(cursor, direction);
    else if (mode === 'week') cursor = addDays(cursor, direction * 7);
    else cursor = addDays(cursor, direction);
    if (mode !== 'month') selected = startOfDay(cursor);
  }

  function setMode(next) {
    // Trocar de modo mantém o dia em foco (e não o dia 1º do mês), senão
    // alternar mês → dia jogaria o usuário para um dia arbitrário.
    mode = next;
    cursor = startOfDay(selected);
  }

  function selectDay(date) {
    selected = startOfDay(date);
    if (mode === 'month' && date.getMonth() !== cursor.getMonth()) {
      cursor = new Date(date.getFullYear(), date.getMonth(), 1);
    }
    if (mode === 'day') cursor = startOfDay(date);
  }

  /* ── Painel ── */

  function openNew(date = selected) {
    const start = new Date(date);
    if (sameDay(start, new Date())) start.setHours(new Date().getHours() + 1, 0, 0, 0);
    else start.setHours(9, 0, 0, 0);
    panel = {
      id: null, title: '', description: '', location: '',
      allDay: false,
      startAt: toLocalInput(start.toISOString()),
      startDate: toDateInput(start.toISOString()),
      endAt: '',
      reminderMinutes: '',
      tags: '',
      status: 'confirmed',
      recurrence: 'none',
      recurrenceUntil: '',
      occurrenceId: null,
      isOccurrence: false,
      calendarId: calendars[0]?.id ?? '',
    };
    confirmingDelete = false;
    confirmingSkip = false;
  }

  function openEdit(ev) {
    panel = {
      // Numa ocorrência expandida, `ev.id` é o id VIRTUAL da ocorrência e não
      // existe no banco — quem update/delete recebem é o seriesId. O id da
      // ocorrência fica guardado à parte, só para "pular esta data".
      id: ev.seriesId ?? ev.id,
      occurrenceId: ev.seriesId ? ev.id : null,
      isOccurrence: !!ev.seriesId,
      recurrence: ev.recurrence ?? 'none',
      recurrenceUntil: toDateInput(ev.recurrenceUntil),
      title: ev.title ?? '',
      description: ev.description ?? '',
      location: ev.location ?? '',
      allDay: !!ev.allDay,
      startAt: toLocalInput(ev.startAt),
      startDate: toDateInput(ev.startAt),
      endAt: toLocalInput(ev.endAt),
      reminderMinutes: ev.reminderMinutes ?? '',
      tags: (ev.tags ?? []).join(', '),
      status: ev.status ?? 'confirmed',
      calendarId: ev.calendarId ?? '',
    };
    confirmingDelete = false;
    confirmingSkip = false;
  }

  function closePanel() {
    panel = null;
    confirmingDelete = false;
    confirmingSkip = false;
  }

  async function savePanel() {
    if (!panel?.title.trim()) return;
    saving = true;
    error = '';
    try {
      const startAt = panel.allDay
        ? fromLocalInput(`${panel.startDate}T00:00`)
        : fromLocalInput(panel.startAt);
      if (!startAt) throw new Error('Enter a start date.');

      const payload = {
        title: panel.title.trim(),
        description: panel.description.trim() || null,
        location: panel.location.trim() || null,
        allDay: panel.allDay,
        startAt,
        endAt: panel.allDay ? null : fromLocalInput(panel.endAt),
        reminderMinutes: panel.reminderMinutes === '' ? null : Number(panel.reminderMinutes),
        tags: panel.tags.split(',').map(t => t.trim()).filter(Boolean),
        status: panel.status,
        calendarId: panel.calendarId || null,
        recurrence: panel.recurrence,
        // Fim da série é o FIM daquele dia: com T00:00 a última ocorrência
        // esperada (a do próprio dia escolhido) ficaria de fora.
        recurrenceUntil: panel.recurrence === 'none' || !panel.recurrenceUntil
          ? null
          : fromLocalInput(`${panel.recurrenceUntil}T23:59`),
      };
      if (panel.id) await api.updateEvent(panel.id, payload);
      else await api.createEvent(payload);
      closePanel();
      await reload();
    } catch (err) {
      error = err.message;
    } finally {
      saving = false;
    }
  }

  async function removeEvent() {
    if (!panel?.id) return;
    saving = true;
    try {
      await api.deleteEvent(panel.id);
      closePanel();
      await reload();
    } catch (err) {
      error = err.message;
    } finally {
      saving = false;
    }
  }

  /* Pular só ESTA data de uma série: o servidor faz append em `exdates` e a
   * série continua de pé. É a alternativa não destrutiva ao "excluir", que
   * levaria a série inteira junto. */
  async function skipThisOccurrence() {
    if (!panel?.occurrenceId) return;
    saving = true;
    try {
      await api.skipOccurrence(panel.occurrenceId);
      closePanel();
      await reload();
    } catch (err) {
      error = err.message;
    } finally {
      saving = false;
    }
  }

  async function submitQuick() {
    const text = quickText.trim();
    if (!text || quickBusy) return;
    quickBusy = true;
    error = '';
    try {
      const created = await api.createEventFromText(text);
      quickText = '';
      // Navega até o evento criado: sem isso um "dentista mês que vem" some da
      // tela e parece que nada aconteceu.
      const start = new Date(created.startAt);
      selected = startOfDay(start);
      cursor = mode === 'month'
        ? new Date(start.getFullYear(), start.getMonth(), 1)
        : startOfDay(start);
      await reload();
    } catch (err) {
      error = err.message;
    } finally {
      quickBusy = false;
    }
  }

  function calendarColor(id) {
    return calendars.find(c => c.id === id)?.color ?? '#38bdf8';
  }
</script>

<div class="agenda" data-theme={theme}>
  <header class="topbar">
    <div class="nav">
      <svg class="calendar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></svg>
      <button class="icon" title="Previous period" on:click={() => step(-1)} aria-label="Previous period">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <h1>{periodLabel}</h1>
      <button class="icon" title="Next period" on:click={() => step(1)} aria-label="Next period">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg>
      </button>
      <button class="ghost" on:click={goToday}>Today</button>
    </div>

    <div class="modes" role="group" aria-label="View mode">
      {#each MODES as m (m.id)}
        <button class="mode" class:active={mode === m.id} on:click={() => setMode(m.id)}>{m.label}</button>
      {/each}
    </div>

    <form class="quick" on:submit|preventDefault={submitQuick}>
      <svg class="quick-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>
      <input
        type="text"
        bind:value={quickText}
        placeholder="Dentist Thursday at 2pm, remind me 1h before"
        disabled={quickBusy}
        aria-label="Create event from text"
      />
      <button type="submit" class="solid" disabled={quickBusy || !quickText.trim()}>
        {quickBusy ? 'Parsing…' : 'Create'}
      </button>
    </form>
  </header>

  {#if error}
    <div class="error" role="alert">{error}</div>
  {/if}

  <div class="body">
    <section class="calendar">
      {#if mode === 'month'}
        <div class="weekdays">
          {#each WEEKDAYS as wd}<span>{wd}</span>{/each}
        </div>
        <div class="grid" class:loading>
          {#each grid as date (date.getTime())}
            {@const list = byDay[dayKey(date)] ?? []}
            <button
              class="cell"
              class:outside={date.getMonth() !== cursor.getMonth()}
              class:today={sameDay(date, today)}
              class:selected={sameDay(date, selected)}
              on:click={() => selectDay(date)}
              on:dblclick={() => { selectDay(date); openNew(date); }}
            >
              <span class="daynum">{date.getDate()}</span>
              <span class="chips">
                {#each list.slice(0, 3) as ev (ev.id)}
                  <span class="chip" class:cancelled={ev.status === 'cancelled'} title={ev.title}>
                    <span class="dot" style={`background:${calendarColor(ev.calendarId)}`}></span>
                    <span class="chip-text">{ev.allDay ? '' : formatTime(ev.startAt) + ' '}{ev.title}</span>
                  </span>
                {/each}
                {#if list.length > 3}<span class="more">+{list.length - 3}</span>{/if}
              </span>
            </button>
          {/each}
        </div>

      {:else if mode === 'week'}
        <div class="week" class:loading>
          {#each week as date (date.getTime())}
            {@const list = byDay[dayKey(date)] ?? []}
            <div class="col" class:today={sameDay(date, today)} class:selected={sameDay(date, selected)}>
              <button class="col-head" on:click={() => selectDay(date)} on:dblclick={() => { selectDay(date); openNew(date); }}>
                <span class="col-wd">{WEEKDAYS[date.getDay()]}</span>
                <span class="col-num">{date.getDate()}</span>
              </button>
              <div class="col-body">
                {#each list as ev (ev.id)}
                  <button class="slot" class:cancelled={ev.status === 'cancelled'} on:click={() => openEdit(ev)} title={ev.title}>
                    <span class="dot" style={`background:${calendarColor(ev.calendarId)}`}></span>
                    <span class="slot-text">
                      <span class="slot-time">{ev.allDay ? 'All day' : formatTime(ev.startAt)}</span>
                      <span class="slot-title">{ev.title}</span>
                    </span>
                  </button>
                {:else}
                  <span class="col-empty">—</span>
                {/each}
              </div>
            </div>
          {/each}
        </div>

      {:else}
        <div class="day-view" class:loading>
          {#if dayAllDay.length}
            <div class="allday">
              <span class="rail-label">All day</span>
              <div class="rail-items">
                {#each dayAllDay as ev (ev.id)}
                  <button class="event" class:cancelled={ev.status === 'cancelled'} on:click={() => openEdit(ev)}>
                    <span class="bar" style={`background:${calendarColor(ev.calendarId)}`}></span>
                    <span class="event-body"><span class="event-title">{ev.title}</span></span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          {#if loading}
            <p class="empty">Loading…</p>
          {:else if dayHours.length === 0 && dayAllDay.length === 0}
            <p class="empty">No events on {formatDayLabel(selected)}.</p>
          {:else}
            {#each dayHours as row (row.hour)}
              <div class="hour">
                <span class="rail-label">{String(row.hour).padStart(2, '0')}:00</span>
                <div class="rail-items">
                  {#each row.list as ev (ev.id)}
                    <button class="event" class:cancelled={ev.status === 'cancelled'} on:click={() => openEdit(ev)}>
                      <span class="bar" style={`background:${calendarColor(ev.calendarId)}`}></span>
                      <span class="event-body">
                        <span class="event-time">
                          {formatTime(ev.startAt)}{#if ev.endAt}{' – '}{formatTime(ev.endAt)}{/if}
                        </span>
                        <span class="event-title">{ev.title}</span>
                        {#if ev.location}<span class="event-meta">{ev.location}</span>{/if}
                        {#if ev.reminderMinutes}<span class="event-meta">Reminder {ev.reminderMinutes}m before</span>{/if}
                      </span>
                    </button>
                  {/each}
                </div>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </section>

    <aside class="side">
      {#if mode !== 'day'}
        <section class="card">
          <div class="card-head">
            <h2>{formatDayLabel(selected)}</h2>
            <button class="solid sm" on:click={() => openNew(selected)}>New event</button>
          </div>
          {#if loading}
            <p class="empty">Loading…</p>
          {:else if dayEvents.length === 0}
            <p class="empty">No events today.</p>
          {:else}
            <ul class="list">
              {#each dayEvents as ev (ev.id)}
                <li>
                  <button class="event" class:cancelled={ev.status === 'cancelled'} on:click={() => openEdit(ev)}>
                    <span class="bar" style={`background:${calendarColor(ev.calendarId)}`}></span>
                    <span class="event-body">
                      <span class="event-time">
                        {#if ev.allDay}All day{:else}{formatTime(ev.startAt)}{#if ev.endAt}{' – '}{formatTime(ev.endAt)}{/if}{/if}
                      </span>
                      <span class="event-title">{ev.title}</span>
                      {#if ev.location}<span class="event-meta">{ev.location}</span>{/if}
                      {#if ev.reminderMinutes}<span class="event-meta">Reminder {ev.reminderMinutes}m before</span>{/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {:else}
        <section class="card compact">
          <div class="card-head">
            <h2>{formatDayLabel(selected)}</h2>
            <button class="solid sm" on:click={() => openNew(selected)}>New event</button>
          </div>
        </section>
      {/if}

      <section class="card grow">
        <div class="card-head"><h2>Upcoming</h2></div>
        {#if upcoming.length === 0}
          <p class="empty">Nothing in 30 days.</p>
        {:else}
          <ul class="list">
            {#each upcoming as ev (ev.id)}
              <li>
                <button class="event" on:click={() => { selectDay(new Date(ev.startAt)); openEdit(ev); }}>
                  <span class="bar" style={`background:${calendarColor(ev.calendarId)}`}></span>
                  <span class="event-body">
                    <span class="event-time">
                      {formatShortDay(ev.startAt)}{#if !ev.allDay} · {formatTime(ev.startAt)}{/if}
                    </span>
                    <span class="event-title">{ev.title}</span>
                    {#if ev.seriesId}<span class="event-meta">Series: {ev.recurrence}</span>{/if}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </aside>
  </div>

  {#if panel}
    <div class="scrim" on:click={closePanel} on:keydown={e => e.key === 'Escape' && closePanel()} role="presentation"></div>
    <section class="panel" aria-label={panel.id ? 'Edit event' : 'New event'}>
      <header class="panel-head">
        <h2>{panel.id ? 'Edit event' : 'New event'}</h2>
        <button class="icon" on:click={closePanel} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </header>

      <div class="panel-body">
        {#if panel.isOccurrence}
          <p class="note">This is a series event. Saving updates <strong>all</strong> dates. Use “Skip date” for one.</p>
        {/if}

        <label class="field">
          <span>Title</span>
          <input type="text" bind:value={panel.title} placeholder="e.g. Dentist" />
        </label>

        <label class="check">
          <input type="checkbox" bind:checked={panel.allDay} />
          <span>All day</span>
        </label>

        {#if panel.allDay}
          <label class="field">
            <span>Date</span>
            <input type="date" bind:value={panel.startDate} />
          </label>
        {:else}
          <label class="field">
            <span>Start</span>
            <input type="datetime-local" bind:value={panel.startAt} />
          </label>
          <label class="field">
            <span>End <em>(blank = 1h)</em></span>
            <input type="datetime-local" bind:value={panel.endAt} />
          </label>
        {/if}

        <label class="field">
          <span>Repeat</span>
          <select bind:value={panel.recurrence}>
            <option value="none">Never</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>

        {#if panel.recurrence !== 'none'}
          <label class="field">
            <span>Repeat until <em>(optional)</em></span>
            <input type="date" bind:value={panel.recurrenceUntil} />
          </label>
        {/if}

        <label class="field">
          <span>Location</span>
          <input type="text" bind:value={panel.location} placeholder="Optional" />
        </label>

        <label class="field">
          <span>Reminder <em>(minutes before)</em></span>
          <input type="number" min="0" bind:value={panel.reminderMinutes} placeholder="None" />
        </label>

        {#if calendars.length > 1}
          <label class="field">
            <span>Calendar</span>
            <select bind:value={panel.calendarId}>
              {#each calendars as cal (cal.id)}<option value={cal.id}>{cal.name}</option>{/each}
            </select>
          </label>
        {/if}

        <label class="field">
          <span>Tags <em>(comma-separated)</em></span>
          <input type="text" bind:value={panel.tags} placeholder="health, personal" />
        </label>

        <label class="field">
          <span>Description</span>
          <textarea rows="4" bind:value={panel.description} placeholder="Optional"></textarea>
        </label>

        {#if panel.id}
          <label class="check">
            <input
              type="checkbox"
              checked={panel.status === 'cancelled'}
              on:change={e => (panel.status = e.currentTarget.checked ? 'cancelled' : 'confirmed')}
            />
            <span>Cancelled <em>(kept in calendar)</em></span>
          </label>
        {/if}

        {#if panel.isOccurrence}
          <div class="occurrence">
            {#if confirmingSkip}
              <button class="ghost danger-text" on:click={skipThisOccurrence} disabled={saving}>Confirm skip date</button>
              <button class="ghost" on:click={() => (confirmingSkip = false)}>Back</button>
            {:else}
              <button class="ghost" on:click={() => (confirmingSkip = true)} disabled={saving}>Skip date</button>
            {/if}
          </div>
        {/if}
      </div>

      <footer class="panel-foot">
        {#if panel.id}
          {#if confirmingDelete}
            <button class="danger" on:click={removeEvent} disabled={saving}>Confirm delete</button>
            <button class="ghost" on:click={() => (confirmingDelete = false)}>Back</button>
          {:else}
            <button class="ghost danger-text" on:click={() => (confirmingDelete = true)} disabled={saving}>Delete</button>
          {/if}
        {/if}
        <span class="spacer"></span>
        <button class="ghost" on:click={closePanel}>Cancel</button>
        <button class="solid" on:click={savePanel} disabled={saving || !panel.title.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </section>
  {/if}
</div>

<style>
  .agenda {
    --tk-radius-md: 8px;
    --tk-radius-lg: 14px;
    --tk-font: 'Ubuntu', system-ui, sans-serif;
    min-height: 100dvh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    font-family: var(--tk-font);
    background: var(--tk-bg);
    color: var(--tk-text);
    overflow: hidden;
  }

  .agenda[data-theme='dark'] {
    --tk-bg: #111111;
    --tk-surface: #181818;
    --tk-surface-2: #1f1f1f;
    --tk-border: rgba(255, 255, 255, .09);
    --tk-border-hi: rgba(255, 255, 255, .16);
    --tk-text: #f5f5f5;
    --tk-muted: #888888;
    --tk-muted-2: rgba(136, 136, 136, .5);
    --tk-accent: #f5f5f5;
    --tk-on-accent: #111111;
  }

  .agenda[data-theme='light'] {
    --tk-bg: #ffffff;
    --tk-surface: #f5f5f5;
    --tk-surface-2: #ececec;
    --tk-border: rgba(0, 0, 0, .10);
    --tk-border-hi: rgba(0, 0, 0, .18);
    --tk-text: #1a1a1a;
    --tk-muted: #666666;
    --tk-muted-2: rgba(0, 0, 0, .4);
    --tk-accent: #111111;
    --tk-on-accent: #ffffff;
  }

  .agenda :global(*) { box-sizing: border-box; }

  /* ── Topbar ── */
  .topbar {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 18px; border-bottom: 1px solid var(--tk-border); background: var(--tk-surface);
  }
  .nav { display: flex; align-items: center; gap: 8px; }
  .calendar-icon { width: 20px; height: 20px; color: var(--tk-text); flex: none; }
  .nav h1 { margin: 0; font-size: 17px; font-weight: 500; min-width: 215px; }

  .modes { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md); }
  .mode {
    height: 26px; padding: 0 12px; background: transparent; color: var(--tk-muted);
    border: none; border-radius: 6px;
  }
  .mode.active { background: var(--tk-accent); color: var(--tk-on-accent); font-weight: 500; }

  .quick { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 260px; }
  .quick-icon { width: 16px; height: 16px; color: var(--tk-muted); flex: none; }
  .quick input { flex: 1; }

  /* ── Controles ── */
  input, textarea, select {
    height: 34px; padding: 0 10px; font: inherit; font-size: 13px;
    background: var(--tk-bg); color: var(--tk-text);
    border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md);
    outline: none; transition: border-color 200ms ease-out;
  }
  textarea { height: auto; padding: 8px 10px; resize: vertical; }
  input:focus, textarea:focus, select:focus { border-color: var(--tk-border-hi); }

  button {
    font: inherit; font-size: 13px; cursor: pointer; border-radius: var(--tk-radius-md);
    transition: transform 200ms ease-out, opacity 200ms ease-out;
  }
  button:disabled { opacity: .5; cursor: default; }
  button:not(:disabled):active { transform: scale(.97); }

  .icon {
    width: 32px; height: 32px; display: grid; place-items: center; flex: none;
    background: transparent; color: var(--tk-text); border: 1px solid var(--tk-border);
  }
  .icon svg { width: 16px; height: 16px; }

  .ghost {
    height: 32px; padding: 0 12px; background: transparent; color: var(--tk-text);
    border: 1px solid var(--tk-border);
  }
  .solid {
    height: 32px; padding: 0 14px; background: var(--tk-accent); color: var(--tk-on-accent);
    border: 1px solid var(--tk-accent); font-weight: 500;
  }
  .solid.sm { height: 28px; padding: 0 10px; font-size: 12px; }
  .danger { height: 32px; padding: 0 12px; background: var(--tk-text); color: var(--tk-bg); border: 1px solid var(--tk-text); }
  .danger-text { color: var(--tk-text); }

  .error {
    margin: 10px 18px 0; padding: 8px 12px; font-size: 13px;
    border: 1px solid var(--tk-border-hi); border-radius: var(--tk-radius-md);
    background: var(--tk-surface-2); color: var(--tk-text);
  }

  /* ── Layout ── */
  .body { flex: 1; display: flex; gap: 14px; padding: 14px 18px 18px; min-height: 0; }
  .calendar { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .side { width: 300px; flex: none; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .card {
    display: flex; flex-direction: column; min-height: 0; max-height: 100%;
    border: 1px solid var(--tk-border); border-radius: var(--tk-radius-lg);
    background: var(--tk-surface); padding: 12px;
  }
  .card.grow { flex: 1; }
  .card.compact { flex: none; }

  /* ── Grade mensal ── */
  .weekdays {
    display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px;
    font-size: 11px; color: var(--tk-muted); text-transform: uppercase; letter-spacing: .04em;
    padding-bottom: 6px;
  }
  .weekdays span { text-align: center; }

  .grid {
    flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); grid-template-rows: repeat(6, 1fr);
    gap: 4px; min-height: 0; transition: opacity 200ms ease-out;
  }
  .grid.loading, .week.loading, .day-view.loading { opacity: .6; }

  .cell {
    display: flex; flex-direction: column; align-items: stretch; gap: 3px; overflow: hidden;
    padding: 5px 6px; text-align: left; min-height: 0;
    background: var(--tk-surface); color: var(--tk-text);
    border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md);
  }
  .cell.outside { background: transparent; color: var(--tk-muted-2); }
  .cell.selected { border-color: var(--tk-border-hi); background: var(--tk-surface-2); }
  .cell.today .daynum {
    background: var(--tk-accent); color: var(--tk-on-accent);
    border-radius: 999px; width: 20px; height: 20px; display: grid; place-items: center;
  }
  .daynum { font-size: 12px; font-weight: 500; flex: none; }

  .chips { display: flex; flex-direction: column; gap: 2px; overflow: hidden; min-height: 0; }
  .chip { display: flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1.4; min-width: 0; }
  .chip.cancelled { text-decoration: line-through; color: var(--tk-muted); }
  .dot { width: 6px; height: 6px; border-radius: 999px; flex: none; }
  .chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .more { font-size: 10px; color: var(--tk-muted); }

  /* ── Semana ── */
  .week {
    flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px;
    min-height: 0; transition: opacity 200ms ease-out;
  }
  .col {
    display: flex; flex-direction: column; min-height: 0; overflow: hidden;
    border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md); background: var(--tk-surface);
  }
  .col.selected { border-color: var(--tk-border-hi); }
  .col-head {
    display: flex; align-items: baseline; gap: 6px; padding: 8px 8px 6px;
    background: transparent; color: var(--tk-text); border: none; border-bottom: 1px solid var(--tk-border);
    border-radius: 0; text-align: left;
  }
  .col-wd { font-size: 11px; color: var(--tk-muted); text-transform: uppercase; letter-spacing: .04em; }
  .col-num { font-size: 13px; font-weight: 500; }
  .col.today .col-num {
    background: var(--tk-accent); color: var(--tk-on-accent);
    border-radius: 999px; width: 20px; height: 20px; display: inline-grid; place-items: center; font-size: 11px;
  }
  .col-body { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
  .col-empty { font-size: 11px; color: var(--tk-muted-2); text-align: center; padding-top: 4px; }

  .slot {
    display: flex; align-items: flex-start; gap: 5px; padding: 5px 6px; text-align: left; min-width: 0;
    background: var(--tk-bg); color: var(--tk-text);
    border: 1px solid var(--tk-border); border-radius: 6px;
  }
  .slot.cancelled .slot-title { text-decoration: line-through; color: var(--tk-muted); }
  .slot .dot { margin-top: 5px; }
  .slot-text { display: flex; flex-direction: column; min-width: 0; }
  .slot-time { font-size: 10px; color: var(--tk-muted); }
  .slot-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Dia ── */
  .day-view {
    flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 4px;
    border: 1px solid var(--tk-border); border-radius: var(--tk-radius-lg);
    background: var(--tk-surface); padding: 12px; transition: opacity 200ms ease-out;
  }
  .allday, .hour { display: flex; gap: 10px; align-items: flex-start; padding: 4px 0; }
  .allday { border-bottom: 1px solid var(--tk-border); padding-bottom: 8px; margin-bottom: 4px; }
  .rail-label { width: 62px; flex: none; font-size: 11px; color: var(--tk-muted); padding-top: 9px; }
  .rail-items { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }

  /* ── Listas de evento (compartilhadas) ── */
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 10px; }
  .card-head h2 { margin: 0; font-size: 13px; font-weight: 500; }
  .empty { font-size: 13px; color: var(--tk-muted); margin: 8px 0 0; }

  .list { list-style: none; margin: 0; padding: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .event {
    width: 100%; display: flex; gap: 8px; padding: 8px; text-align: left;
    background: var(--tk-bg); color: var(--tk-text);
    border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md);
  }
  .event.cancelled .event-title { text-decoration: line-through; color: var(--tk-muted); }
  .bar { width: 3px; border-radius: 999px; flex: none; }
  .event-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .event-time { font-size: 11px; color: var(--tk-muted); }
  .event-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
  .event-meta { font-size: 11px; color: var(--tk-muted); }

  /* ── Painel lateral ── */
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100%);
    display: flex; flex-direction: column;
    background: var(--tk-surface); border-left: 1px solid var(--tk-border);
    animation: slide-in 240ms ease-out;
  }
  @keyframes slide-in { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }

  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--tk-border);
  }
  .panel-head h2 { margin: 0; font-size: 14px; font-weight: 500; }
  .panel-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
  .panel-foot {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 16px; border-top: 1px solid var(--tk-border);
  }
  .spacer { flex: 1; }

  .note {
    margin: 0; padding: 8px 10px; font-size: 12px; color: var(--tk-muted);
    background: var(--tk-surface-2); border: 1px solid var(--tk-border); border-radius: var(--tk-radius-md);
  }
  .note strong { color: var(--tk-text); font-weight: 500; }
  .occurrence { display: flex; gap: 8px; padding-top: 4px; }

  .field { display: flex; flex-direction: column; gap: 5px; }
  .field > span { font-size: 12px; color: var(--tk-muted); }
  .field em { font-style: normal; color: var(--tk-muted-2); }
  .check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .check input { width: 15px; height: 15px; }
  .check em { font-style: normal; color: var(--tk-muted); font-size: 12px; }

  @media (max-width: 860px) {
    .body { flex-direction: column; overflow-y: auto; }
    .side { width: 100%; }
    .grid { min-height: 380px; }
    .week { min-height: 320px; }
  }
</style>
