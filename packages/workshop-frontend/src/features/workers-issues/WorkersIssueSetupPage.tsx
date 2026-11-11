import { useEffect, useRef, useState } from "react";
import { Banner, Button, Checkbox, Dialog, Input, LinkButton, Select, Switch } from "@cloudflare/kumo";
import type { AiChatAuthorInfo, GatekeeperVendorInfo } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import type { CloudflareAccountConfiguratorRpc } from "../../../../gatekeeper-cloudflare/src/configurator/cloudflare-configurator-types";
import { useAuthenticatedApi } from "../../AuthContext";
import { authorizeRepositoryAccount } from "./authorizeRepositoryAccount";
import { FIX_BRANCH_PREFIX, resolveContributorRepository } from "./contributorRepository";
import { provisionWorkersIssueInbox } from "./provisionWorkersIssueInbox";
import {
  NOTIFICATIONS_PATTERN,
  RELEASES_PATTERN,
  WORKER_PATTERN,
  useWorkersIssueConnections,
} from "./useWorkersIssueConnections";
import { respondToWorkersIssueSetup, type WorkersIssueSetupRequest } from "./workersIssueSetup";

const DESTINATION_PATTERNS = [NOTIFICATIONS_PATTERN];
const INVESTIGATION_PATTERNS = [WORKER_PATTERN];
const FIX_PATTERNS = [WORKER_PATTERN, RELEASES_PATTERN];

