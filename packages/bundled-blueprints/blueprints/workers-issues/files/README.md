# Worker issue inbox

## Source and interface

The TypeScript sources (`client.ts`, `server.ts`, and `lib/`) build into the self-contained
`client.js` and `server.js` the gadget runs. Both sides use `lib/protocol.ts`; `protocol.d.ts`
preserves the OS setup frontend's existing type import. Stored inbox data needs no migration.

The inbox displays each logical notification separately, including repeated occurrences of the same
issue. Refresh updates entries in place so unchanged reports keep their text selection. Notification
receipt and optional AI enablement are displayed separately. The UI uses semantic system colors for
light and dark surfaces without adding a separate brand palette.

This inbox accepts authenticated Real-Time Issues notifications only for its configured account
and Worker. Connect it from the dashboard's Cloudflare OS destination setup and enable its
notification hook. The only required binding is `CLOUDFLARE_NOTIFICATIONS`; receiving notifications
does not require a language model or telemetry access. The dashboard owns automation policy creation.

## Optional AI investigations

After saving the automation, the dashboard offers AI investigation setup for this same inbox.
OS reuses an available preferred language model, or asks the user to choose one, and authorizes
read-only telemetry for the configured Worker. Setup adds an `INVESTIGATOR` spawner whose
`WORKER_OBSERVABILITY` binding is restricted to that Worker, then explicitly enables investigations.
The investigator also receives a task reporting capability. It has no repository, project-test
runner, or deployment capability. Notification and log text are untrusted evidence.

Notifications received before enablement remain `received` inbox entries. Enabling investigations
does not replay them. Investigating the issue the user came from is a separate, unchecked-by-default
option, dispatched by the dashboard only after the automation is saved and AI setup is verified.

Each logical notification run is claimed durably before an investigator is allocated; replayed
webhook envelopes do not start another investigation. Ambiguous dispatches remain visible as
`delivery_unknown` for inspection rather than being resent automatically.

## Existing installations

The OS setup frontend and this blueprint must be released together. An older inbox needs the updated
blueprint code before optional setup can call `getSetupStatus()` and `enableInvestigations()`.
Updating the blueprint does not opt an existing inbox into AI: it requires explicit enablement.
