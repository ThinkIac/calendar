# Calendar

Event-driven calendar for ThinkIac. It is a Lógos package with a Calendar menu view, HTTP API, MCP tools, persisted data, and `calendar:*` domain events.

## Instalação responsável

Antes de adicionar este pacote ao seu workspace, peça ao seu assistente de IA para revisar o código e as permissões necessárias no seu ambiente. Quando a análise estiver concluída, solicite a instalação no workspace que estiver ativo.

## How it works

The package stores calendars and events through the Lógos `getProxy('calendar')` data proxy. The same handlers serve the UI, HTTP routes, and MCP tools, so each entry point has identical validation and side effects.

Creating, updating, cancelling, deleting, or skipping an event emits a domain event. A 60-second scan also emits reminder and start events. Other ThinkIac packages can subscribe to these events without depending on the Calendar UI or API.

At boot, Calendar creates a default **Personal** calendar when no calendar exists and starts the scan.

## HTTP endpoints

The package route prefix is `/calendar`. Responses contain the runtime-unwrapped route result.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/calendar/events` | List events. Supports `from`, `to`, `calendarId`, `tag`, `search`, `status`, and `sort`. |
| `POST` | `/calendar/events` | Create an event. |
| `GET` | `/calendar/events/:id` | Get one stored event. |
| `PATCH` | `/calendar/events/:id` | Update an event. |
| `DELETE` | `/calendar/events/:id` | Soft-delete an event. |
| `POST` | `/calendar/create-from-text` | Create an event from natural language. |
| `POST` | `/calendar/skip-occurrence` | Skip one occurrence in a recurring series. |
| `GET` | `/calendar/calendars` | List calendars. |
| `POST` | `/calendar/calendars` | Create a calendar. |

Example:

```http
POST /calendar/events
Content-Type: application/json

{
  "title": "Design review",
  "startAt": "2026-11-14T14:00:00-03:00",
  "endAt": "2026-11-14T15:00:00-03:00",
  "location": "Room A",
  "reminderMinutes": 15,
  "tags": ["work", "design"]
}
```

`title` and `startAt` are required. Dates must be ISO-8601. An event without `endAt` receives a one-hour duration unless it is all-day.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `calendar_createEvent` | Create an event from structured data. |
| `calendar_createEventFromText` | Extract and create an event from natural language. |
| `calendar_getEvent` | Get an event by ID. |
| `calendar_updateEvent` | Update an event. |
| `calendar_deleteEvent` | Soft-delete an event. |
| `calendar_skipOccurrence` | Skip one occurrence of a recurring event. |
| `calendar_listEvents` | List and paginate events. |
| `calendar_listCalendars` | List calendars. |

Tool arguments accept the documented object shape, including flattened MCP fields such as `data.title` and `filters.from`. `calendar_listEvents` uses `filters.limit` and `filters.offset`; its limit is capped at 200.

Example tool input:

```json
{
  "data": {
    "title": "Team sync",
    "startAt": "2026-11-14T09:00:00-03:00",
    "recurrence": "weekly",
    "reminderMinutes": 10
  }
}
```

## Domain events

Each event payload includes stable calendar data such as `id`, `title`, `startAt`, `endAt`, `allDay`, `calendarId`, `tags`, `status`, and `recurrence`.

| Event | When it is emitted | Extra fields |
| --- | --- | --- |
| `calendar:created` | An event is created. | — |
| `calendar:updated` | An event is updated. | `changes` |
| `calendar:cancelled` | Status changes to `cancelled`. | — |
| `calendar:deleted` | An event is soft-deleted. | — |
| `calendar:occurrence_skipped` | One recurring occurrence is skipped. | `occurrenceStart` |
| `calendar:reminder_due` | A reminder becomes due. | `reminderMinutes`, `minutesUntilStart` |
| `calendar:started` | An event occurrence has started. | — |

Listen through Lógos with `dispatchEvent` consumers or the runtime event subscription mechanism. Calendar itself uses `dispatchEvent('calendar:*', payload)` as its integration contract.

## Key features

- Multiple color-coded calendars. The first is created automatically as **Personal**.
- Single and all-day events with descriptions, locations, tags, status, source, and external IDs.
- Daily, weekly, and monthly recurrence. A query with `from` and `to` expands recurring series into occurrences.
- Skip a single recurrence without changing the series. Occurrence IDs have the form `<seriesId>@<ISO start>`; use `seriesId` to edit or delete the stored series.
- Exact tag filtering, text search across title, description, and location, status filtering, sorting, and pagination through MCP.
- Natural-language creation uses the ThinkIac agent host only to extract structured fields. Creation and validation remain deterministic in Calendar.
- Reminder notifications integrate with `ntfy` when that package is available. Missing optional notification or scheduler packages do not block event CRUD.
- One-time reminders are checked every 60 seconds with persistent idempotency guards. Recurring reminders are synchronized to the `scheduler` package as cron jobs.

## Data behavior

Events use `confirmed` or `cancelled` status. Cancelling preserves the event and emits `calendar:cancelled`; deleting is a soft delete and emits `calendar:deleted`.

Recurrence values are `none`, `daily`, `weekly`, or `monthly`. Recurring events are expanded only when a date range is supplied, which keeps open-ended series finite. A recurrence can have `recurrenceUntil` and excluded occurrence dates in `exdates`.

All stored times are normalized to UTC ISO-8601 values. The UI and natural-language parser resolve local presentation and relative dates separately.

## ThinkIac and Lógos integration

| Layer | Lógos / ThinkIac role |
| --- | --- |
| Data | `getProxy('calendar')` persists `Calendar` and `Event` records from `schema.prisma`. |
| HTTP | `@register_router` declarations expose the `/calendar` endpoints. |
| MCP | `@register_tool` declarations expose the `calendar_*` tools. |
| Events | `dispatchEvent` publishes `calendar:*` domain events. |
| Lifecycle | `@register_hook boot` seeds data and starts the reminder scan. |
| AI | ThinkIac's agent host parses natural language with a schema-constrained, single-step task. |
| UI | The package manifest registers the left-side Calendar view and calendar icon. |

## Development

```bash
npm test --prefix apps/thinkiac/packages/calendar
```

The contract test verifies the package identity, data namespace, route base, event namespace, and tool registration.
