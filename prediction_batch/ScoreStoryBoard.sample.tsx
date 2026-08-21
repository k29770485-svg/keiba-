import { useCallback, useEffect, useRef, useState } from "react";

type FactorDirection = "positive" | "caution";
type DataQuality = "high" | "medium" | "low";

type StoryFactor = {
  key: string;
  label: string;
  description: string;
  contribution: number;
  direction: FactorDirection;
};

type ScoreNarrative = {
  headline: string;
  positiveFactors: StoryFactor[];
  cautionFactors: StoryFactor[];
  dataQuality: DataQuality;
};

type StoryCandidate = {
  rank: number;
  horseNumber: number;
  horseName: string;
  jockeyName: string | null;
  rating: string;
  score: number;
  winProbabilityPct: number | null;
  narrative: ScoreNarrative;
};

type StoryTicket = {
  ticketType: "wide" | "trio" | "trifecta";
  selection: number[];
  label: string;
  reason: string;
};

type ScoreStoryRace = {
  raceId: string;
  venueName: string;
  raceNumber: number;
  raceName: string | null;
  scheduledStartAt: string;
  surface: string | null;
  distanceM: number | null;
  trackCondition: string | null;
  weather: string | null;
  generatedAt: string;
  decisionStatus: "preview" | "no_bet";
  decisionNote: string;
  candidates: StoryCandidate[];
  storyTickets: StoryTicket[];
};

type ScoreStoryData = {
  predictionMode: "score_story";
  algorithmVersion: string;
  refreshAfterSeconds: number;
  freshness: {
    serverTimeUtc: string | null;
    latestPredictionGeneratedAt: string | null;
  };
  races: ScoreStoryRace[];
};

const qualityStyle: Record<DataQuality, { label: string; className: string }> = {
  high: { label: "データ充足", className: "bg-emerald-100 text-emerald-900" },
  medium: { label: "一部注意", className: "bg-amber-100 text-amber-900" },
  low: { label: "データ注意", className: "bg-rose-100 text-rose-900" },
};

const ticketTypeLabel: Record<StoryTicket["ticketType"], string> = {
  wide: "ワイド",
  trio: "3連複",
  trifecta: "3連単",
};

function formatDateTime(value: string | null): string {
  if (!value) return "未更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未更新";
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function raceTitle(race: ScoreStoryRace): string {
  return `${race.venueName} ${race.raceNumber}R${race.raceName ? `・${race.raceName}` : ""}`;
}

function courseLabel(race: ScoreStoryRace): string {
  const parts = [race.surface, race.distanceM ? `${race.distanceM}m` : null, race.trackCondition, race.weather].filter(Boolean);
  return parts.length ? parts.join(" / ") : "コース情報を確認中";
}

function FactorCard({ factor }: { factor: StoryFactor }) {
  const isPositive = factor.direction === "positive";
  return (
    <li className={`rounded-lg border p-3 ${isPositive ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs font-bold ${isPositive ? "text-emerald-800" : "text-amber-900"}`}>
          {isPositive ? "追い風" : "注意"}・{factor.label}
        </span>
        <span className={`text-xs font-semibold tabular-nums ${isPositive ? "text-emerald-700" : "text-amber-800"}`}>
          {factor.contribution >= 0 ? "+" : ""}{factor.contribution.toFixed(1)}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-700">{factor.description}</p>
    </li>
  );
}

function CandidateCard({ candidate }: { candidate: StoryCandidate }) {
  const quality = qualityStyle[candidate.narrative.dataQuality];
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold tracking-wide text-indigo-700">{candidate.rating} SCORE {candidate.rank}</p>
          <h4 className="mt-1 text-lg font-bold text-slate-950">{candidate.horseNumber}. {candidate.horseName}</h4>
          <p className="mt-1 text-xs text-slate-600">騎手: {candidate.jockeyName ?? "情報なし"} ・ AIスコア {candidate.score.toFixed(1)}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${quality.className}`}>{quality.label}</span>
      </div>

      <p className="mt-4 rounded-lg bg-indigo-50 px-3 py-2 text-sm font-medium leading-6 text-indigo-950">{candidate.narrative.headline}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-bold text-emerald-800">AIが注目した理由</p>
          <ul className="space-y-2">
            {candidate.narrative.positiveFactors.length ? candidate.narrative.positiveFactors.map((factor) => <FactorCard key={factor.key} factor={factor} />) : <li className="text-xs text-slate-500">特に強い追い風は検出されませんでした。</li>}
          </ul>
        </div>
        <div>
          <p className="mb-2 text-xs font-bold text-amber-900">レース前に確認したい点</p>
          <ul className="space-y-2">
            {candidate.narrative.cautionFactors.length ? candidate.narrative.cautionFactors.map((factor) => <FactorCard key={factor.key} factor={factor} />) : <li className="text-xs text-slate-500">大きな注意要因は検出されませんでした。</li>}
          </ul>
        </div>
      </div>
    </article>
  );
}

function StoryFormation({ ticket }: { ticket: StoryTicket }) {
  return (
    <li className="rounded-xl border border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 to-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-full bg-fuchsia-700 px-2.5 py-1 text-xs font-bold text-white">{ticketTypeLabel[ticket.ticketType]}</span>
        <span className="text-sm font-bold text-slate-950">{ticket.selection.map((number) => `#${number}`).join(" - ")}</span>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-700">{ticket.label}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">根拠: {ticket.reason}</p>
    </li>
  );
}

