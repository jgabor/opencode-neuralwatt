/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core"
import { createSignal, type JSX } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UsageBucket = {
  cost_usd: number
  requests: number
  tokens: number
  energy_kwh: number
}

type Subscription = {
  plan: string
  status: string
  billing_interval: string | null
  current_period_start: string | null
  current_period_end: string | null
  auto_renew: boolean | null
  kwh_included: number | null
  kwh_used: number | null
  kwh_remaining: number | null
  in_overage: boolean | null
}

type QuotaData = {
  snapshot_at: string
  balance: {
    credits_remaining_usd: number
    total_credits_usd: number
    credits_used_usd: number
    accounting_method: "energy" | "token"
  }
  usage: {
    lifetime: UsageBucket
    current_month: UsageBucket
  }
  limits: {
    overage_limit_usd: number | null
    rate_limit_tier: string
  }
  subscription: Subscription | null
  key: {
    name: string | null
    allowance: {
      limit_usd: number
      period: string
      spent_usd: number
      remaining_usd: number
      blocked: boolean
    } | null
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "https://api.neuralwatt.com/v1"
const REFRESH_INTERVAL_MS = 15_000
const RATE_LIMIT_BUFFER_MS = 1_100
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1_500

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  type QuotaSlotAPI = Parameters<NonNullable<TuiPluginModule["tui"]>>[0]

  const apiKey = process.env.NEURALWATT_API_KEY

  const [quota, setQuota] = createSignal<QuotaData | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [updatedAt, setUpdatedAt] = createSignal<Date | null>(null)

  let lastFetchAt = 0

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const fetchQuotaOnce = async (): Promise<Response> => {
    const now = Date.now()
    if (now - lastFetchAt < RATE_LIMIT_BUFFER_MS) {
      await sleep(RATE_LIMIT_BUFFER_MS - (now - lastFetchAt))
    }
    lastFetchAt = Date.now()
    return fetch(`${API_BASE}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  }

  const fetchQuota = async () => {
    if (!apiKey) {
      setError("NEURALWATT_API_KEY is not set")
      return
    }

    let lastErr: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetchQuotaOnce()

        if (response.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = Number(response.headers.get("retry-after"))
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          await sleep(delay)
          continue
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "")
          throw new Error(`${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`)
        }

        const data = (await response.json()) as QuotaData
        setQuota(data)
        setUpdatedAt(new Date())
        setError(null)
        return
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt))
          continue
        }
      }
    }

    if (lastErr) {
      setError(lastErr.message)
    }
  }

  // Initial fetch + periodic refresh.
  await fetchQuota()
  const interval = setInterval(fetchQuota, REFRESH_INTERVAL_MS)
  api.lifecycle?.onDispose?.(() => clearInterval(interval))

  // Register palette command and slash command.
  const commands = [
    {
      title: "Neuralwatt Quota",
      name: "neuralwatt.quota",
      description: "Show Neuralwatt account quota and usage",
      category: "Neuralwatt",
      slashName: "nw",
      slashAliases: ["neuralwatt"],
      run: () => openPanel(api as QuotaSlotAPI, quota, error, updatedAt, fetchQuota),
    },
  ]

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
    )
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
              onOpen={() => openPanel(api as QuotaSlotAPI, quota, error, updatedAt, fetchQuota)}
            />
          )
        },
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openPanel(
  api: TuiApi,
  quota: () => QuotaData | null,
  error: () => string | null,
  updatedAt: () => Date | null,
  refresh: () => Promise<void>,
) {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => (
    <QuotaPanel
      api={api}
      quota={quota}
      error={error}
      updatedAt={updatedAt}
      onRefresh={refresh}
      onClose={() => api.ui.dialog.clear()}
    />
  ))
}

function QuotaPanel(props: {
  api: TuiApi
  quota: () => QuotaData | null
  error: () => string | null
  updatedAt: () => Date | null
  onRefresh: () => Promise<void>
  onClose: () => void
}) {
  const theme = props.api.theme.current
  const q = props.quota()
  const err = props.error()
  const updated = props.updatedAt()

  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="column">
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Neuralwatt
          </text>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Quota
          </text>
        </box>
        <text fg={theme.textMuted} onMouseUp={props.onClose}>
          esc
        </text>
      </box>

      <box height={1} border={["bottom"]} borderColor={theme.borderSubtle} />

      {err ? (
        <Card theme={theme} title="Error">
          <text fg={theme.error}>{err}</text>
          {!process.env.NEURALWATT_API_KEY ? (
            <text fg={theme.textMuted}>
              Set NEURALWATT_API_KEY in your environment and restart OpenCode.
            </text>
          ) : null}
        </Card>
      ) : null}

      {q ? (
        <>
          <Card theme={theme} title="Balance">
            <Metric
              theme={theme}
              label="Remaining"
              value={formatCurrency(q.balance.credits_remaining_usd)}
            />
            <Metric theme={theme} label="Used" value={formatCurrency(q.balance.credits_used_usd)} />
            <Metric theme={theme} label="Total" value={formatCurrency(q.balance.total_credits_usd)} />
            <Metric theme={theme} label="Accounting" value={q.balance.accounting_method} />
            <Progress
              theme={theme}
              label="Credits used"
              value={q.balance.credits_used_usd}
              total={q.balance.total_credits_usd}
              color={q.balance.credits_remaining_usd <= 0 ? "error" : "primary"}
            />
          </Card>

          {q.subscription ? (
            <Card theme={theme} title="Subscription">
              <Metric theme={theme} label="Plan" value={q.subscription.plan} />
              <Metric theme={theme} label="Status" value={formatStatus(q.subscription.status)} />
              <Metric
                theme={theme}
                label="Period"
                value={`${formatDate(q.subscription.current_period_start)} → ${formatDate(
                  q.subscription.current_period_end,
                )}`}
              />
              <Metric
                theme={theme}
                label="Auto renew"
                value={q.subscription.auto_renew ? "yes" : "no"}
              />
              <Progress
                theme={theme}
                label="kWh used"
                value={q.subscription.kwh_used ?? 0}
                total={q.subscription.kwh_included ?? 0}
                color={q.subscription.in_overage ? "error" : "primary"}
              />
              <Metric
                theme={theme}
                label="kWh remaining"
                value={`${formatNumber(q.subscription.kwh_remaining ?? 0, 2)} kWh`}
              />
              {q.subscription.in_overage ? (
                <text fg={theme.error}>In overage</text>
              ) : null}
            </Card>
          ) : null}

          <Card theme={theme} title="Usage (current month)">
            <Metric theme={theme} label="Cost" value={formatCurrency(q.usage.current_month.cost_usd)} />
            <Metric theme={theme} label="Requests" value={formatInteger(q.usage.current_month.requests)} />
            <Metric theme={theme} label="Tokens" value={formatInteger(q.usage.current_month.tokens)} />
            <Metric theme={theme} label="Energy" value={`${formatNumber(q.usage.current_month.energy_kwh, 3)} kWh`} />
          </Card>

          <Card theme={theme} title="Usage (lifetime)">
            <Metric theme={theme} label="Cost" value={formatCurrency(q.usage.lifetime.cost_usd)} />
            <Metric theme={theme} label="Requests" value={formatInteger(q.usage.lifetime.requests)} />
            <Metric theme={theme} label="Tokens" value={formatInteger(q.usage.lifetime.tokens)} />
            <Metric theme={theme} label="Energy" value={`${formatNumber(q.usage.lifetime.energy_kwh, 3)} kWh`} />
          </Card>

          <Card theme={theme} title="Burn rate">
            <Metric
              theme={theme}
              label="Current month"
              value={`${formatCurrency(burnRateCurrentMonth(q))}/day`}
            />
            <Metric
              theme={theme}
              label="Credits left"
              value={estimateDuration(q.balance.credits_remaining_usd, burnRateCurrentMonth(q))}
            />
          </Card>

          {q.key.allowance ? (
            <Card theme={theme} title="Key Allowance">
              <Metric theme={theme} label="Key" value={q.key.name ?? "—"} />
              <Metric theme={theme} label="Limit" value={formatCurrency(q.key.allowance.limit_usd)} />
              <Metric theme={theme} label="Period" value={q.key.allowance.period} />
              <Metric
                theme={theme}
                label="Spent"
                value={formatCurrency(q.key.allowance.spent_usd)}
              />
              <Metric
                theme={theme}
                label="Remaining"
                value={formatCurrency(q.key.allowance.remaining_usd)}
              />
              <Metric
                theme={theme}
                label="Blocked"
                value={q.key.allowance.blocked ? "yes" : "no"}
              />
            </Card>
          ) : null}
        </>
      ) : (
        <Card theme={theme} title="Loading">
          <text fg={theme.textMuted}>Fetching quota from Neuralwatt…</text>
        </Card>
      )}

      <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
        <text fg={theme.textMuted}>{updated ? `Updated ${updated.toLocaleTimeString()}` : ""}</text>
        <box flexDirection="row" gap={1}>
          <FooterButton theme={theme} label="refresh" onClick={props.onRefresh} />
          <FooterButton theme={theme} label="close" primary onClick={props.onClose} />
        </box>
      </box>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Sidebar widget (DCP-style)
// ---------------------------------------------------------------------------

function SidebarView(props: {
  api: TuiApi
  quota: () => QuotaData | null
  error: () => string | null
  updatedAt: () => Date | null
  onOpen: () => void
}) {
  const theme = props.api.theme.current
  const q = props.quota()
  const err = props.error()

  const creditColor: ThemeColor =
    q && q.balance.credits_remaining_usd <= 0 ? "error" : "primary"
  const creditUsedPct =
    q && q.balance.total_credits_usd > 0
      ? (q.balance.credits_used_usd / q.balance.total_credits_usd) * 100
      : 0
  const sub = q?.subscription ?? null
  const hasKwh = sub && (sub.kwh_included ?? 0) > 0
  const kwhUsedPct =
    hasKwh && sub.kwh_included! > 0 ? (sub.kwh_used! / sub.kwh_included!) * 100 : 0
  const kwhColor: ThemeColor = hasKwh && sub.in_overage ? "error" : "primary"
  const accountingColor: ThemeColor =
    q?.balance.accounting_method === "energy" ? "success" : "info"

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
          <text fg={theme.selectedListItemText} attributes={TextAttributes.BOLD}>
            Neuralwatt
          </text>
        </box>
        <text fg={q ? theme[accountingColor] : theme.textMuted}>
          {q ? q.balance.accounting_method : "loading"}
        </text>
      </box>

      {err ? (
        <text fg={theme.error}>{err}</text>
      ) : q ? (
        <>
          <box flexDirection="column" gap={0}>
            <LegendRow
              theme={theme}
              marker="█"
              markerColor={creditColor}
              label="Credits used"
              value={formatCurrency(q.balance.credits_used_usd)}
            />
            <LegendRow
              theme={theme}
              marker="░"
              markerColor={creditColor === "error" ? "error" : "borderSubtle"}
              label="Credits remaining"
              value={formatCurrency(q.balance.credits_remaining_usd)}
            />
            <LegendRow
              theme={theme}
              marker="🜂"
              markerColor="warning"
              label="Credits burn rate"
              value={estimateDuration(
                q.balance.credits_remaining_usd,
                burnRateCurrentMonth(q),
              )}
            />
          </box>

          <SidebarUsageBlock
            theme={theme}
            creditUsedPct={creditUsedPct}
            creditColor={creditColor}
            hasKwh={Boolean(hasKwh)}
            sub={sub!}
            kwhUsedPct={kwhUsedPct}
            kwhColor={kwhColor}
            kwhBurnRate={sub ? estimateDuration(sub.kwh_remaining ?? 0, burnRateKwh(sub, q.snapshot_at)) : "—"}
            monthCost={q.usage.current_month.cost_usd}
            monthKwh={q.usage.current_month.energy_kwh}
            lifetimeCost={q.usage.lifetime.cost_usd}
            lifetimeKwh={q.usage.lifetime.energy_kwh}
          />
        </>
      ) : (
        <text fg={theme.textMuted}>Loading…</text>
      )}

      <Divider theme={theme} />
    </box>
  )
}

function Divider(props: { theme: Theme }) {
  return <box border={["bottom"]} borderColor={props.theme.borderSubtle} height={1} />
}

function LegendRow(props: {
  theme: Theme
  marker?: string
  markerColor?: ThemeColor
  label: string
  value: string
}) {
  const hasMarker = Boolean(props.marker)
  return (
    <box flexDirection="row" gap={0}>
      <box width={2}>
        {hasMarker ? (
          <text fg={props.theme[props.markerColor ?? "primary"]}>{props.marker}</text>
        ) : null}
      </box>
      <box flexGrow={1}>
        <text fg={props.theme.text}>{props.label}</text>
      </box>
      <text fg={props.theme.textMuted}>{props.value}</text>
    </box>
  )
}

function CombinedBar(props: { theme: Theme; percent: number; color: ThemeColor }) {
  const pct = Math.max(0, Math.min(100, props.percent))
  const filled = Math.max(0, Math.round(pct))
  const empty = Math.max(0, 100 - filled)

  return (
    <box width="100%" flexDirection="row" height={1}>
      {filled > 0 ? (
        <box flexGrow={filled} flexShrink={1} height={1} backgroundColor={props.theme[props.color]} />
      ) : null}
      <box flexGrow={empty} flexShrink={1} height={1} backgroundColor={props.theme.borderSubtle} />
    </box>
  )
}

function SidebarUsageBlock(props: {
  theme: Theme
  creditUsedPct: number
  creditColor: ThemeColor
  hasKwh: boolean
  sub: Subscription
  kwhUsedPct: number
  kwhColor: ThemeColor
  kwhBurnRate: string
  monthCost: number
  monthKwh: number
  lifetimeCost: number
  lifetimeKwh: number
}) {
  const metrics = (
    <box width="100%" flexDirection="column" gap={0}>
      <MetricRow theme={props.theme} label="Month" value={`${formatCurrency(props.monthCost)} / ${formatNumber(props.monthKwh, 0)} kWh`} />
      <MetricRow theme={props.theme} label="Lifetime" value={`${formatCurrency(props.lifetimeCost)} / ${formatNumber(props.lifetimeKwh, 0)} kWh`} />
    </box>
  )

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
            value={`${formatNumber(props.sub.kwh_used ?? 0, 1)} kWh`}
          />
          <LegendRow
            theme={props.theme}
            marker="░"
            markerColor="borderSubtle"
            label="kWh remaining"
            value={`${formatNumber(props.sub.kwh_remaining ?? 0, 1)} kWh`}
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
        {metrics}
      </box>
    )
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
  )
}

function MetricRow(props: { theme: Theme; label: string; value: string }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.theme.textMuted}>{props.label}</text>
      <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
        {props.value}
      </text>
    </box>
  )
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
      gap={1}
    >
      <text fg={props.theme.primary} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      {props.children}
    </box>
  )
}

function Metric(props: { theme: Theme; label: string; value: string }) {
  return (
    <box flexDirection="row" gap={2}>
      <box width={20}>
        <text fg={props.theme.textMuted}>{props.label}</text>
      </box>
      <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
        {props.value}
      </text>
    </box>
  )
}

function Progress(props: {
  theme: Theme
  label: string
  value: number
  total: number
  color: ThemeColor
}) {
  const pct = props.total > 0 ? Math.max(0, Math.min(100, (props.value / props.total) * 100)) : 0
  const filled = Math.max(0, Math.round(pct))
  const empty = Math.max(0, 100 - filled)

  return (
    <box width="100%" flexDirection="column" gap={0}>
      <box flexDirection="row" gap={2}>
        <box width={20}>
          <text fg={props.theme.text}>{props.label}</text>
        </box>
        <text fg={props.theme[props.color]} attributes={TextAttributes.BOLD}>
          {`${pct.toFixed(1)}%`}
        </text>
      </box>
      <box width="100%" flexDirection="row" height={1}>
        {filled > 0 ? (
          <box flexGrow={filled} flexShrink={1} height={1} backgroundColor={props.theme[props.color]} />
        ) : null}
        <box flexGrow={empty} flexShrink={1} height={1} backgroundColor={props.theme.borderSubtle} />
      </box>
    </box>
  )
}

function FooterButton(props: {
  theme: Theme
  label: string
  primary?: boolean
  onClick: () => void | Promise<void>
}) {
  const primary = props.primary ?? false
  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={primary ? props.theme.primary : props.theme.backgroundElement}
      onMouseUp={props.onClick}
    >
      <text fg={primary ? props.theme.selectedListItemText : props.theme.text}>{props.label}</text>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Types/helpers
// ---------------------------------------------------------------------------

type TuiApi = Parameters<NonNullable<TuiPluginModule["tui"]>>[0]
type Theme = TuiApi["theme"]["current"]
type ThemeColor = Exclude<keyof Theme, "thinkingOpacity" | "_hasSelectedListItemText">

function formatCurrency(n: number): string {
  return `$${n.toFixed(2)}`
}

function formatNumber(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function formatInteger(n: number): string {
  return n.toLocaleString()
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString()
}

function formatStatus(status: string): string {
  if (!status) return "—"
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Burn-rate estimates
// ---------------------------------------------------------------------------

function burnRateCurrentMonth(data: QuotaData): number {
  const days = daysElapsedThisMonth(data.snapshot_at)
  return days > 0 ? data.usage.current_month.cost_usd / days : 0
}

function burnRateKwh(sub: Subscription, snapshotAt: string): number {
  if (!sub.current_period_start) return 0
  const days = daysElapsedInPeriod(sub.current_period_start, snapshotAt)
  const kwhUsed = sub.kwh_used ?? 0
  return days > 0 && kwhUsed > 0 ? kwhUsed / days : 0
}

function daysElapsedThisMonth(snapshotAt: string): number {
  const now = new Date(snapshotAt)
  return Math.max(1, now.getDate())
}

function daysElapsedInPeriod(start: string, snapshotAt: string): number {
  const diffMs = new Date(snapshotAt).getTime() - new Date(start).getTime()
  return Math.max(1, diffMs / 86_400_000)
}

function estimateDuration(balance: number, burnRate: number): string {
  if (burnRate <= 0) return "∞"
  const days = balance / burnRate
  if (days < 1) return "<1d"
  if (days < 30) return `~${Math.round(days)}d`
  if (days < 365) return `~${Math.round(days / 30)}mo`
  return `~${(days / 365).toFixed(1)}y`
}

const plugin: TuiPluginModule & { id: string } = {
  id: "jgabor.neuralwatt-quota",
  tui,
}

export default plugin