export const WorkersIssueSetupPage = ({ request }: { request: WorkersIssueSetupRequest }) => {
  const { authenticatedApi } = useAuthenticatedApi();
  const isInvestigation = Boolean(request.investigation);
  // Opened from the inbox rather than handed off by the dashboard: nothing is reported back.
  const fromInbox = !request.dashboardOrigin;
  const remediation =
    request.remediation ?? (fromInbox ? { allowPublic: false } : undefined);
  const [fixesWanted, setFixesWanted] = useState(Boolean(request.remediation));
  const fixing = Boolean(remediation) && fixesWanted;
  const connection = useWorkersIssueConnections(
    authenticatedApi,
    request.accountId,
    fixing ? FIX_PATTERNS : isInvestigation ? INVESTIGATION_PATTERNS : DESTINATION_PATTERNS,
  );
  const [accountId, setAccountId] = useState("");
  const [modelSettings, setModelSettings] = useState<{
    models: AiChatAuthorInfo[];
    preferred: string | null;
  }>();
  const [modelId, setModelId] = useState("");
  const [changeModel, setChangeModel] = useState(false);
  const [investigateCurrent, setInvestigateCurrent] = useState(false);
  // A user who came to investigate one notification has not asked for every later one.
  const [automatic, setAutomatic] = useState(!request.runKey);
  const [repositoryUrl, setRepositoryUrl] = useState(remediation?.repositoryUrl ?? "");
  const [allowPublic, setAllowPublic] = useState(remediation?.allowPublic ?? false);
  const [confirmingPublic, setConfirmingPublic] = useState(false);
  const [publicAcknowledged, setPublicAcknowledged] = useState(false);
  const [vendors, setVendors] = useState<GatekeeperVendorInfo[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState<{
    destinationId: string;
    workspaceId: string;
    investigationsEnabled: boolean;
    investigateCurrent: boolean;
    investigated?: boolean;
  }>();
  const [workspaceId, setWorkspaceId] = useState(() => {
    if (request.investigation) return request.investigation.workspaceId;
    try {
      return sessionStorage.getItem(`workers-issue-setup:${request.state}`) ?? "";
    } catch {
      return "";
    }
  });
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), []);
  const selectedAccount =
    connection.choices.find((account) => String(account.id) === accountId) ??
    (connection.choices.length === 1 ? connection.choices[0] : undefined);
  const models = modelSettings?.models ?? [];
  const preferredModel = models.find((model) => model.id === modelSettings?.preferred);
  const selectedModel =
    models.find((model) => model.id === modelId) ??
    preferredModel ??
    (models.length === 1 ? models[0] : undefined);
  const repository =
    fixing && vendors ? resolveContributorRepository(vendors, repositoryUrl, allowPublic) : undefined;
  const repositoryReady = !fixing || (repository !== undefined && !("error" in repository));
  const closePublicDialog = () => {
    setConfirmingPublic(false);
    setPublicAcknowledged(false);
  };

  const offersFixes = Boolean(remediation);
  useEffect(() => {
    if (!offersFixes) return;
    let cancelled = false;
    authenticatedApi
      .listGatekeeperVendors()
      .then((next) => {
        if (!cancelled) setVendors(next);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load repository connectors. Reload to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi, offersFixes]);

  useEffect(() => {
    if (!isInvestigation) return;
    let cancelled = false;
    Promise.all([authenticatedApi.listModels(), authenticatedApi.getPreferredModel()])
      .then(([nextModels, preferred]) => {
        if (!cancelled) setModelSettings({ models: nextModels, preferred });
      })
      .catch(() => {
        if (!cancelled) setError("Could not load investigation models. Reload to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi, isInvestigation]);

  useEffect(
    () => (ready ? respondToWorkersIssueSetup(request, ready) : undefined),
    [request, ready],
  );

  const setup = async () => {
    if (
      operation.current ||
      connection.checking ||
      connection.error ||
      (connection.choices.length > 1 && !selectedAccount) ||
      (isInvestigation && !selectedModel) ||
      !repositoryReady
    )
      return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setMessage(
      "Checking Cloudflare access. If authorization opens, finish it to continue automatically.",
    );
    try {
      const account = await connection.authorize(selectedAccount, controller.signal);
      controller.signal.throwIfAborted();
      // The freshly redeemed identity may differ from the one the user used in the dashboard.
      const frame = await authenticatedApi.startResourceConfigurator(
        account.id,
        NOTIFICATIONS_PATTERN,
      );
      using ui = frame.ui as RpcStub<CloudflareAccountConfiguratorRpc>;
      const accessible = await ui.listAccounts(request.accountId);
      if (!accessible.some((value) => value.value === request.accountId))
        throw new Error("This connection cannot access the requested Cloudflare account.");
      controller.signal.throwIfAborted();
      let fix;
      if (repository && !("error" in repository)) {
        setMessage(
          `Checking ${repository.vendorName} access. If authorization opens, finish it to continue automatically.`,
        );
        fix = {
          accountId: await authorizeRepositoryAccount(
            authenticatedApi,
            repository.vendorId,
            repository.urlPattern,
            controller.signal,
          ),
          resourceUrl: repository.resourceUrl,
          allowPublic,
        };
        controller.signal.throwIfAborted();
      }
      setMessage(
        fix
          ? "Connecting the Worker-scoped fixer…"
          : isInvestigation
            ? "Connecting the Worker-scoped investigator…"
            : "Connecting the notification destination…",
      );
      const result = await provisionWorkersIssueInbox(
        authenticatedApi,
        request,
        account.id,
        workspaceId,
        selectedModel?.id,
        (id) => {
          setWorkspaceId(id);
          if (!request.investigation) {
            try {
              sessionStorage.setItem(`workers-issue-setup:${request.state}`, id);
            } catch {
              /* Reload recovery is optional. */
            }
          }
        },
        fix,
        !fromInbox || automatic,
      );
      if (controller.signal.aborted) return;
      // Only the inbox's own concern; the dashboard is told what it asked for.
      const { backgroundChecks, ...outcome } = { backgroundChecks: undefined, ...result };
      setReady({
        ...outcome,
        investigateCurrent: isInvestigation && Boolean(request.issueId) && investigateCurrent,
      });
      const enabled = fix
        ? backgroundChecks === false
          ? "AI fixes are enabled. Background checks could not be turned on, so merged fixes are followed to production while the inbox is open."
          : "AI fixes are enabled."
        : "AI investigations are enabled.";
      const investigated = "investigated" in result ? result.investigated : undefined;
      const notification =
        investigated === undefined
          ? []
          : [
              investigated
                ? `The inbox is ${fix ? "working on a fix for" : "investigating"} the notification.`
                : "The notification was already being investigated.",
            ];
      setMessage(
        fromInbox
          ? [enabled, ...notification, "You can close this tab and return to the inbox."].join(" ")
          : isInvestigation
            ? `${enabled} Returning to your saved automation.`
            : "Cloudflare OS is connected. Return to the dashboard to save your automation.",
      );
    } catch (caught) {
      if (!controller.signal.aborted)
        setError(
          caught instanceof Error
            ? `Setup could not finish. ${caught.message}`
            : "Setup could not finish. Try again; your inbox will be reused.",
        );
    } finally {
      if (operation.current === controller) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  };

  return (
    // The fullscreen app shell does not scroll, so this page scrolls itself in short windows.
    <div className="h-full overflow-y-auto">
      <main className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center gap-6 p-6">
        <div className="grid gap-2">
          <p className="text-sm font-medium text-kumo-subtle">Cloudflare OS</p>
          <h1 className="text-2xl font-semibold text-kumo-default">
            {fixing ? "Enable AI fixes" : isInvestigation ? "Enable AI investigations" : "Connect Cloudflare OS"}
          </h1>
          <p className="text-sm text-kumo-subtle">
            {isInvestigation ? "Analyze logs and traces for" : "Receive issue notifications for"}{" "}
            <strong className="text-kumo-default">{request.workerName}</strong>.
          </p>
        </div>
        <dl className="grid gap-4 rounded-lg border border-kumo-line bg-kumo-base p-4 text-sm">
          <div className="grid gap-1">
            <dt className="text-kumo-subtle">Cloudflare account</dt>
            <dd className="break-all text-kumo-default">
              {selectedAccount?.accountName ?? request.accountId}
            </dd>
          </div>
          {selectedAccount && (
            <div className="grid gap-1">
              <dt className="text-kumo-subtle">Connected as</dt>
              <dd className="text-kumo-default">
                {selectedAccount.description.displayName ?? selectedAccount.description.uniqueName}
              </dd>
            </div>
          )}
        </dl>
        {!ready && (
          <>
            {connection.checking ? (
              <p role="status" className="text-sm text-kumo-subtle">
                Checking existing Cloudflare connections…
              </p>
            ) : connection.error ? (
              <div className="grid gap-2">
                <p role="alert" className="text-sm text-kumo-danger">
                  {connection.error}
                </p>
                <Button onClick={connection.retry}>Try again</Button>
              </div>
            ) : connection.choices.length > 1 ? (
              <Select
                label="Cloudflare connection"
                placeholder="Choose a connection for this account"
                disabled={busy}
                value={accountId}
                onValueChange={(value) => setAccountId(value ?? "")}
                items={connection.choices.map((account) => ({
                  value: String(account.id),
                  label:
                    account.description.displayName ??
                    account.description.uniqueName ??
                    `Connection ${account.id}`,
                }))}
              />
            ) : (
              <p className="text-sm text-kumo-subtle">
                {selectedAccount?.credentialsValid
                  ? "Your existing Cloudflare connection will be reused."
                  : "Cloudflare authorization is needed. Setup will continue automatically when you finish."}
              </p>
            )}
            {isInvestigation ? (
              <div className="grid gap-3">
                <p className="text-sm text-kumo-subtle">
                  {fixing
                    ? "Setup installs a new fixer with the selected model, read-only telemetry for this Worker, and access to propose changes to one repository, replacing any existing investigator binding. Workspace editors can change its bindings later."
                    : "Setup installs a new investigator with the selected model and read-only telemetry for this Worker, replacing any existing investigator binding. Workspace editors can change its bindings later. Repository access, tests, code changes, and deployments require separate capabilities."}
                </p>
                {selectedModel && !changeModel ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-kumo-default">
                    <span>Model: {selectedModel.name}</span>
                    <Button variant="ghost" disabled={busy} onClick={() => setChangeModel(true)}>
                      Change
                    </Button>
                  </div>
                ) : (
                  <Select
                    label="Investigation model"
                    placeholder="Choose a language model"
                    disabled={busy}
                    value={selectedModel?.id ?? ""}
                    onValueChange={(value) => setModelId(value ?? "")}
                    items={models.map((model) => ({ value: model.id, label: model.name }))}
                  />
                )}
                {modelSettings && models.length === 0 && (
                  <p className="text-sm text-kumo-subtle">
                    Configure a language model in OS Settings, then reload this setup. Your
                    notification destination is already connected.
                  </p>
                )}
                {remediation && (
                  <section className="grid gap-3 rounded-lg border border-kumo-line p-4">
                    <Switch
                      label="Propose fixes as pull or merge requests"
                      checked={fixesWanted}
                      disabled={busy}
                      onClick={() => setFixesWanted((value) => !value)}
                    />
                    {fixesWanted && (
                      <>
                        <p className="text-sm text-kumo-subtle">
                          The fixer commits a fix and a regression test to a new branch starting with{" "}
                          <code>{FIX_BRANCH_PREFIX}</code> and opens a pull or merge request into the
                          default branch, without asking you again: enabling fixes approves them. It
                          cannot merge, push to other branches, or deploy: the pull or merge request
                          is your review, you merge, and your CI deploys. Fixes are written from production
                          telemetry and notification text, which can contain personal data or
                          attacker-controlled content; the fixer is instructed to leave such data out,
                          but review every change before merging.
                        </p>
                        <p className="text-sm text-kumo-subtle">
                          Once you merge, the inbox follows the fix to production through this
                          Worker&apos;s deployments and builds. When every live version contains it and
                          an hour of traffic passes without the issue, the inbox marks the issue
                          resolved in Workers Observability without asking. It checks every 15
                          minutes with Scheduled Tasks, which setup turns on.
                        </p>
                        <Input
                          label="Repository"
                          placeholder="https://github.com/owner/repo"
                          value={repositoryUrl}
                          disabled={busy}
                          onChange={(event) => setRepositoryUrl(event.target.value)}
                          description={
                            repository && !("error" in repository)
                              ? `${repository.vendorName} · ${repository.path}`
                              : "The repository this Worker is built from."
                          }
                          error={
                            repositoryUrl && repository && "error" in repository
                              ? repository.error
                              : undefined
                          }
                        />
                        <Switch
                          label="Allow public repositories"
                          checked={allowPublic}
                          disabled={busy}
                          onClick={() => (allowPublic ? setAllowPublic(false) : setConfirmingPublic(true))}
                        />
                        {allowPublic && (
                          <Banner
                            variant="alert"
                            description="With a public repository, each proposed change, and anything it contains, becomes public as soon as it is pushed, before you review it."
                          />
                        )}
                      </>
                    )}
                  </section>
                )}
                {fromInbox && (
                  <section className="grid gap-3 rounded-lg border border-kumo-line p-4">
                    <Switch
                      label="Investigate new notifications automatically"
                      checked={automatic}
                      disabled={busy}
                      onClick={() => setAutomatic((value) => !value)}
                    />
                    <p className="text-sm text-kumo-subtle">
                      {automatic
                        ? "Every new issue notification runs the model, which incurs usage costs."
                        : "New notifications are only stored. Investigate any of them from the inbox."}
                    </p>
                  </section>
                )}
                {request.issueId && (
                  <Checkbox
                    label="Also investigate the issue I came from"
                    checked={investigateCurrent}
                    disabled={busy}
                    onCheckedChange={setInvestigateCurrent}
                  />
                )}
              </div>
            ) : (
              <p className="text-sm text-kumo-subtle">
                AI investigations are optional. You can enable them after saving your automation. Each
                Cloudflare connection supports up to 100 notification subscriptions per account.
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2 border-t border-kumo-line pt-4">
              <Button
                disabled={busy && !message.startsWith("Checking")}
                onClick={() => {
                  operation.current?.abort();
                  window.close();
                }}
              >
                {isInvestigation ? "Not now" : "Cancel"}
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={
                  busy ||
                  connection.checking ||
                  Boolean(connection.error) ||
                  (connection.choices.length > 1 && !selectedAccount) ||
                  (isInvestigation && !selectedModel) ||
                  !repositoryReady
                }
                onClick={() => void setup()}
              >
                {fixing ? "Enable fixes" : isInvestigation ? "Enable investigations" : "Connect destination"}
              </Button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-kumo-danger">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-kumo-subtle">
            {message}
          </p>
        )}
        {ready && (
          <LinkButton variant="secondary" href={`/workspace/${ready.workspaceId}`} external>
            Open issue inbox
          </LinkButton>
        )}
        <Dialog.Root open={confirmingPublic} onOpenChange={(open) => !open && closePublicDialog()}>
          <Dialog className="grid gap-4 p-6">
            <Dialog.Title className="text-lg font-semibold">Allow public repositories?</Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              Anyone can read what is pushed to a public repository: the fix, its test, the commit
              message, and the description. They are written from production telemetry, which can
              contain personal or secret data. The fixer is instructed to leave such data out, but it
              can make mistakes.
            </Dialog.Description>
            <Checkbox
              label="I understand that proposed changes to a public repository are visible to anyone"
              checked={publicAcknowledged}
              onCheckedChange={setPublicAcknowledged}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={closePublicDialog}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!publicAcknowledged}
                onClick={() => {
                  setAllowPublic(true);
                  closePublicDialog();
                }}
              >
                Allow
              </Button>
            </div>
          </Dialog>
        </Dialog.Root>
      </main>
    </div>
  );
};
