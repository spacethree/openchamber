# Platform Connector

## Purpose

Links one OpenChamber instance to one Humble Good Site so the platform can see
the instance and know what it can run. The link is outbound only. The runner box
sits on a tailnet the platform cannot dial, so nothing here listens for the
platform, and no OpenChamber URL or credential is stored on the platform side.

This is the S1 skeleton: enrollment, heartbeat, and a status read. Claiming and
running work arrives in S2.

## Protocol

Two calls, both `POST` to the Site host.

`/api/work/mill/enroll` sends `{ token, name, capabilities }` and answers `200`
with `{ serverId, siteId, serverToken }`. The token is the one-time enrollment
token an operator mints in the Site's ProjectWorks settings panel. The
`serverToken` it returns is a long-lived per-server bearer.

`/api/work/mill/heartbeat` sends `{ capabilities }` with
`Authorization: Bearer <serverToken>` and answers `200`. A `401` means the
platform revoked this server.

## Environment

| Variable | Purpose |
|---|---|
| `OPENCHAMBER_PLATFORM_URL` | Site origin, for example `https://www.example.com`. Read only during first enrollment. |
| `OPENCHAMBER_PLATFORM_ENROLL_TOKEN` | One-time enrollment token from the settings panel. |
| `OPENCHAMBER_PLATFORM_SERVER_NAME` | Name the platform shows for this server. Defaults to the hostname. |

Both `OPENCHAMBER_PLATFORM_URL` and `OPENCHAMBER_PLATFORM_ENROLL_TOKEN` must be
set for enrollment to be attempted. Once a bearer is stored the env is ignored
entirely, including the platform URL, so leaving a spent token in the unit file
does nothing.

## Config file

`<OPENCHAMBER_DATA_DIR>/platform-connector.json`, directory `0700`, file `0600`.

```json
{
  "platformUrl": "https://www.example.com",
  "siteId": "…",
  "serverId": "…",
  "serverToken": "…",
  "name": "hgn-agents",
  "enrolledAt": "2026-08-27T12:00:00.000Z",
  "revokedAt": "2026-08-28T09:14:00.000Z"
}
```

Written through a temp file and a rename, so a reader never sees a half-written
config. The mode is re-applied on every save, because `writeFile`'s mode applies
only when it creates the file and a config copied into place by hand would
otherwise keep whatever permissions it arrived with.

Fields outside that list are dropped on save and ignored on load. A config
missing `platformUrl`, `serverId`, or `serverToken` reads as no config at all:
a half-identified connector would heartbeat with a bearer that does not exist.

`revokedAt` is written when the platform answers a heartbeat with `401`, so a
restart does not resurrect a loop the platform already ended.

## Status route

`GET /api/openchamber/platform-connector/status` returns:

```json
{
  "enrolled": true,
  "platformUrl": "https://www.example.com",
  "siteId": "…",
  "serverId": "…",
  "name": "hgn-agents",
  "status": "connected",
  "lastHeartbeatAt": "2026-08-27T12:00:00.000Z",
  "lastError": null
}
```

`status` is one of `unenrolled`, `connected`, `revoked`, `error`. The bearer is
never in the response, never in a log line, and never in an error message.

The route is registered with the other feature routes, which sit behind the
`/api` auth gate in `core-routes`. It is deliberately not registered the way the
agent-tool callback is: that one runs before the gate because it carries its own
per-child token, and registering this one there would publish the connector's
platform identity unauthenticated.

## Failure behaviour

Enrollment runs at most once per process. A rejected or unreachable platform
leaves the instance unenrolled with nothing written; the operator mints a new
token and restarts the unit. There is no retry timer, because retrying a
single-use credential only gives the platform something to rate-limit.

A heartbeat failure never stops the loop unless the platform says so. A network
error or a non-`401` rejection sets `status` to `error`, records `lastError`, and
keeps ticking. A `401` sets `status` to `revoked`, persists `revokedAt`, and
stops the timer.

Log lines are emitted on state change, not per tick. A tailnet outage would
otherwise print the same warning twice a minute for as long as it lasts.

Heartbeats do not overlap. A tick that arrives while the previous request is
still in flight is skipped rather than queued.

## Capabilities

Collected fresh on every heartbeat and reported as
`{ uiUrl?, openchamberVersion, opencodeVersion, models, agents, projects }`.

- `models` is the full `provider/model` catalog from OpenCode's
  `/config/providers`. When OpenCode cannot answer, it falls back to the
  operator's recorded default, favorite, and recent models from the control
  service's `models.list`: those are already `provider/model` strings and are
  what the operator actually uses, so the platform can still dispatch work while
  OpenCode restarts.
- `agents` are the names from OpenCode's `/agent`.
- `projects` are the configured project **directories** from the control
  service's `projects.list`. Directories, not ids, because the platform
  dispatches a session against a checkout path and an id means nothing outside
  this instance's settings.
- `opencodeVersion` comes from OpenCode's `/global/health` unless the caller
  already knows it.
- `uiUrl` is this instance's own listener origin. It is the only address the
  server can state as fact; a reachable external URL is the operator's tunnel or
  tailnet name, so the field is loopback until a later slice has somewhere
  truthful to get it from.

Every field is collected independently. A failure costs the platform that one
field, never the whole report, and is logged at debug: a heartbeat that failed
outright would read as a dead server.

## Lifecycle

Created in `server/index.js` beside the other runtimes, after the control
service it needs for its capability report and before the graceful shutdown
runtime that has to stop it. `start()` runs after the listener is up and OpenCode
has been bootstrapped, alongside `scheduledTasksRuntime.start()`, so the first
heartbeat reports a real catalog instead of an empty one. It is not awaited: a
slow or unreachable platform must not hold up a server that is already serving.
`stop()` clears the timer from `gracefulShutdown`.