function useScoreStory(endpoint: string) {
  const [data, setData] = useState<ScoreStoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const latestData = useRef<ScoreStoryData | null>(null);

  const retry = useCallback(() => setRetryNonce((value) => value + 1), []);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`score_storyを取得できませんでした（HTTP ${response.status}）。`);
        const next = (await response.json()) as ScoreStoryData;
        if (disposed) return;
        latestData.current = next;
        setData(next);
        timer = window.setTimeout(load, Math.max(15, next.refreshAfterSeconds) * 1000);
      } catch (loadError) {
        if (disposed || (loadError instanceof DOMException && loadError.name === "AbortError")) return;
        setError(loadError instanceof Error ? loadError.message : "score_storyを取得できませんでした。");
        setData(latestData.current);
        timer = window.setTimeout(load, 60_000);
      } finally {
        if (!disposed) setIsLoading(false);
      }
    };

    void load();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [endpoint, retryNonce]);

  return { data, error, retry, isInitialLoading: isLoading && data === null, isRefreshing: isLoading && data !== null };
}

/**
 * score_story専用の表示例。
 * endpoint例: /api/top-page/score-story?predictionMode=score_story&algorithmVersion=score-story-v1
 * 厳格EVモードの回収率や「買い」判定とは混在させない。
 */
export function ScoreStoryBoard({ endpoint }: { endpoint: string }) {
  const { data, error, retry, isInitialLoading, isRefreshing } = useScoreStory(endpoint);

  if (isInitialLoading) {
    return (
      <section className="rounded-2xl border border-indigo-100 bg-white p-6" aria-busy="true" aria-live="polite">
        <div className="flex items-center gap-3 text-sm font-semibold text-indigo-950">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-700" aria-hidden="true" />
          AIスコアの注目ポイントを組み立てています。
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-3" aria-hidden="true">
          <div className="h-60 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-60 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-60 animate-pulse rounded-xl bg-slate-100" />
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6" role="alert">
        <h2 className="text-lg font-bold text-rose-950">AIスコアを表示できません</h2>
        <p className="mt-2 text-sm text-rose-800">{error ?? "データを取得できませんでした。"}</p>
        <button type="button" onClick={retry} className="mt-4 rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-800">再試行</button>
      </section>
    );
  }

  return (
    <section className="space-y-6" aria-live="polite">
      <header className="overflow-hidden rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-950 via-indigo-900 to-fuchsia-900 p-6 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-indigo-200">SCORE STORY</p>
            <h2 className="mt-2 text-2xl font-bold">AIが見つけた、レースの見どころ</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-indigo-100">順位の背景にある血統・騎手・枠順・馬場・馬体重の寄与を表示します。これはエンタメ向けの注目フォーメーションであり、利益を保証するものではありません。</p>
          </div>
          <button type="button" onClick={retry} disabled={isRefreshing} className="rounded-md border border-indigo-300 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 disabled:opacity-60">
            {isRefreshing ? "更新中…" : "今すぐ更新"}
          </button>
        </div>
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-indigo-100">
          <span>予測更新: {formatDateTime(data.freshness.latestPredictionGeneratedAt)}</span>
          <span>自動更新: {data.refreshAfterSeconds}秒ごと</span>
          <span>モデル: {data.algorithmVersion}</span>
        </div>
        {isRefreshing ? <p className="mt-3 text-xs text-indigo-200" role="status">前回取得分を表示したまま最新データを取得しています。</p> : null}
        {error ? <p className="mt-3 rounded-md bg-amber-300/20 px-3 py-2 text-xs text-amber-50" role="alert">{error} 前回取得分を表示しています。</p> : null}
      </header>

      {data.races.length === 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <h3 className="font-bold text-slate-900">表示できる注目レースはありません</h3>
          <p className="mt-2 text-sm text-slate-600">出走表・馬場・オッズ情報が揃った後にscore_storyを表示します。</p>
        </section>
      ) : data.races.map((race) => (
        <article key={race.raceId} className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
          <header className="border-b border-slate-200 bg-white px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold text-slate-950">{raceTitle(race)}</h3>
                <p className="mt-1 text-sm text-slate-600">発走 {formatDateTime(race.scheduledStartAt)} ・ {courseLabel(race)}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${race.decisionStatus === "preview" ? "bg-indigo-100 text-indigo-900" : "bg-slate-200 text-slate-800"}`}>
                {race.decisionStatus === "preview" ? "注目フォーメーション" : "データ確定待ち"}
              </span>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-700">{race.decisionNote}</p>
          </header>

          <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <div className="mb-3 flex items-center justify-between"><h4 className="font-bold text-slate-950">AIの上位候補と根拠</h4><span className="text-xs text-slate-500">順位は相対スコアです</span></div>
              <div className="grid gap-4 lg:grid-cols-3">
                {race.candidates.slice(0, 3).map((candidate) => <CandidateCard key={candidate.horseNumber} candidate={candidate} />)}
              </div>
            </div>
            <aside className="rounded-xl border border-fuchsia-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-bold tracking-wide text-fuchsia-800">WEEKEND PICK</p>
              <h4 className="mt-1 text-lg font-bold text-slate-950">注目フォーメーション</h4>
              <p className="mt-1 text-xs leading-5 text-slate-600">ランキング上位と根拠の組合せを、見どころとして表示しています。</p>
              <ul className="mt-4 space-y-3">
                {race.storyTickets.length ? race.storyTickets.map((ticket) => <StoryFormation key={`${ticket.ticketType}-${ticket.selection.join("-")}`} ticket={ticket} />) : <li className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">データ確定後に注目フォーメーションを表示します。</li>}
              </ul>
            </aside>
          </div>
        </article>
      ))}
    </section>
  );
}
