/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { createMemo, createSignal, type JSX } from "solid-js";
import type { TuiPlugin, TuiPluginModule, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import { promises as fs } from "node:fs";
import os from "node:os";
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

type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
};

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: MAX_RETRIES + 1,
  baseDelayMs: RETRY_BASE_DELAY_MS,
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the per-platform user cache directory, mirroring Go's
 * os.UserCacheDir() (what opencode uses to lay out `~/.cache/opencode/packages`):
 *  - macOS: `$HOME/Library/Caches`
 *  - Linux: `$XDG_CACHE_HOME` or `$HOME/.cache`
 *  - Windows: `%LocalAppData%`
 * Returns `null` if no platform-appropriate base can be resolved.
 */
function resolveUserCacheDir(): string | null {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === "darwin") {
    return home ? path.join(home, "Library", "Caches") : null;
  }
  if (platform === "win32") {
    return process.env.LOCALAPPDATA ?? (home ? path.join(home, "AppData", "Local") : null);
  }
  // Linux and other unices.
  return process.env.XDG_CACHE_HOME ?? (home ? path.join(home, ".cache") : null);
}

// ---------------------------------------------------------------------------
// Update notifier (external seam of the update subsystem)
// ---------------------------------------------------------------------------

type UpdateStatus = "idle" | "checking" | "available" | "installing" | "installed" | "error";

type UpdateNotifier = {
  latestVersion: () => string | null;
  status: () => UpdateStatus;
  error: () => string | null;
  install: () => Promise<void>;
  check: () => Promise<void>;
};

function specIsUnpinned(spec: string): boolean {
  if (!spec.includes("@")) return true;
  if (spec.endsWith("@latest")) return true;
  return false;
}

/**
 * Owns the three update signals plus the check/install pipelines. The four
 * formerly free functions (`checkForUpdate`, `specIsUnpinned`,
 * `bumpPinnedSpecInConfig`, `installLatestVersion`) close over `{ api, meta }`
 * and the signals, becoming private to this module.
 *
 * Cache-nuke path is resolved per-platform via `resolveUserCacheDir()` and
 * is package-scoped (`packages/@jgabor/opencode-neuralwatt@latest`), not
 * shared — it cannot affect other plugins or the shared `node_modules/`.
 * Errors are swallowed so an unexpected cache layout doesn't abort install.
 *
 * Known issue (deferred — not introduced by this refactor):
 *  - `tui.json` in the config-candidate list is not a documented opencode
 *    config file — a phantom candidate silently skipped by the regex check.
 */
