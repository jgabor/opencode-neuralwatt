# TODO

## ⇶ Critical — proactive alerting

- [x] Toast on quota state transitions. Detect `subscription.in_overage` flipping true, `balance.credits_remaining_usd <= 0`, and `key.allowance.blocked` flipping true across a refresh cycle, and surface via `api.ui.toast`. The toast infrastructure already exists (update notifier uses it) but is never used for quota state. Highest impact: catches problems without the user watching the sidebar.

## ⇉ Degraded — fetched but never displayed

- [x] Display `limits.overage_limit_usd` in the Balance or Subscription card with a secondary `CombinedBar` showing overage headroom. Currently fetched and discarded — most valuable at the moment a user enters or approaches overage.
- [x] Display `limits.rate_limit_tier` as a badge next to the plan name, or in the sidebar header row next to the accounting method. Currently fetched and discarded.
- [x] Display `subscription.billing_interval` next to the plan name in the Subscription card. Currently fetched and discarded.

## → Normal — modal/sidebar display parity

- [ ] Add kWh/day burn rate row to the modal's Burn rate card. The computation already exists (`burnRateKwh`) and is shown in the sidebar, but the modal only shows credit/day.
- [ ] Add kWh runway estimate to the modal's Burn rate card. Shown in the sidebar via `estimateDuration(kwh_remaining, burnRateKwh)`, absent from the modal.
- [ ] Add period reset countdown (`daysUntilPeriodReset`) to the modal's Subscription card. Computed and shown in the sidebar, missing from the modal.

## ⇢ Annoying — new features from existing data

- [ ] Session trend sparkline. Keep a small ring buffer of `{ snapshot_at, credits_remaining_usd, kwh_remaining }` samples across refresh cycles during the session, and render a compact trend line in the sidebar. Pure client-side, no new API call. Useful for spotting burn acceleration.
- [ ] Efficiency metrics. Compute kWh-per-1M-tokens and cost-per-1M-tokens from the existing `usage.current_month` and `usage.lifetime` buckets. Lets users compare energy vs token accounting methods concretely. Moderate effort (computation + rendering).
