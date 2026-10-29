import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, LinkButton, Select } from "@cloudflare/kumo";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import type { CloudflareAccountConfiguratorRpc } from "../../../../gatekeeper-cloudflare/src/configurator/cloudflare-configurator-types";
import { useAuthenticatedApi } from "../../AuthContext";
import { provisionWorkersIssueInbox } from "./provisionWorkersIssueInbox";
import {
  NOTIFICATIONS_PATTERN,
  WORKER_PATTERN,
  useWorkersIssueConnections,
} from "./useWorkersIssueConnections";
import { respondToWorkersIssueSetup, type WorkersIssueSetupRequest } from "./workersIssueSetup";

const DESTINATION_PATTERNS = [NOTIFICATIONS_PATTERN];
const INVESTIGATION_PATTERNS = [WORKER_PATTERN];

export const WorkersIssueSetupPage = ({ request }: { request: WorkersIssueSetupRequest }) => {
  const { authenticatedApi } = useAuthenticatedApi();
  const isInvestigation = Boolean(request.investigation);
  const connection = useWorkersIssueConnections(
    authenticatedApi,
    request.accountId,
    isInvestigation ? INVESTIGATION_PATTERNS : DESTINATION_PATTERNS,
  );
  const [accountId, setAccountId] = useState("");
  const [modelSettings, setModelSettings] = useState<{
    models: AiChatAuthorInfo[];
    preferred: string | null;
  }>();
  const [modelId, setModelId] = useState("");
  const [changeModel, setChangeModel] = useState(false);
  const [investigateCurrent, setInvestigateCurrent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState<{
    destinationId: string;
    workspaceId: string;
    investigationsEnabled: boolean;
    investigateCurrent: boolean;
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
      (isInvestigation && !selectedModel)
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
      setMessage(
        isInvestigation
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
      );
      if (controller.signal.aborted) return;
      setReady({
        ...result,
        investigateCurrent: isInvestigation && Boolean(request.issueId) && investigateCurrent,
      });
      setMessage(
        isInvestigation
          ? "AI investigations are enabled. Returning to your saved automation."
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
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-6 p-6">
      <div className="grid gap-2">
        <p className="text-sm font-medium text-kumo-subtle">Cloudflare OS</p>
        <h1 className="text-2xl font-semibold text-kumo-default">
          {isInvestigation ? "Enable AI investigations" : "Connect Cloudflare OS"}
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
                Setup installs a new investigator with the selected model and read-only telemetry
                for this Worker, replacing any existing investigator binding. Workspace editors can
                change its bindings later. Repository access, tests, code changes, and deployments
                require separate capabilities.
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
                (isInvestigation && !selectedModel)
              }
              onClick={() => void setup()}
            >
              {isInvestigation ? "Enable investigations" : "Connect destination"}
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
    </main>
  );
};
