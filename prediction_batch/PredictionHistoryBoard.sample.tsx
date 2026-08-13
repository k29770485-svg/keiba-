import { useEffect, useState } from "react";

type DisplayState =
  | "prediction_ready"
  | "result_pending"
  | "hit_settled"
  | "miss_settled"
  | "no_bet_settled";

type RaceBoardItem = {
  raceId: string;
  raceDate: string;
  venueName: string;
  raceNumber: number;
  raceName: string | null;
  scheduledStartAt: string;
  predictionGeneratedAt: string;
  settlementCompletedAt: string | null;
  displayState: DisplayState;
  displayLabel: string;
  displayNote: string;
  recommendedTicketCount: number;
  settledTicketCount: number;
  pendingTicketCount: number;
  hitTicketCount: number;
  totalStakeYen: number;
  totalReturnYen: number;
  totalNetYen: number;
  recoveryRatePct: number;
};

type PredictionHistoryBoardData = {
  algorithmVersion: string;
  refreshAfterSeconds: number;
  freshness: {
    serverTimeUtc: string | null;
    latestPredictionGeneratedAt: string | null;
    latestTicketSettledAt: string | null;
    latestDailyAggregatedAt: string | null;
  };
  sections: {
    upcoming: { title: string; description: string; items: RaceBoardItem[] };
    resultPending: { title: string; description: string; items: RaceBoardItem[] };
    settledHistory: { title: string; description: string; items: RaceBoardItem[] };
  };
};

const stateClass: Record<DisplayState, string> = {
  prediction_ready: "bg-blue-100 text-blue-800",
  result_pending: "bg-amber-100 text-amber-900",
  hit_settled: "bg-emerald-100 text-emerald-900",
  miss_settled: "bg-rose-100 text-rose-900",
  no_bet_settled: "bg-slate-100 text-slate-800",
};

