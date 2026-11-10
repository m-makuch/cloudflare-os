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

After saving the automation, the dashboard offers AI investigation setup for this same inbox. The
inbox page links to the same OS setup (`/setup/workers-issues` with no dashboard origin, naming its
workspace and destination), so investigations can be set up later from the workspace. Either way
OS reuses an available preferred language model, or asks the user to choose one, and authorizes
read-only telemetry for the configured Worker. Setup adds an `INVESTIGATOR` spawner whose
`WORKER_OBSERVABILITY` binding is restricted to that Worker, replacing any existing investigator
binding and applying the selected model. Dashboard setup then enables automatic investigations;
setup from the inbox lets the user choose them or investigate on request only. Workspace editors
can change its bindings later; the gadget cannot independently attest their scope.
The investigator also receives a task reporting capability. It has no repository, project-test
runner, or deployment capability. Notification and log text are untrusted evidence.

The inbox has three modes: notifications only (no investigator bound), on request (an investigator
is bound, `investigationsEnabled` is off), and automatic (every new notification starts a run).
Notifications received before automatic runs remain `received` inbox entries; enabling them does
not replay anything. Any `received` entry can be investigated once on request
(`investigateNotification`) with the bound investigator, a fix run when fixes are on. Without an
investigator, its inbox link opens setup and investigates that entry once bound. From the inbox page
a user can also turn automatic runs on or off; binding an investigator is only setup's, since it
needs consent and a model. Investigating the issue the user came from in the dashboard is a separate,
unchecked-by-default option, dispatched by the dashboard only after the automation is saved and AI
setup is verified.

Each logical notification run is accepted durably as `pending`; allocation and dispatch run from an
alarm, outside the notification callback. Replayed webhook envelopes do not start another investigation.
Failures before dispatch become `failed` and offer explicit retry. Ambiguous dispatches remain
`delivery_unknown` for inspection rather than being resent automatically. Conflicting issue IDs for
the same run increment a durable diagnostic counter without triggering provider retries.

## Optional AI fixes

With an investigator bound, setup can also connect a repository and enable fixes. Replacing the
investigator without a repository turns fixes off. The
`REPOSITORY` binding must be a contributor binding (GitLab `GITLAB_PROJECT_CONTRIBUTOR` or GitHub
`GITHUB_REPO_CONTRIBUTOR`): the gatekeeper lets it push only to branches under its prefix (by default
`cloudflare-os/`), never force, never to the default or a protected branch, and open requests only
into the default branch; it refuses public repositories unless the user allowed them, checked again
when each write applies. `enableFixes()` refuses a binding that reports no branch prefix. Setup gives
the `INVESTIGATOR` spawner the same `REPOSITORY` binding as the inbox.

A run dispatched while fixes are enabled is a fix run for life, and an investigation stays an
investigation. Its branch, `<prefix>fix/<issue>-<hash of the run>`, is chosen before dispatch and
reused on retry, so the git host's one-open-request-per-branch rule bounds duplicates. The fixer
reports the request it opened (`push_pending` while its push and creation wait for approval,
`change_opened` once it exists); the page asks the inbox to re-read pending requests, at most once a
minute per run. An ambiguous fix dispatch is `fix_unknown`, and retrying it first lists the requests
from its branch: one found there is shown instead of attempted again.

The fixer's instructions require scrubbing personal and secret data from code, tests, commit
messages, and descriptions before committing. Nothing is merged or deployed by the inbox or the
fixer: a person merges, and the project's CI deploys. Whether each push and request waits for a
person is the workspace's approval setting for the repository binding, chosen at setup.

## Deployment

Release the OS setup frontend and blueprint together. Updating the blueprint never enables fixes. Dashboard and inbox setup use `/setup/workers-issues`;
home-page setup links redirect there, and unrelated routes never interpret the setup query. Only
development builds accept localhost dashboard origins. Updating a blueprint never opts an inbox
into AI: investigations require explicit enablement.
