---
name: multi-horse-odds-comparison
description: "Build or extend a React market-odds modal that overlays multiple entrants from one event on a shared time-and-value chart, including a marked sudden-movement point. Use when users request comparing several horses, products, participants, or market subjects in one odds/history graph."
---

# Multi-Horse Odds Comparison

## Use This Skill When

Use this skill to extend a database-backed alert detail view from one subject's odds history to a comparable multi-subject chart. Prefer it for a race or event modal that already has a focal alert subject and needs a shared timeline, legend, and sudden-movement marker.

Do not use it to create placeholder chart data. Render only persisted snapshots from the application's approved data source.

## Required Data Contract

Return the existing focal subject history and a bounded comparison payload from the detail API. Select the focal subject first, then the most recently observed subjects with valid values, normally capped at four.

```ts
type ComparisonSeries = {
  horseNumber: number;
  horseName: string | null;
  history: Array<{
    horseNumber: number;
    horseName: string | null;
    winOdds: number | null;
    fetchedAt: Date | string | null;
  }>;
};

type DetailPayload = {
  movement: { horseNumber: number; detectedAt: Date } | null;
  comparisonOddsHistory: ComparisonSeries[];
};
```

## Workflow

1. **Inspect existing data and rendering.** Confirm the snapshot table has a canonical event ID, subject ID, value, and timestamp. Confirm which subject triggered the alert and how its detection time is returned.

2. **Build a bounded comparison query.** Query only snapshots for the selected event, order them by most recent collection time, and limit the row count. Choose the focal subject first, then distinct subjects with a numeric value. Exclude subjects that have no usable observations.

3. **Normalize the response.** Group selected rows per subject, restore each subject's history to chronological order, and convert numeric database values at the API boundary. Preserve nulls for missing values instead of inventing values.

4. **Use shared chart bounds.** Derive the earliest and latest valid timestamps and the minimum and maximum valid values across every displayed series. Add a small value-axis padding. Map all points against those same bounds; never map each line independently.

5. **Render comparably.** Draw one polyline per subject with stable, distinct colors. Make the focal subject line slightly thicker. Render a compact legend with subject identifier, display name when available, and latest value. Limit the legend and lines to the API cap.

6. **Keep the movement marker.** Locate the focal subject observation whose collection time is closest to the persisted detection time. Draw a vertical dashed line, an emphasized point, and a short label such as `急変`. Do not place a marker if dates or coordinates are invalid.

7. **Handle unavailable data safely.** Show a concise empty state when fewer than two usable points exist. Keep the alert modal functional when comparison history is absent. Do not display a synthetic line or stale alert merely to fill the space.

8. **Validate before delivery.** Add unit tests for focal-subject priority, value-less subject exclusion, common-axis coordinate mapping, closest-point lookup, and invalid timestamps. Run the TypeScript check, the complete test suite, and a normal-page screenshot. When live data is unavailable, do not seed production rows solely for visual verification.

## Implementation Guardrails

- Use canonical event and subject IDs, not display names, for queries and navigation.
- Preserve the existing read-only data flow; do not write alert or odds records from the UI.
- Keep database work bounded: select a small number of subjects and a fixed recent history length.
- Treat rapid odds changes as market observations. Do not label them as insider activity or make causal claims.
- Give the SVG an accessible description that states it is a multi-subject comparison and whether a sudden-movement marker is present.
- Use colors with sufficient contrast against the modal background and do not rely on color alone; retain horse numbers or other textual identifiers in the legend.

## Acceptance Checklist

| Scenario | Expected result |
| --- | --- |
| Focal subject has a movement alert | It is included first, receives visual emphasis, and keeps the marker. |
| Several subjects have snapshots | Up to four histories use one common time and value axis. |
| A subject has only null values | It is excluded from the comparison and legend. |
| Detection time is invalid or absent | Lines render without a movement marker. |
| Too little usable history | The modal displays an honest empty state without fabricated data. |
| No active alert | The surrounding hero layout remains unchanged. |
