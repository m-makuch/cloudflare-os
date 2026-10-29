# Worker issue inbox

## Source and interface

The TypeScript sources (`client.ts`, `server.ts`, and `lib/`) build into the self-contained
`client.js` and `server.js` the gadget runs. The browser, server, and OS setup frontend share the
`lib/protocol.ts` contract through `protocol.d.ts`.

The inbox displays each logical notification separately, including repeated occurrences of the same
issue. Refresh updates entries in place so unchanged reports keep their text selection. Notification
receipt and optional AI enablement are displayed separately. Polls fetch summaries, full reports load
when opened, and polling pauses while the tab is hidden. The UI uses semantic system colors for
light and dark surfaces without adding a separate brand palette.

This inbox accepts authenticated Real-Time Issues notifications only for its configured account
and Worker. Connect it from the dashboard's Cloudflare OS destination setup and enable its
notification hook. The only required binding is `CLOUDFLARE_NOTIFICATIONS`; receiving notifications
does not require a language model or telemetry access. The dashboard owns automation policy creation.

## Optional AI investigations

After saving the automation, the dashboard offers AI investigation setup for this same inbox.
OS reuses an available preferred language model, or asks the user to choose one, and authorizes
read-only telemetry for the configured Worker. Setup adds an `INVESTIGATOR` spawner whose
`WORKER_OBSERVABILITY` binding is restricted to that Worker, replacing any existing investigator
binding and applying the selected model, then explicitly enables investigations. Workspace editors
can change its bindings later; the gadget cannot independently attest their scope.
The investigator also receives a task reporting capability. It has no repository, project-test
runner, or deployment capability. Notification and log text are untrusted evidence.

Notifications received before enablement remain `received` inbox entries. Enabling investigations
does not replay them. Investigating the issue the user came from is a separate, unchecked-by-default
option, dispatched by the dashboard only after the automation is saved and AI setup is verified.

Each logical notification run is accepted durably as `pending`; allocation and dispatch run from an
alarm, outside the notification callback. Replayed webhook envelopes do not start another investigation.
Failures before dispatch become `failed` and offer explicit retry. Ambiguous dispatches remain
`delivery_unknown` for inspection rather than being resent automatically. Conflicting issue IDs for
the same run increment a durable diagnostic counter without triggering provider retries.

## Deployment

Release the OS setup frontend and blueprint together. Dashboard setup uses `/setup/workers-issues`;
home-page setup links redirect there, and unrelated routes never interpret the setup query. Only
development builds accept localhost dashboard origins. Updating a blueprint never opts an inbox
into AI: investigations require explicit enablement.
