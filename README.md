# Nest Runtime Tracker (SmartFilterPro)

A minimal Express + Postgres service that ingests Nest-like events, tracks runtime sessions
(heating / cooling / fan-timer), posts temperature and runtime data to Bubble, and persists
device state so restarts don't lose context.

## Quick start

1. Copy `.env.example` to `.env` and fill values.
2. Run DB init:
   ```bash
   npm install
   node tools/init-db.js
   ```
3. Start:
   ```bash
   npm start
   ```

## Endpoints

- `POST /nest/event` — Ingest a Nest event (structure documented in `nestAdapter.js`).
- `DELETE /users/:userId` — Hard-delete a user and all their devices/data.
- `GET /health` — Health probe.

## Tables

- `device_status`
- `equipment_events`
- `runtime_session`
- `temp_readings`

See `schema.sql` for columns.