function formatDateTime(value: string | null): string {
  if (!value) return "未更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未更新";
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatYen(value: number): string {
  return `${new Intl.NumberFormat("ja-JP").format(value)}円`;
}

function raceTitle(item: RaceBoardItem): string {
  const name = item.raceName ? ` ${item.raceName}` : "";
  return `${item.raceDate} ${item.venueName}${name} ${item.raceNumber}R`;
}

function StatusBadge({ item }: { item: RaceBoardItem }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${stateClass[item.displayState]}`}>
      {item.displayLabel}
    </span>
  );
}

function EmptyRow({ columns, message }: { columns: number; message: string }) {
  return (
    <tr>
      <td colSpan={columns} className="px-4 py-6 text-center text-sm text-slate-500">
        {message}
      </td>
    </tr>
  );
}

function UpcomingTable({ items }: { items: RaceBoardItem[] }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="bg-slate-50 text-xs text-slate-600">
        <tr>
          <th className="px-4 py-3">レース</th>
          <th className="px-4 py-3">発走予定</th>
          <th className="px-4 py-3">状態</th>
          <th className="px-4 py-3 text-right">推奨点数</th>
          <th className="px-4 py-3">予想更新</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {items.length === 0 ? <EmptyRow columns={5} message="発走前・予想確定のレースはありません。" /> : items.map((item) => (
          <tr key={item.raceId}>
            <td className="px-4 py-3 font-medium text-slate-900">{raceTitle(item)}</td>
            <td className="px-4 py-3">{formatDateTime(item.scheduledStartAt)}</td>
            <td className="px-4 py-3"><StatusBadge item={item} /></td>
            <td className="px-4 py-3 text-right">{item.recommendedTicketCount}点</td>
            <td className="px-4 py-3 text-slate-600">{formatDateTime(item.predictionGeneratedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PendingTable({ items }: { items: RaceBoardItem[] }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="bg-slate-50 text-xs text-slate-600">
        <tr>
          <th className="px-4 py-3">レース</th>
          <th className="px-4 py-3">状態</th>
          <th className="px-4 py-3 text-right">結果待ち点数</th>
          <th className="px-4 py-3">案内</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {items.length === 0 ? <EmptyRow columns={4} message="払戻・精算待ちのレースはありません。" /> : items.map((item) => (
          <tr key={item.raceId}>
            <td className="px-4 py-3 font-medium text-slate-900">{raceTitle(item)}</td>
            <td className="px-4 py-3"><StatusBadge item={item} /></td>
            <td className="px-4 py-3 text-right">{item.pendingTicketCount}点</td>
            <td className="px-4 py-3 text-slate-600">{item.displayNote}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryTable({ items }: { items: RaceBoardItem[] }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="bg-slate-50 text-xs text-slate-600">
        <tr>
          <th className="px-4 py-3">レース</th>
          <th className="px-4 py-3">確定状態</th>
          <th className="px-4 py-3 text-right">投資額</th>
          <th className="px-4 py-3 text-right">払戻額</th>
          <th className="px-4 py-3 text-right">収支</th>
          <th className="px-4 py-3 text-right">回収率</th>
          <th className="px-4 py-3">精算完了</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {items.length === 0 ? <EmptyRow columns={7} message="確定済みの過去予想履歴はありません。" /> : items.map((item) => (
          <tr key={item.raceId}>
            <td className="px-4 py-3 font-medium text-slate-900">{raceTitle(item)}</td>
            <td className="px-4 py-3"><StatusBadge item={item} /></td>
            <td className="px-4 py-3 text-right tabular-nums">{formatYen(item.totalStakeYen)}</td>
            <td className="px-4 py-3 text-right tabular-nums">{formatYen(item.totalReturnYen)}</td>
            <td className={`px-4 py-3 text-right tabular-nums ${item.totalNetYen > 0 ? "text-emerald-700" : item.totalNetYen < 0 ? "text-rose-700" : "text-slate-700"}`}>
              {formatYen(item.totalNetYen)}
            </td>
            <td className="px-4 py-3 text-right tabular-nums">{item.recoveryRatePct.toFixed(2)}%</td>
            <td className="px-4 py-3 text-slate-600">{formatDateTime(item.settlementCompletedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function usePredictionHistoryBoard(endpoint: string) {
  const [data, setData] = useState<PredictionHistoryBoardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) throw new Error("履歴データを取得できませんでした。");
        const next = (await response.json()) as PredictionHistoryBoardData;
        if (disposed) return;
        setData(next);
        setError(null);
        timer = window.setTimeout(load, Math.max(15, next.refreshAfterSeconds) * 1000);
      } catch (loadError) {
        if (disposed) return;
        setError(loadError instanceof Error ? loadError.message : "履歴データを取得できませんでした。");
        timer = window.setTimeout(load, 60_000);
      }
    };

    void load();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [endpoint]);

  return { data, error };
}

/**
 * トップページに配置する表示例。
 * `endpoint` は `/api/top-page/prediction-history-board?algorithmVersion=sql-v2` を指定する。
 */
export function PredictionHistoryBoard({ endpoint }: { endpoint: string }) {
  const { data, error } = usePredictionHistoryBoard(endpoint);

  if (!data) {
    return <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">予想履歴を読み込んでいます。</section>;
  }

  return (
    <section className="space-y-6" aria-live="polite">
      <header className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-bold text-slate-900">予想・結果・履歴</h2>
        <p className="mt-1 text-sm text-slate-600">
          予測、結果待ち、確定結果を分離して表示しています。自動更新は{data.refreshAfterSeconds}秒ごとです。
        </p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-slate-500">予想データ最終更新</dt><dd className="font-medium">{formatDateTime(data.freshness.latestPredictionGeneratedAt)}</dd></div>
          <div><dt className="text-slate-500">精算データ最終更新</dt><dd className="font-medium">{formatDateTime(data.freshness.latestTicketSettledAt)}</dd></div>
          <div><dt className="text-slate-500">日次集計最終更新</dt><dd className="font-medium">{formatDateTime(data.freshness.latestDailyAggregatedAt)}</dd></div>
        </dl>
        {error ? <p className="mt-3 text-sm text-rose-700">{error} 前回取得分を表示しています。</p> : null}
      </header>

      <section className="overflow-hidden rounded-xl border border-blue-200 bg-white">
        <div className="border-b border-blue-100 bg-blue-50 px-5 py-4"><h3 className="font-bold text-blue-950">{data.sections.upcoming.title}</h3><p className="mt-1 text-sm text-blue-800">{data.sections.upcoming.description}</p></div>
        <div className="overflow-x-auto"><UpcomingTable items={data.sections.upcoming.items} /></div>
      </section>

      <section className="overflow-hidden rounded-xl border border-amber-200 bg-white">
        <div className="border-b border-amber-100 bg-amber-50 px-5 py-4"><h3 className="font-bold text-amber-950">{data.sections.resultPending.title}</h3><p className="mt-1 text-sm text-amber-800">{data.sections.resultPending.description}</p></div>
        <div className="overflow-x-auto"><PendingTable items={data.sections.resultPending.items} /></div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 bg-slate-50 px-5 py-4"><h3 className="font-bold text-slate-950">{data.sections.settledHistory.title}</h3><p className="mt-1 text-sm text-slate-700">{data.sections.settledHistory.description}</p></div>
        <div className="overflow-x-auto"><HistoryTable items={data.sections.settledHistory.items} /></div>
      </section>
    </section>
  );
}
