---
name: hero-realtime-alert-badge
description: "Build and validate a hero-section breaking-news badge from real-time, database-backed signals. Use when adding prominent priority alerts for odds movements, scheduled important events, or operationally significant updates to a React/web application."
---

# Hero Realtime Alert Badge

## Workflow

1. **Identify sources.** Confirm the persisted signal table, scheduled-event table, timestamps, and destination route. Treat sudden odds movement as a market signal; do not call it insider activity.
2. **Normalize before rendering.** Create a pure helper that receives candidates and returns one highest-priority alert or `null`. Keep time-zone conversion and event start arithmetic testable.
3. **Expose a stable API.** Implement a read endpoint that returns `HeroAlert | null` as documented in [references/data-contract.md](references/data-contract.md). Limit lookback, event window, and query count.
4. **Set priority deliberately.** Give recent material market movement the highest score. Use important upcoming events as a lower-priority fallback. Keep detail factual: measured change, venue, event number, conditions, or time to start.
5. **Keep UI silent by default.** Poll at a modest interval such as 30 seconds. Render no badge for `null`. Make the whole badge a link to a canonical detail route.
6. **Style for urgency.** Include `速報`, one concise title, one truncated detail line, an icon, and a visible action arrow. Keep it responsive and away from navigation.
7. **Verify.** Test priority order, invalid time handling, no-alert behavior, and normal hero layout. Run type checks and the unit-test suite before checkpointing.

## Constraints

- Use persisted, permissioned data only. Do not create production alert rows merely to display a badge.
- Deduplicate repetitive signals before rendering.
- Build routes from canonical identifiers, not display text.
- Exclude stale events and signals outside the configured time window.
- Keep detailed data on the destination page; keep the hero badge concise.

## Acceptance checks

| Scenario | Expected behavior |
| --- | --- |
| No eligible signal | Render no badge and preserve the hero layout. |
| Market movement and important event coexist | Market movement wins. |
| Past event | Ignore it. |
| Invalid date or start time | Ignore it without throwing. |
| Mobile viewport | Keep the badge readable without overlapping navigation. |

Read [references/data-contract.md](references/data-contract.md) before defining the endpoint and client component.