function createUpdateNotifier(opts: {
  api: TuiApi;
  meta: TuiPluginMeta;
}): UpdateNotifier {
  const { api, meta } = opts;

  const [latestVersion, setLatestVersion] = createSignal<string | null>(null);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>("idle");
  const [updateError, setUpdateError] = createSignal<string | null>(null);

  // ---- check -------------------------------------------------------------

  const check = async () => {
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
  };

  // ---- install -----------------------------------------------------------

  const bumpPinnedSpecInConfig = async (oldSpec: string, latest: string): Promise<void> => {
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
  };

  const install = async () => {
    setUpdateStatus("installing");
    setUpdateError(null);
    try {
      if (specIsUnpinned(meta.spec)) {
        const cacheBase = resolveUserCacheDir();
        if (cacheBase) {
          const cacheDir = path.join(
            cacheBase,
            "opencode",
            "packages",
            "@jgabor",
            "opencode-neuralwatt@latest",
          );
          // package-scoped: nukes only our cached @latest install, never the
          // shared node_modules or other plugins' sibling dirs. Swallow errors
          // so an unexpected cache layout doesn't abort the install.
          await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      const latest = latestVersion() ?? "";
      const spec = `@jgabor/opencode-neuralwatt@${latest}`;
      const result = await api.plugins.install(spec, { global: true });
      if (!result.ok) throw new Error(result.message);
      await bumpPinnedSpecInConfig(meta.spec, latest);
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
  };

  return { latestVersion, status: updateStatus, error: updateError, install, check };
}

// ---------------------------------------------------------------------------
// Quota store (external seam of the Quota subsystem)
// ---------------------------------------------------------------------------

type QuotaStore = {
  quota: () => QuotaData | null;
  error: () => string | null;
  updatedAt: () => Date | null;
  refresh: () => Promise<void>;
  /** Begin the periodic refresh interval. Call after the initial `refresh()`
   *  so the first polling tick doesn't race an in-flight initial fetch. */
  startPolling: () => void;
};

/**
 * Fetch transport with retry classification. Retries 429 and 5xx (and network
 * throws) with exponential backoff; fails fast on 4xx other than 429 — those
 * represent permanent errors (bad key, forbidden, not found) and retrying
 * would only add latency. Honors `Retry-After` when finite and > 0.
 *
 * Internal seam of the Quota store: not part of the store interface.
 */
async function fetchWithRetry(
  task: () => Promise<Response>,
  policy: RetryPolicy,
): Promise<Response> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    let failFast: Error | null = null;
    let nextDelay: number | null = null;

    try {
      const response = await task();
      if (response.ok) return response;

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable) {
        lastErr = new Error(`${response.status} ${response.statusText}`);
        const retryAfter = Number(response.headers.get("retry-after"));
        nextDelay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : policy.baseDelayMs * Math.pow(2, attempt);
      } else {
        const body = await response.text().catch(() => "");
        failFast = new Error(
          `${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
        );
      }
    } catch (err) {
      // Network throw or body-read throw — retryable.
      lastErr = err instanceof Error ? err : new Error(String(err));
      nextDelay = policy.baseDelayMs * Math.pow(2, attempt);
    }

    if (failFast) {
      // 4xx (except 429) — permanent error, do not retry.
      throw failFast;
    }

    if (attempt < policy.maxAttempts - 1 && nextDelay !== null) {
      await sleep(nextDelay);
    }
  }

  throw lastErr ?? new Error("fetchWithRetry exhausted with no error");
}

function fetchQuotaOnce(apiKey: string | undefined): () => Promise<Response> {
  let lastFetchAt = 0;
  return async () => {
    const now = Date.now();
    if (now - lastFetchAt < RATE_LIMIT_BUFFER_MS) {
      await sleep(RATE_LIMIT_BUFFER_MS - (now - lastFetchAt));
    }
    lastFetchAt = Date.now();
    return fetch(`${API_BASE}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  };
}

function createQuotaStore(opts: {
  apiKey: string | undefined;
  transport: () => Promise<Response>;
  intervalMs: number;
  onDispose: (fn: () => void) => void;
}): QuotaStore {
  const [quota, setQuota] = createSignal<QuotaData | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [updatedAt, setUpdatedAt] = createSignal<Date | null>(null);

  const refresh = async () => {
    if (!opts.apiKey) {
      setError("NEURALWATT_API_KEY is not set");
      return;
    }
    try {
      const response = await opts.transport();
      const data = (await response.json()) as QuotaData;
      setQuota(data);
      setUpdatedAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startPolling = () => {
    const interval = setInterval(refresh, opts.intervalMs);
    opts.onDispose(() => clearInterval(interval));
  };

  return { quota, error, updatedAt, refresh, startPolling };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api, _options, meta) => {
  type QuotaSlotAPI = Parameters<NonNullable<TuiPluginModule["tui"]>>[0];

  const apiKey = process.env.NEURALWATT_API_KEY;

  const fetchOnce = fetchQuotaOnce(apiKey);
  const store = createQuotaStore({
    apiKey,
    transport: () => fetchWithRetry(fetchOnce, DEFAULT_RETRY_POLICY),
    intervalMs: REFRESH_INTERVAL_MS,
    onDispose: (fn) => api.lifecycle?.onDispose?.(fn),
  });

  const notifier = createUpdateNotifier({ api: api as TuiApi, meta });

  // Initial fetch + periodic refresh.
  await store.refresh();
  store.startPolling();

  // Check for plugin updates (fire-and-forget).
  void notifier.check();

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
          store,
          notifier,
          meta,
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
              store={store}
              notifier={notifier}
              onOpen={() =>
                openPanel(
                  api as QuotaSlotAPI,
                  store,
                  notifier,
                  meta,
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
  store: QuotaStore,
  notifier: UpdateNotifier,
  meta: TuiPluginMeta,
) {
  api.ui.dialog.setSize("xlarge");
  api.ui.dialog.replace(() => (
    <QuotaPanel
      api={api}
      store={store}
      notifier={notifier}
      onRefresh={store.refresh}
      onClose={() => api.ui.dialog.clear()}
      meta={meta}
    />
  ));
}

function QuotaPanel(props: {
  api: TuiApi;
  store: QuotaStore;
  notifier: UpdateNotifier;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  meta: TuiPluginMeta;
}) {
  const theme = props.api.theme.current;

  const q = createMemo(() => props.store.quota());
  const err = createMemo(() => props.store.error());
  const updated = createMemo(() => props.store.updatedAt());

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
                notifier={props.notifier}
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
          {props.notifier.status() === "available" && props.notifier.latestVersion() ? (
            <FooterButton
              theme={theme}
              label={`update ${props.notifier.latestVersion()}`}
              accent
              onClick={props.notifier.install}
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
  notifier: UpdateNotifier;
  compact?: boolean;
}) {
  const theme = props.theme;
  const status = props.notifier.status();
  const latest = props.notifier.latestVersion();
  const compact = props.compact ?? false;

  if (status === "available" && latest) {
    return (
      <box
        flexDirection={compact ? "column" : "row"}
        justifyContent={compact ? "flex-start" : "space-between"}
        alignItems="flex-end"
        onMouseUp={() => void props.notifier.install()}
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
        {`Update failed: ${props.notifier.error() ?? "unknown error"}`}
      </text>
    );
  }
  return null;
}

function SidebarView(props: {
  api: TuiApi;
  store: QuotaStore;
  notifier: UpdateNotifier;
  onOpen: () => void;
}) {
  const theme = props.api.theme.current;

  const q = createMemo(() => props.store.quota());
  const err = createMemo(() => props.store.error());

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
        <SidebarUsageBlock
          theme={theme}
          creditUsedPct={creditUsedPct()}
          creditColor={creditColor()}
          creditsUsed={formatCurrency(q()!.balance.credits_used_usd)}
          creditsRemaining={formatCurrency(q()!.balance.credits_remaining_usd)}
          creditsRemainingMarkerColor={
            q()!.balance.credits_remaining_usd <= 0 ? "error" : "borderSubtle"
          }
          creditsBurnRate={
            hasKwh()
              ? "—"
              : estimateDuration(
                  q()!.balance.credits_remaining_usd,
                  burnRateCurrentMonth(q()!),
                )
          }
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
          resetsIn={
            sub()
              ? daysUntilPeriodReset(
                  sub()!.current_period_end,
                  q()!.snapshot_at,
                )
              : "—"
          }
          monthCost={q()!.usage.current_month.cost_usd}
          monthKwh={q()!.usage.current_month.energy_kwh}
          lifetimeCost={q()!.usage.lifetime.cost_usd}
          lifetimeKwh={q()!.usage.lifetime.energy_kwh}
        />
      ) : (
        <text fg={theme.textMuted}>Loading…</text>
      )}

      <UpdateNotice
        theme={theme}
        notifier={props.notifier}
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
  creditsUsed: string;
  creditsRemaining: string;
  creditsRemainingMarkerColor: ThemeColor;
  creditsBurnRate: string;
  hasKwh: boolean;
  sub: Subscription;
  kwhUsedPct: number;
  kwhColor: ThemeColor;
  inOverage: boolean;
  kwhBurnRate: string;
  resetsIn: string;
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

  const creditsSection = (
    <>
      <box width="100%" flexDirection="column" gap={0}>
        <LegendRow
          theme={props.theme}
          marker="█"
          markerColor={props.creditColor}
          label="Credits used"
          value={props.creditsUsed}
        />
        <LegendRow
          theme={props.theme}
          marker="░"
          markerColor={props.creditsRemainingMarkerColor}
          label="Credits remaining"
          value={props.creditsRemaining}
        />
        {!props.hasKwh ? (
          <LegendRow
            theme={props.theme}
            marker="🜂"
            markerColor="warning"
            label="Credits burn rate"
            value={props.creditsBurnRate}
          />
        ) : null}
      </box>
      <CombinedBar
        theme={props.theme}
        percent={props.creditUsedPct}
        color={props.creditColor}
      />
    </>
  );

  const kwhSection = props.hasKwh ? (
    <>
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
        <LegendRow
          theme={props.theme}
          marker="↻"
          markerColor="warning"
          label="kWh resets in"
          value={props.resetsIn}
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
    </>
  ) : null;

  return (
    <box width="100%" flexDirection="column" gap={1}>
      {kwhSection}
      {creditsSection}
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

function daysUntilPeriodReset(periodEnd: string | null, snapshotAt: string): string {
  if (!periodEnd) return "—";
  const endMs = new Date(periodEnd).getTime();
  const snapMs = new Date(snapshotAt).getTime();
  if (Number.isNaN(endMs) || Number.isNaN(snapMs)) return "—";
  const days = (endMs - snapMs) / 86_400_000;
  if (days <= 0) return "0d";
  if (days < 1) return "<1d";
  return `${Math.round(days)}d`;
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
