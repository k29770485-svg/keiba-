# Hero Alert Data Contract

Use a stable response that can render a single alert or no alert.

```ts
type HeroAlert = {
  kind: "odds" | "important_race" | "operational";
  urgency: "high" | "medium";
  title: string;
  detail: string;
  href: string;
  score: number;
};
// Endpoint return type: HeroAlert | null
```

## Required source fields

| Source | Fields | Guardrail |
| --- | --- | --- |
| Market movement | canonical event ID, subject ID, previous/current value, measured change, detected time | Constrain records to a recent lookback window. |
| Scheduled event | canonical event ID, local date, start time, title, venue, event number | Validate local time and exclude stale events. |
| Navigation | canonical event ID and application route | Build the route from the canonical ID or validated event tuple. |

## Priority example

Use a higher score for a recent significant market movement than for a notable upcoming event. The exact thresholds should reflect the application’s data quality and be covered by unit tests. Do not use text labels such as `insider` as a factual claim.

## Client query behavior

Use a short polling interval only while the page is visible. The component must render nothing for `null`; it should never show a placeholder alert simply to fill space.
