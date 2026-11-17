import { useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  Input,
  LinkButton,
  Select,
  Switch,
} from "@cloudflare/kumo";
import type { AiChatAuthorInfo, GatekeeperVendorInfo } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import type { CloudflareAccountConfiguratorRpc } from "../../../../gatekeeper-cloudflare/src/configurator/cloudflare-configurator-types";
import { useAuthenticatedApi } from "../../AuthContext";
import { authorizeRepositoryAccount } from "./authorizeRepositoryAccount";
import { resolveContributorRepository } from "./contributorRepository";
import { loadWorkersIssueConfiguration } from "./loadWorkersIssueConfiguration";
import {
  provisionWorkersIssueInbox,
  type WorkersIssueTelemetryScope,
} from "./provisionWorkersIssueInbox";
import {
  NOTIFICATIONS_PATTERN,
  ACCOUNT_OBSERVABILITY_PATTERN,
  RELEASES_PATTERN,
  WORKER_PATTERN,
  useWorkersIssueConnections,
} from "./useWorkersIssueConnections";
import { respondToWorkersIssueSetup, type WorkersIssueSetupRequest } from "./workersIssueSetup";
import { WorkersIssueFixPermissions } from "./WorkersIssueFixPermissions";

const DESTINATION_PATTERNS = [NOTIFICATIONS_PATTERN];
const INVESTIGATION_PATTERNS = {
  worker: [WORKER_PATTERN],
  account: [ACCOUNT_OBSERVABILITY_PATTERN],
};
const FIX_PATTERNS = {
  worker: [WORKER_PATTERN, RELEASES_PATTERN],
  account: [ACCOUNT_OBSERVABILITY_PATTERN, RELEASES_PATTERN],
};
const TIME_LIMITS = [5, 15, 30, 60].map((minutes) => ({
  value: String(minutes * 60_000),
  label: `${minutes} minutes`,
}));

