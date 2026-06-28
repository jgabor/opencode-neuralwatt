/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { createMemo, createSignal, type JSX } from "solid-js";
import type { TuiPlugin, TuiPluginModule, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import { promises as fs } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UsageBucket = {
  cost_usd: number;
  requests: number;
  tokens: number;
  energy_kwh: number;
};

type Subscription = {
  plan: string;
  status: string;
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  auto_renew: boolean | null;
  kwh_included: number | null;
  kwh_used: number | null;
  kwh_remaining: number | null;
  in_overage: boolean | null;
};

type QuotaData = {
  snapshot_at: string;
  balance: {
    credits_remaining_usd: number;
    total_credits_usd: number;
    credits_used_usd: number;
    accounting_method: "energy" | "token";
  };
  usage: {
    lifetime: UsageBucket;
    current_month: UsageBucket;
  };
  limits: {
    overage_limit_usd: number | null;
    rate_limit_tier: string;
  };
  subscription: Subscription | null;
  key: {
    name: string | null;
    allowance: {
      limit_usd: number;
      period: string;
      spent_usd: number;
      remaining_usd: number;
      blocked: boolean;
    } | null;
  };
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "https://api.neuralwatt.com/v1";
const NPM_REGISTRY = "https://registry.npmjs.org/@jgabor%2Fopencode-neuralwatt/latest";
const REFRESH_INTERVAL_MS = 15_000;
const RATE_LIMIT_BUFFER_MS = 1_100;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_500;

// ---------------------------------------------------------------------------
// Update notifier
// ---------------------------------------------------------------------------

type UpdateStatus = "idle" | "checking" | "available" | "installing" | "installed" | "error";

async function checkForUpdate(
  meta: TuiPluginMeta,
  setLatestVersion: (v: string | null) => void,
  setUpdateStatus: (s: UpdateStatus) => void,
): Promise<void> {
  if (meta.source === "file") return;
  const installed = meta.version;
  if (!installed) return;
  setUpdateStatus("checking");
  try {
    const res = await fetch(NPM_REGISTRY, { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    if (!data.version) return;
    setLatestVersion(data.version);
    if (data.version !== installed) setUpdateStatus("available");
    else setUpdateStatus("idle");
  } catch {
    setUpdateStatus("idle");
  }
}

function specIsUnpinned(spec: string): boolean {
  if (!spec.includes("@")) return true;
  if (spec.endsWith("@latest")) return true;
  return false;
}

async function bumpPinnedSpecInConfig(
  api: TuiApi,
  oldSpec: string,
  latest: string,
): Promise<void> {
  if (specIsUnpinned(oldSpec)) return;
  const newSpec = `@jgabor/opencode-neuralwatt@${latest}`;
  const candidates = [
    path.join(api.state.path.config, "opencode.json"),
    path.join(api.state.path.config, "opencode.jsonc"),
    path.join(api.state.path.directory, ".opencode", "opencode.json"),
    path.join(api.state.path.directory, ".opencode", "opencode.jsonc"),
    path.join(api.state.path.directory, ".opencode", "tui.json"),
  ];
  const escaped = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "g");
  await Promise.all(
    candidates.map(async (file) => {
      try {
        const content = await fs.readFile(file, "utf8");
        if (!content.includes(oldSpec)) return;
        await fs.writeFile(file, content.replace(re, newSpec), "utf8");
      } catch {
        // file missing or unreadable; skip
      }
    }),
  );
}

async function installLatestVersion(
  api: TuiApi,
  meta: TuiPluginMeta,
  latest: string,
  setUpdateStatus: (s: UpdateStatus) => void,
  setUpdateError: (e: string | null) => void,
): Promise<void> {
  setUpdateStatus("installing");
  setUpdateError(null);
  try {
    if (specIsUnpinned(meta.spec)) {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      if (home) {
        const cacheDir = path.join(home, ".cache/opencode/packages/@jgabor/opencode-neuralwatt@latest");
        await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    const spec = `@jgabor/opencode-neuralwatt@${latest}`;
    const result = await api.plugins.install(spec, { global: true });
    if (!result.ok) throw new Error(result.message);
    await bumpPinnedSpecInConfig(api, meta.spec, latest);
    setUpdateStatus("installed");
    api.ui.toast({
      variant: "success",
      title: "Neuralwatt",
      message: `Updated to ${latest}. Restart OpenCode to apply.`,
      duration: 8000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setUpdateStatus("error");
    setUpdateError(msg);
    api.ui.toast({ variant: "error", title: "Update failed", message: msg });
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api, _options, meta) => {
  type QuotaSlotAPI = Parameters<NonNullable<TuiPluginModule["tui"]>>[0];

  const apiKey = process.env.NEURALWATT_API_KEY;

  const [quota, setQuota] = createSignal<QuotaData | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [updatedAt, setUpdatedAt] = createSignal<Date | null>(null);
  const [latestVersion, setLatestVersion] = createSignal<string | null>(null);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>("idle");
  const [updateError, setUpdateError] = createSignal<string | null>(null);

  const runInstall = () =>
    installLatestVersion(
      api as TuiApi,
      meta,
      latestVersion() ?? "",
      setUpdateStatus,
      setUpdateError,
    );

  void checkForUpdate(meta, setLatestVersion, setUpdateStatus);

  let lastFetchAt = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const fetchQuotaOnce = async (): Promise<Response> => {
    const now = Date.now();
    if (now - lastFetchAt < RATE_LIMIT_BUFFER_MS) {
      await sleep(RATE_LIMIT_BUFFER_MS - (now - lastFetchAt));
    }
    lastFetchAt = Date.now();
    return fetch(`${API_BASE}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  };

  const fetchQuota = async () => {
    if (!apiKey) {
      setError("NEURALWATT_API_KEY is not set");
      return;
    }

    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetchQuotaOnce();

        if (response.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
          );
        }

        const data = (await response.json()) as QuotaData;
        setQuota(data);
        setUpdatedAt(new Date());
        setError(null);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
      }
    }

    if (lastErr) {
      setError(lastErr.message);
    }
  };

  // Initial fetch + periodic refresh.
  await fetchQuota();
  const interval = setInterval(fetchQuota, REFRESH_INTERVAL_MS);
  api.lifecycle?.onDispose?.(() => clearInterval(interval));

  // Register palette command and slash command.
  const commands = [
    {
      title: "Neuralwatt Quota",
      name: "neuralwatt.quota",
      description: "Show Neuralwatt account quota and usage",
      category: "Neuralwatt",
      slashName: "nw",
      slashAliases: ["neuralwatt"],
      run: () =>
        openPanel(
          api as QuotaSlotAPI,
          quota,
          error,
          updatedAt,
          fetchQuota,
          meta,
          latestVersion,
          updateStatus,
          updateError,
          runInstall,
        ),
    },
  ];

  if (api.command?.register) {
    api.command.register(() =>
      commands.map((cmd) => ({
        title: cmd.title,
        value: cmd.name,
        description: cmd.description,
        category: cmd.category,
        slash: { name: cmd.slashName, aliases: cmd.slashAliases },
        onSelect: cmd.run,
      })),
    );
  }

  // Sidebar widget.
  if (api.slots?.register) {
    api.slots.register({
      order: 100,
      slots: {
        sidebar_content() {
          return (
            <SidebarView
              api={api as QuotaSlotAPI}
              quota={quota}
              error={error}
              updatedAt={updatedAt}
              latestVersion={latestVersion}
              updateStatus={updateStatus}
              updateError={updateError}
              onInstall={runInstall}
              onOpen={() =>
                openPanel(
                  api as QuotaSlotAPI,
                  quota,
                  error,
                  updatedAt,
                  fetchQuota,
                  meta,
                  latestVersion,
                  updateStatus,
                  updateError,
                  runInstall,
                )
              }
            />
          );
        },
      },
    });
  }
};

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openPanel(
  api: TuiApi,
  quota: () => QuotaData | null,
  error: () => string | null,
  updatedAt: () => Date | null,
  refresh: () => Promise<void>,
  meta: TuiPluginMeta,
  latestVersion: () => string | null,
  updateStatus: () => UpdateStatus,
  updateError: () => string | null,
  onInstall: () => Promise<void>,
) {
  api.ui.dialog.setSize("xlarge");
  api.ui.dialog.replace(() => (
    <QuotaPanel
      api={api}
      quota={quota}
      error={error}
      updatedAt={updatedAt}
      onRefresh={refresh}
      onClose={() => api.ui.dialog.clear()}
      meta={meta}
      latestVersion={latestVersion}
      updateStatus={updateStatus}
      updateError={updateError}
      onInstall={onInstall}
    />
  ));
}

function QuotaPanel(props: {
  api: TuiApi;
  quota: () => QuotaData | null;
  error: () => string | null;
  updatedAt: () => Date | null;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  meta: TuiPluginMeta;
  latestVersion: () => string | null;
  updateStatus: () => UpdateStatus;
  updateError: () => string | null;
  onInstall: () => Promise<void>;
}) {
  const theme = props.api.theme.current;

  const q = createMemo(() => props.quota());
  const err = createMemo(() => props.error());
  const updated = createMemo(() => props.updatedAt());

  const burnRate = createMemo(() => (q() ? burnRateCurrentMonth(q()!) : 0));
  const sub = createMemo(() => q()?.subscription ?? null);
  const allowance = createMemo(() => q()?.key.allowance ?? null);
  const accountingColor = createMemo<ThemeColor>(() =>
    q()?.balance.accounting_method === "energy" ? "success" : "info",
  );

  return (
    <box
      flexDirection="column"
      width="100%"
      paddingTop={1}
      paddingLeft={3}
      paddingRight={3}
      paddingBottom={1}
      gap={1}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="flex-end"
        flexShrink={0}
      >
        <box flexDirection="column">
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Neuralwatt
          </text>
          <text fg={theme.textMuted}>
            {props.meta.version ? `v${props.meta.version}` : "Quota"}
          </text>
        </box>
        <text fg={theme.textMuted} onMouseUp={props.onClose}>
          esc
        </text>
      </box>

      <box
        height={1}
        flexShrink={0}
        border={["bottom"]}
        borderColor={theme.borderSubtle}
      />

      <scrollbox flexShrink={1} maxHeight={20} scrollY>
        <box flexDirection="column" flexShrink={1} gap={1}>
          {err() ? (
            <Card theme={theme} title="Error">
              <text fg={theme.error}>{err()}</text>
              {!process.env.NEURALWATT_API_KEY ? (
                <text fg={theme.textMuted}>
                  Set NEURALWATT_API_KEY in your environment and restart
                  OpenCode.
                </text>
              ) : null}
            </Card>
          ) : null}

          {q() ? (
            <>
              <UpdateNotice
                theme={theme}
                latestVersion={props.latestVersion}
                updateStatus={props.updateStatus}
                updateError={props.updateError}
                onInstall={props.onInstall}
              />
              <Card theme={theme} title="Balance">
                <Metric
                  theme={theme}
                  label="Remaining"
                  value={formatCurrency(q()!.balance.credits_remaining_usd)}
                />
                <Metric
                  theme={theme}
                  label="Used"
                  value={formatCurrency(q()!.balance.credits_used_usd)}
                />
                <Metric
                  theme={theme}
                  label="Total"
                  value={formatCurrency(q()!.balance.total_credits_usd)}
                />
                <Metric
                  theme={theme}
                  label="Accounting"
                  value={q()!.balance.accounting_method}
                  valueColor={accountingColor()}
                />
                <CombinedBar
                  theme={theme}
                  percent={
                    q()!.balance.total_credits_usd > 0
                      ? (q()!.balance.credits_used_usd /
                          q()!.balance.total_credits_usd) *
                        100
                      : 0
                  }
                  color={
                    q()!.balance.credits_remaining_usd <= 0
                      ? "error"
                      : "primary"
                  }
                />
              </Card>

              {sub() ? (
                <Card theme={theme} title="Subscription">
                  <Metric
                    theme={theme}
                    label="Plan"
                    value={sub()!.plan}
                  />
                  <Metric
                    theme={theme}
                    label="Status"
                    value={formatStatus(sub()!.status)}
                  />
                  <Metric
                    theme={theme}
                    label="Start"
                    value={formatDate(sub()!.current_period_start)}
                  />
                  <Metric
                    theme={theme}
                    label="End"
                    value={formatDate(sub()!.current_period_end)}
                  />
                  <Metric
                    theme={theme}
                    label="Auto renew"
                    value={sub()!.auto_renew ? "yes" : "no"}
                  />
                  <Metric
                    theme={theme}
                    label="kWh used"
                    value={`${formatNumber(sub()!.kwh_used, 2)} kWh`}
                  />
                  <Metric
                    theme={theme}
                    label="kWh remaining"
                    value={`${formatNumber(sub()!.kwh_remaining, 2)} kWh`}
                  />
                  <CombinedBar
                    theme={theme}
                    percent={
                      (sub()!.kwh_included ?? 0) > 0
                        ? ((sub()!.kwh_used ?? 0) /
                            (sub()!.kwh_included ?? 0)) *
                          100
                        : 0
                    }
                    color={sub()!.in_overage ? "error" : "primary"}
                  />
                  {sub()!.in_overage ? (
                    <text fg={theme.error}>In overage</text>
                  ) : null}
                </Card>
              ) : null}

              <Card theme={theme} title="Usage (current month)">
                <Metric
                  theme={theme}
                  label="Cost"
                  value={formatCurrency(q()!.usage.current_month.cost_usd)}
                />
                <Metric
                  theme={theme}
                  label="Requests"
                  value={formatInteger(q()!.usage.current_month.requests)}
                />
                <Metric
                  theme={theme}
                  label="Tokens"
                  value={formatInteger(q()!.usage.current_month.tokens)}
                />
                <Metric
                  theme={theme}
                  label="Energy"
                  value={`${formatNumber(q()!.usage.current_month.energy_kwh, 3)} kWh`}
                />
              </Card>

              <Card theme={theme} title="Usage (lifetime)">
                <Metric
                  theme={theme}
                  label="Cost"
                  value={formatCurrency(q()!.usage.lifetime.cost_usd)}
                />
                <Metric
                  theme={theme}
                  label="Requests"
                  value={formatInteger(q()!.usage.lifetime.requests)}
                />
                <Metric
                  theme={theme}
                  label="Tokens"
                  value={formatInteger(q()!.usage.lifetime.tokens)}
                />
                <Metric
                  theme={theme}
                  label="Energy"
                  value={`${formatNumber(q()!.usage.lifetime.energy_kwh, 3)} kWh`}
                />
              </Card>

              <Card theme={theme} title="Burn rate">
                <Metric
                  theme={theme}
                  label="Current month"
                  value={`${formatCurrency(burnRate())}/day`}
                />
                <Metric
                  theme={theme}
                  label="Credits left"
                  value={estimateDuration(
                    q()!.balance.credits_remaining_usd,
                    burnRate(),
                  )}
                />
              </Card>

              {allowance() ? (
                <Card theme={theme} title="Key Allowance">
                  <Metric
                    theme={theme}
                    label="Key"
                    value={q()!.key.name ?? "—"}
                  />
                  <Metric
                    theme={theme}
                    label="Limit"
                    value={formatCurrency(allowance()!.limit_usd)}
                  />
                  <Metric
                    theme={theme}
                    label="Period"
                    value={allowance()!.period}
                  />
                  <Metric
                    theme={theme}
                    label="Spent"
                    value={formatCurrency(allowance()!.spent_usd)}
                  />
                  <Metric
                    theme={theme}
                    label="Remaining"
                    value={formatCurrency(allowance()!.remaining_usd)}
                  />
                  <Metric
                    theme={theme}
                    label="Blocked"
                    value={allowance()!.blocked ? "yes" : "no"}
                  />
                </Card>
              ) : null}
            </>
          ) : !err() ? (
            <Card theme={theme} title="Loading">
              <text fg={theme.textMuted}>Fetching quota from Neuralwatt…</text>
            </Card>
          ) : null}
        </box>
      </scrollbox>

      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingTop={1}
        flexShrink={0}
      >
        <text fg={theme.textMuted}>
          {updated() ? `Updated ${formatDate(updated()!)}` : ""}
        </text>
        <box flexDirection="row" gap={1}>
          {props.updateStatus() === "available" && props.latestVersion() ? (
            <FooterButton
              theme={theme}
              label={`update ${props.latestVersion()}`}
              accent
              onClick={props.onInstall}
            />
          ) : null}
          <FooterButton
            theme={theme}
            label="refresh"
            onClick={props.onRefresh}
          />
          <FooterButton
            theme={theme}
            label="close"
            primary
            onClick={props.onClose}
          />
        </box>
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Sidebar widget (DCP-style)
// ---------------------------------------------------------------------------

function UpdateNotice(props: {
  theme: Theme;
  latestVersion: () => string | null;
  updateStatus: () => UpdateStatus;
  updateError: () => string | null;
  onInstall: () => Promise<void>;
  compact?: boolean;
}) {
  const theme = props.theme;
  const status = props.updateStatus();
  const latest = props.latestVersion();
  const compact = props.compact ?? false;

  if (status === "available" && latest) {
    return (
      <box
        flexDirection={compact ? "column" : "row"}
        justifyContent={compact ? "flex-start" : "space-between"}
        alignItems="flex-end"
        onMouseUp={() => void props.onInstall()}
      >
        <box flexDirection="row" gap={1}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {`⤓ Update: ${latest}`}
          </text>
        </box>
        <text fg={theme.textMuted}>click to update</text>
      </box>
    );
  }
  if (status === "installing") {
    return (
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        Installing update…
      </text>
    );
  }
  if (status === "installed") {
    return (
      <text fg={theme.success} attributes={TextAttributes.BOLD}>
        {`Updated to ${latest}. Restart to apply.`}
      </text>
    );
  }
  if (status === "error") {
    return (
      <text fg={theme.error}>
        {`Update failed: ${props.updateError() ?? "unknown error"}`}
      </text>
    );
  }
  return null;
}

function SidebarView(props: {
  api: TuiApi;
  quota: () => QuotaData | null;
  error: () => string | null;
  updatedAt: () => Date | null;
  latestVersion: () => string | null;
  updateStatus: () => UpdateStatus;
  updateError: () => string | null;
  onInstall: () => Promise<void>;
  onOpen: () => void;
}) {
  const theme = props.api.theme.current;

  const q = createMemo(() => props.quota());
  const err = createMemo(() => props.error());

  const creditColor = createMemo<ThemeColor>(() =>
    q() && q()!.balance.credits_remaining_usd <= 0 ? "error" : "primary",
  );
  const creditUsedPct = createMemo(() =>
    q() && q()!.balance.total_credits_usd > 0
      ? (q()!.balance.credits_used_usd / q()!.balance.total_credits_usd) * 100
      : 0,
  );
  const sub = createMemo(() => q()?.subscription ?? null);
  const hasKwh = createMemo(() => {
    const s = sub();
    return Boolean(s && (s.kwh_included ?? 0) > 0);
  });
  const kwhUsedPct = createMemo(() => {
    const s = sub();
    return hasKwh() && s && s.kwh_included! > 0
      ? (s.kwh_used! / s.kwh_included!) * 100
      : 0;
  });
  const kwhColor = createMemo<ThemeColor | null>(() => {
    const s = sub();
    if (!hasKwh() || !s) return null;
    return s.in_overage ? "error" : "primary";
  });
  const inOverage = createMemo(() => {
    const s = sub();
    return Boolean(s && s.in_overage);
  });
  const accountingColor = createMemo<ThemeColor>(() =>
    q()?.balance.accounting_method === "energy" ? "success" : "info",
  );

  return (
    <box
      width="100%"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
      onMouseUp={props.onOpen}
    >
      <Divider theme={theme} />

      <box flexDirection="row" justifyContent="space-between">
        <box backgroundColor={theme.primary} paddingLeft={1} paddingRight={1}>
          <text
            fg={theme.selectedListItemText}
            attributes={TextAttributes.BOLD}
          >
            Neuralwatt
          </text>
        </box>
        <text fg={q() ? theme[accountingColor()] : theme.textMuted}>
          {q() ? q()!.balance.accounting_method : "loading"}
        </text>
      </box>

      {err() ? (
        <text fg={theme.error}>{err()}</text>
      ) : q() ? (
        <>
          <box flexDirection="column" gap={0}>
            <LegendRow
              theme={theme}
              marker="█"
              markerColor={creditColor()}
              label="Credits used"
              value={formatCurrency(q()!.balance.credits_used_usd)}
            />
            <LegendRow
              theme={theme}
              marker="░"
              markerColor={
                q()!.balance.credits_remaining_usd <= 0 ? "error" : "borderSubtle"
              }
              label="Credits remaining"
              value={formatCurrency(q()!.balance.credits_remaining_usd)}
            />
            <LegendRow
              theme={theme}
              marker="🜂"
              markerColor="warning"
              label="Credits burn rate"
              value={estimateDuration(
                q()!.balance.credits_remaining_usd,
                burnRateCurrentMonth(q()!),
              )}
            />
          </box>

          <SidebarUsageBlock
            theme={theme}
            creditUsedPct={creditUsedPct()}
            creditColor={creditColor()}
            hasKwh={hasKwh()}
            sub={sub()!}
            kwhUsedPct={kwhUsedPct()}
            kwhColor={kwhColor() ?? "primary"}
            inOverage={inOverage()}
            kwhBurnRate={
              sub()
                ? estimateDuration(
                    sub()!.kwh_remaining ?? 0,
                    burnRateKwh(sub()!, q()!.snapshot_at),
                  )
                : "—"
            }
            monthCost={q()!.usage.current_month.cost_usd}
            monthKwh={q()!.usage.current_month.energy_kwh}
            lifetimeCost={q()!.usage.lifetime.cost_usd}
            lifetimeKwh={q()!.usage.lifetime.energy_kwh}
          />
        </>
      ) : (
        <text fg={theme.textMuted}>Loading…</text>
      )}

      <UpdateNotice
        theme={theme}
        latestVersion={props.latestVersion}
        updateStatus={props.updateStatus}
        updateError={props.updateError}
        onInstall={props.onInstall}
        compact
      />

      <Divider theme={theme} />
    </box>
  );
}

function Divider(props: { theme: Theme }) {
  return (
    <box
      border={["bottom"]}
      borderColor={props.theme.borderSubtle}
      height={1}
    />
  );
}

function LegendRow(props: {
  theme: Theme;
  marker?: string;
  markerColor?: ThemeColor;
  label: string;
  value: string;
}) {
  const hasMarker = Boolean(props.marker);
  return (
    <box flexDirection="row" gap={0}>
      <box width={2}>
        {hasMarker ? (
          <text fg={props.theme[props.markerColor ?? "primary"]}>
            {props.marker}
          </text>
        ) : null}
      </box>
      <box flexGrow={1}>
        <text fg={props.theme.text}>{props.label}</text>
      </box>
      <text fg={props.theme.textMuted}>{props.value}</text>
    </box>
  );
}

function CombinedBar(props: {
  theme: Theme;
  percent: number;
  color: ThemeColor;
}) {
  const pct = Math.max(0, Math.min(100, props.percent));

  return (
    <box
      width="100%"
      height={1}
      marginTop={1}
      backgroundColor={props.theme.borderSubtle}
    >
      {pct > 0 ? (
        <box
          width={`${pct}%`}
          height={1}
          backgroundColor={props.theme[props.color]}
        />
      ) : null}
    </box>
  );
}

function SidebarUsageBlock(props: {
  theme: Theme;
  creditUsedPct: number;
  creditColor: ThemeColor;
  hasKwh: boolean;
  sub: Subscription;
  kwhUsedPct: number;
  kwhColor: ThemeColor;
  inOverage: boolean;
  kwhBurnRate: string;
  monthCost: number;
  monthKwh: number;
  lifetimeCost: number;
  lifetimeKwh: number;
}) {
  const metrics = (
    <box width="100%" flexDirection="column" gap={0}>
      <MetricRow
        theme={props.theme}
        label="Month"
        value={`${formatCurrency(props.monthCost)} / ${formatNumber(props.monthKwh, 0)} kWh`}
      />
      <MetricRow
        theme={props.theme}
        label="Lifetime"
        value={`${formatCurrency(props.lifetimeCost)} / ${formatNumber(props.lifetimeKwh, 0)} kWh`}
      />
    </box>
  );

  if (props.hasKwh) {
    return (
      <box width="100%" flexDirection="column" gap={1}>
        <CombinedBar
          theme={props.theme}
          percent={props.creditUsedPct}
          color={props.creditColor}
        />
        <box width="100%" flexDirection="column" gap={0}>
          <LegendRow
            theme={props.theme}
            marker="█"
            markerColor={props.kwhColor}
            label="kWh used"
            value={`${formatNumber(props.sub.kwh_used, 2)} kWh`}
          />
          <LegendRow
            theme={props.theme}
            marker="░"
            markerColor="borderSubtle"
            label="kWh remaining"
            value={`${formatNumber(props.sub.kwh_remaining, 2)} kWh`}
          />
          <LegendRow
            theme={props.theme}
            marker="🜂"
            markerColor="warning"
            label="kWh burn rate"
            value={props.kwhBurnRate}
          />
        </box>
        <CombinedBar
          theme={props.theme}
          percent={props.kwhUsedPct}
          color={props.kwhColor}
        />
        {props.inOverage ? (
          <text fg={props.theme.error}>In overage</text>
        ) : null}
        {metrics}
      </box>
    );
  }

  return (
    <box width="100%" flexDirection="column" gap={1}>
      <CombinedBar
        theme={props.theme}
        percent={props.creditUsedPct}
        color={props.creditColor}
      />
      {metrics}
    </box>
  );
}

function MetricRow(props: { theme: Theme; label: string; value: string }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.theme.textMuted}>{props.label}</text>
      <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
        {props.value}
      </text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// UI primitives (DCP-style)
// ---------------------------------------------------------------------------

function Card(props: { theme: Theme; title: string; children: JSX.Element }) {
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={props.theme.backgroundElement}
      border={["left"]}
      borderColor={props.theme.primary}
      gap={0}
    >
      <text fg={props.theme.primary} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      {props.children}
    </box>
  );
}

function Metric(props: {
  theme: Theme;
  label: string;
  value: string;
  valueColor?: ThemeColor;
}) {
  return (
    <box flexDirection="row" gap={2}>
      <box width={20}>
        <text fg={props.theme.textMuted}>{props.label}</text>
      </box>
      <text
        fg={props.valueColor ? props.theme[props.valueColor] : props.theme.text}
        attributes={TextAttributes.BOLD}
      >
        {props.value}
      </text>
    </box>
  );
}

function FooterButton(props: {
  theme: Theme;
  label: string;
  primary?: boolean;
  accent?: boolean;
  onClick: () => void | Promise<void>;
}) {
  const primary = props.primary ?? false;
  const accent = props.accent ?? false;
  const bg = primary
    ? props.theme.primary
    : accent
      ? props.theme.accent
      : props.theme.backgroundElement;
  const fg = primary || accent
    ? props.theme.selectedListItemText
    : props.theme.text;
  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={bg}
      onMouseUp={props.onClick}
    >
      <text fg={fg}>{props.label}</text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Types/helpers
// ---------------------------------------------------------------------------

type TuiApi = Parameters<NonNullable<TuiPluginModule["tui"]>>[0];
type Theme = TuiApi["theme"]["current"];
type ThemeColor = Exclude<
  keyof Theme,
  "thinkingOpacity" | "_hasSelectedListItemText"
>;

function formatCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function formatNumber(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatInteger(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function formatDate(value: string | Date | null): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatStatus(status: string): string {
  if (!status) return "—";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Burn-rate estimates
// ---------------------------------------------------------------------------

function burnRateCurrentMonth(data: QuotaData): number {
  const days = daysElapsedThisMonth(data.snapshot_at);
  return days > 0 ? data.usage.current_month.cost_usd / days : 0;
}

function burnRateKwh(sub: Subscription, snapshotAt: string): number {
  if (!sub.current_period_start) return 0;
  const days = daysElapsedInPeriod(sub.current_period_start, snapshotAt);
  const kwhUsed = sub.kwh_used ?? 0;
  return days > 0 && kwhUsed > 0 ? kwhUsed / days : 0;
}

function daysElapsedThisMonth(snapshotAt: string): number {
  const now = new Date(snapshotAt);
  if (Number.isNaN(now.getTime())) return 1;
  return Math.max(1, now.getDate());
}

function daysElapsedInPeriod(start: string, snapshotAt: string): number {
  const startMs = new Date(start).getTime();
  const snapMs = new Date(snapshotAt).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(snapMs)) return 1;
  const diffMs = snapMs - startMs;
  return Math.max(1, diffMs / 86_400_000);
}

function estimateDuration(balance: number, burnRate: number): string {
  if (!Number.isFinite(balance) || !Number.isFinite(burnRate)) return "—";
  if (burnRate <= 0) return "∞";
  if (balance <= 0) return "0";
  const days = balance / burnRate;
  if (days < 1) return "<1d";
  if (days < 30) return `~${Math.round(days)}d`;
  if (days < 365) return `~${Math.round(days / 30)}mo`;
  return `~${(days / 365).toFixed(1)}y`;
}

const plugin: TuiPluginModule & { id: string } = {
  id: "jgabor.neuralwatt-quota",
  tui,
};

export default plugin;