export const WorkersIssueSetupPage = ({ request }: { request: WorkersIssueSetupRequest }) => {
  const { authenticatedApi } = useAuthenticatedApi();
  const [investigationsWanted, setInvestigationsWanted] = useState(Boolean(request.investigation));
  const isInvestigation = investigationsWanted;
  // Opened from the inbox rather than handed off by the dashboard: nothing is reported back.
  const fromInbox = !request.dashboardOrigin;
  const remediation = request.remediation ?? { allowPublic: false };
  const [fixesWanted, setFixesWanted] = useState(Boolean(request.remediation));
  const fixing = isInvestigation && fixesWanted;
  const [accountId, setAccountId] = useState("");
  const [modelSettings, setModelSettings] = useState<{
    models: AiChatAuthorInfo[];
    preferred: string | null;
    configuration: Awaited<ReturnType<typeof loadWorkersIssueConfiguration>>;
  }>();
  const [modelId, setModelId] = useState("");
  const [telemetryScopeChoice, setTelemetryScope] = useState<WorkersIssueTelemetryScope>();
  const telemetryScope =
    telemetryScopeChoice ?? modelSettings?.configuration?.telemetryScope ?? "worker";
  const aiPatterns = fixing
    ? FIX_PATTERNS[telemetryScope]
    : isInvestigation
      ? INVESTIGATION_PATTERNS[telemetryScope]
      : [];
  const connection = useWorkersIssueConnections(
    authenticatedApi,
    request.accountId,
    request.investigation ? aiPatterns : [...DESTINATION_PATTERNS, ...aiPatterns],
  );
  const [changeModel, setChangeModel] = useState(false);
  const [timeLimitChoice, setTimeLimitChoice] = useState<string>();
  const configuredDuration = modelSettings?.configuration?.maxDurationMs;
  const timeLimit =
    timeLimitChoice ??
    String(configuredDuration === undefined ? 900_000 : (configuredDuration ?? 0));
  const timeLimits = [
    ...TIME_LIMITS,
    ...(!TIME_LIMITS.some(({ value }) => value === timeLimit) && timeLimit !== "0"
      ? [{ value: timeLimit, label: `${Number(timeLimit) / 60_000} minutes` }]
      : []),
    { value: "0", label: "No time limit" },
  ];
  const [investigateCurrent, setInvestigateCurrent] = useState(false);
  // A user who came to investigate one notification has not asked for every later one.
  const [automaticChoice, setAutomatic] = useState<boolean>();
  const automatic =
    automaticChoice ??
    (request.runKey ? false : (modelSettings?.configuration?.investigationsEnabled ?? true));
  const [repositoryUrl, setRepositoryUrl] = useState(
    remediation.repositoryUrl ?? request.repositoryUrl ?? "",
  );
  const [allowPublic, setAllowPublic] = useState(remediation?.allowPublic ?? false);
  const [autoResolveChoice, setAutoResolveChoice] = useState<boolean>();
  const autoResolve = autoResolveChoice ?? modelSettings?.configuration?.autoResolve ?? true;
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
    fixesEnabled?: boolean;
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
  const selectedModelId =
    modelId ||
    modelSettings?.configuration?.modelId ||
    preferredModel?.id ||
    (models.length === 1 ? models[0]?.id : undefined);
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const repository =
    fixing && vendors
      ? resolveContributorRepository(vendors, repositoryUrl, allowPublic)
      : undefined;
  const repositoryReady = !fixing || (repository !== undefined && !("error" in repository));
  const closePublicDialog = () => {
    setConfirmingPublic(false);
    setPublicAcknowledged(false);
  };

  const offersFixes = isInvestigation;
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
    Promise.all([
      authenticatedApi.listModels(),
      authenticatedApi.getPreferredModel(),
      loadWorkersIssueConfiguration(authenticatedApi, request),
    ])
      .then(([nextModels, preferred, configuration]) => {
        if (!cancelled) setModelSettings({ models: nextModels, preferred, configuration });
      })
      .catch((caught: unknown) => {
        if (!cancelled)
          setError(
            `Could not load AI setup. ${caught instanceof Error ? caught.message : "Reload to try again."}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi, isInvestigation, request]);

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
          autoResolve,
        };
        controller.signal.throwIfAborted();
      }
      setMessage(
        fix
          ? "Connecting the fixer…"
          : isInvestigation
            ? "Connecting the investigator…"
            : "Connecting the notification destination…",
      );
      const result = await provisionWorkersIssueInbox(
        authenticatedApi,
        request,
        account.id,
        workspaceId,
        isInvestigation ? selectedModel?.id : undefined,
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
        automatic,
        timeLimit === "0" ? undefined : Number(timeLimit),
        telemetryScope,
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
            ? request.investigation
              ? `${enabled} Returning to your saved automation.`
              : `${enabled} Return to the dashboard to save your automation.`
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
            {fixing
              ? "Enable AI fixes"
              : isInvestigation
                ? "Enable AI investigations"
                : "Connect Cloudflare OS"}
          </h1>
        </div>
        <div className="grid gap-5 rounded-lg border border-kumo-line bg-kumo-base p-4 sm:p-6">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
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
                  {selectedAccount.description.displayName ??
                    selectedAccount.description.uniqueName}
                </dd>
              </div>
            )}
            <div className="sm:col-span-2">
              <dt className="sr-only">Worker</dt>
              <dd className="text-kumo-subtle">
                {isInvestigation
                  ? "Analyze logs and traces for"
                  : "Receive issue notifications for"}{" "}
                <strong className="text-kumo-default">{request.workerName}</strong> worker
              </dd>
            </div>
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
              ) : !selectedAccount?.credentialsValid ? (
                <p className="text-sm text-kumo-subtle">
                  Cloudflare authorization is needed. Setup will continue automatically when you
                  finish.
                </p>
              ) : null}
              {!request.investigation && (
                <section className="grid gap-3 border-t border-kumo-line pt-5">
                  <Switch
                    label="Enable AI investigations"
                    checked={investigationsWanted}
                    disabled={busy}
                    onClick={() => setInvestigationsWanted((value) => !value)}
                  />
                  <p className="text-sm text-kumo-subtle">
                    AI investigations are optional. Configure them now or enable them later from
                    your issue inbox. Each Cloudflare connection supports up to 1,000 notification
                    subscriptions per account.
                  </p>
                </section>
              )}
              {isInvestigation ? (
                <div className="grid gap-4 border-t border-kumo-line pt-5">
                  <p className="text-sm text-kumo-subtle">
                    {fixing
                      ? "Setup installs a new fixer with the selected model, read-only telemetry for the selected scope, and access to propose changes to one repository, replacing any existing investigator binding. Workspace editors can change its bindings later."
                      : "Setup installs a new investigator with the selected model and read-only telemetry for the selected scope, replacing any existing investigator binding. Workspace editors can change its bindings later. Repository access, tests, code changes, and deployments require separate capabilities."}
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
                      renderValue={(value) =>
                        models.find((model) => model.id === value)?.name ?? value
                      }
                    />
                  )}
                  {modelSettings && models.length === 0 && (
                    <p className="text-sm text-kumo-subtle">
                      Configure a language model in OS Settings, then reload this setup.
                      {request.investigation &&
                        " Your notification destination is already connected."}
                    </p>
                  )}
                  <Select
                    label="Time limit per investigation"
                    value={timeLimit}
                    disabled={busy || !modelSettings}
                    onValueChange={(value) => setTimeLimitChoice(value ?? "900000")}
                    items={timeLimits}
                    renderValue={(value) => timeLimits.find((item) => item.value === value)?.label}
                    description="Stops the investigator when the limit is reached. Retries and approval waits count toward the same limit. Already-submitted external actions may finish."
                  />
                  <Select<WorkersIssueTelemetryScope>
                    label="Telemetry access"
                    value={telemetryScope}
                    disabled={busy || !modelSettings}
                    onValueChange={(value) => setTelemetryScope(value ?? "worker")}
                    items={[
                      { value: "worker", label: `${request.workerName} only` },
                      { value: "account", label: "All Workers in this account" },
                    ]}
                    description={
                      telemetryScope === "account"
                        ? "Read-only logs, metrics, and traces across this Cloudflare account, including downstream Workers."
                        : "Read-only logs, metrics, and traces for this Worker."
                    }
                  />
                  <section className="grid gap-3 border-t border-kumo-line pt-5">
                    <Switch
                      label="Investigate new notifications automatically"
                      checked={automatic}
                      disabled={busy}
                      onClick={() => setAutomatic(!automatic)}
                    />
                    <p className="text-sm text-kumo-subtle">
                      {automatic
                        ? "Every new issue notification runs the model, which incurs usage costs."
                        : "New notifications are only stored. Investigate any of them from the inbox."}
                    </p>
                  </section>
                  <section className="grid gap-3 border-t border-kumo-line pt-5">
                    <Switch
                      label="Propose fixes as pull or merge requests"
                      checked={fixesWanted}
                      disabled={busy}
                      onClick={() => setFixesWanted((value) => !value)}
                    />
                    {fixesWanted && (
                      <>
                        <WorkersIssueFixPermissions />
                        <Input
                          label="Repository"
                          placeholder="https://github.com/owner/repo"
                          value={repositoryUrl}
                          disabled={busy}
                          onChange={(event) => setRepositoryUrl(event.target.value)}
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
                          onClick={() =>
                            allowPublic ? setAllowPublic(false) : setConfirmingPublic(true)
                          }
                        />
                        <Switch
                          label="Mark issue as resolved after the fix is deployed automatically"
                          checked={autoResolve}
                          disabled={busy || !modelSettings}
                          onClick={() => setAutoResolveChoice(!autoResolve)}
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
                  {request.investigation && request.issueId && (
                    <Checkbox
                      label="Also investigate the issue I came from"
                      checked={investigateCurrent}
                      disabled={busy}
                      onCheckedChange={setInvestigateCurrent}
                    />
                  )}
                </div>
              ) : null}
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
                  {fixing
                    ? "Enable fixes"
                    : isInvestigation
                      ? "Enable investigations"
                      : "Connect destination"}
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
        </div>
        <Dialog.Root open={confirmingPublic} onOpenChange={(open) => !open && closePublicDialog()}>
          <Dialog className="grid gap-4 p-6">
            <Dialog.Title className="text-lg font-semibold">
              Allow public repositories?
            </Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              Anyone can read what is pushed to a public repository: the fix, its test, the commit
              message, and the description. They are written from production telemetry, which can
              contain personal or secret data. The fixer is instructed to leave such data out, but
              it can make mistakes.
            </Dialog.Description>
            <Checkbox
              label="I understand that proposed changes to a public repository are visible to anyone"
              className="mt-1"
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
