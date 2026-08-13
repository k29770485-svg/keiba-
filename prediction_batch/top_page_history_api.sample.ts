/*
 * Keiba De GO: 過去予想履歴・確定結果・発走前予想を明確に返すREST APIサンプル。
 * 想定依存: express, mysql2/promise
 */

import { Router, type Request, type Response } from "express";
import type { Pool, RowDataPacket } from "mysql2/promise";

const DEFAULT_ALGORITHM_VERSION = "sql-v2";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;
const REFRESH_AFTER_SECONDS = 60;

type DisplayState =
  | "prediction_ready"
  | "result_pending"
  | "hit_settled"
  | "miss_settled"
  | "no_bet_settled";

type FreshnessRow = RowDataPacket & {
  server_time_utc: string;
  latest_prediction_generated_at: string | null;
  latest_ticket_settled_at: string | null;
  latest_daily_aggregated_at: string | null;
};

type RaceBoardRow = RowDataPacket & {
  race_id: string;
  race_date: string;
  venue_name: string;
  race_number: number;
  race_name: string | null;
  scheduled_start_at: string;
  prediction_generated_at: string;
  settlement_completed_at?: string | null;
  total_stake_yen: number | string;
  total_return_yen?: number | string;
  total_net_yen?: number | string;
  ticket_count?: number | string;
  recommended_ticket_count?: number | string;
  settled_ticket_count?: number | string;
  pending_ticket_count?: number | string;
  hit_ticket_count?: number | string;
  recovery_rate_pct?: number | string;
  display_state: DisplayState;
  display_label: string;
  display_note: string;
};

const FRESHNESS_SQL = `
  SELECT
    UTC_TIMESTAMP() AS server_time_utc,
    (SELECT MAX(generated_at) FROM sql_prediction_runs WHERE algorithm_version = ?) AS latest_prediction_generated_at,
    (
      SELECT MAX(spt.settled_at)
      FROM sql_prediction_tickets AS spt
      INNER JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
      WHERE spr.algorithm_version = ? AND spt.settlement_status = 'settled'
    ) AS latest_ticket_settled_at,
    (
      SELECT MAX(updated_at)
      FROM prediction_performance_daily
      WHERE algorithm_version = ?
    ) AS latest_daily_aggregated_at
`;

const UPCOMING_SQL = `
  SELECT
    r.race_id, r.race_date, r.venue_name, r.race_number, r.race_name,
    r.scheduled_start_at, spr.generated_at AS prediction_generated_at,
    spr.total_stake_yen, spr.ticket_count,
    'prediction_ready' AS display_state,
    '発走前・予想確定' AS display_label,
    '確定結果・回収率は発走後の払戻確定まで表示しません' AS display_note
  FROM sql_prediction_runs AS spr
  INNER JOIN races AS r ON r.race_id = spr.race_id
  WHERE spr.algorithm_version = ?
    AND spr.status = 'generated'
    AND r.race_status = 'scheduled'
    AND r.scheduled_start_at > UTC_TIMESTAMP()
  ORDER BY r.scheduled_start_at ASC
  LIMIT ?
`;

const RESULT_PENDING_SQL = `
  SELECT
    r.race_id, r.race_date, r.venue_name, r.race_number, r.race_name,
    r.scheduled_start_at, spr.generated_at AS prediction_generated_at,
    spr.total_stake_yen, spr.ticket_count,
    COUNT(spt.ticket_id) AS settled_ticket_count,
    SUM(CASE WHEN spt.settlement_status = 'pending' THEN 1 ELSE 0 END) AS pending_ticket_count,
    'result_pending' AS display_state,
    '結果待ち・払戻未確定' AS display_label,
    '払戻データの確定後に収支と回収率へ反映します' AS display_note
  FROM sql_prediction_runs AS spr
  INNER JOIN races AS r ON r.race_id = spr.race_id
  LEFT JOIN sql_prediction_tickets AS spt ON spt.prediction_id = spr.prediction_id
  WHERE spr.algorithm_version = ?
    AND r.race_status = 'finished'
    AND spr.status = 'generated'
  GROUP BY
    r.race_id, r.race_date, r.venue_name, r.race_number, r.race_name,
    r.scheduled_start_at, spr.prediction_id, spr.generated_at,
    spr.total_stake_yen, spr.ticket_count
  ORDER BY r.scheduled_start_at DESC
  LIMIT ?
`;

const SETTLED_HISTORY_SQL = `
  SELECT
    r.race_id, r.race_date, r.venue_name, r.race_number, r.race_name,
    r.scheduled_start_at, spr.generated_at AS prediction_generated_at,
    MAX(spt.settled_at) AS settlement_completed_at,
    spr.ticket_count AS recommended_ticket_count,
    COALESCE(SUM(spt.stake_yen), 0) AS total_stake_yen,
    COALESCE(SUM(spt.return_yen), 0) AS total_return_yen,
    COALESCE(SUM(spt.net_yen), 0) AS total_net_yen,
    COALESCE(SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END), 0) AS hit_ticket_count,
    COUNT(spt.ticket_id) AS settled_ticket_count,
    COALESCE(ROUND(SUM(spt.return_yen) / NULLIF(SUM(spt.stake_yen), 0) * 100, 2), 0) AS recovery_rate_pct,
    CASE
      WHEN spr.ticket_count = 0 THEN 'no_bet_settled'
      WHEN SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) > 0 THEN 'hit_settled'
      ELSE 'miss_settled'
    END AS display_state,
    CASE
      WHEN spr.ticket_count = 0 THEN '見送り・結果確定'
      WHEN SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) > 0 THEN '的中・結果確定'
      ELSE '不的中・結果確定'
    END AS display_label,
    CASE
      WHEN spr.ticket_count = 0 THEN '購入推奨なしのため、投資額・払戻額は0円です'
      ELSE '投資額・払戻額・収支・回収率は確定払戻に基づく実績です'
    END AS display_note
  FROM sql_prediction_runs AS spr
  INNER JOIN races AS r ON r.race_id = spr.race_id
  LEFT JOIN sql_prediction_tickets AS spt
    ON spt.prediction_id = spr.prediction_id
   AND spt.settlement_status = 'settled'
  WHERE spr.algorithm_version = ?
    AND r.race_status = 'finished'
    AND spr.status = 'settled'
  GROUP BY
    r.race_id, r.race_date, r.venue_name, r.race_number, r.race_name,
    r.scheduled_start_at, spr.prediction_id, spr.generated_at, spr.ticket_count
  ORDER BY r.scheduled_start_at DESC
  LIMIT ?
`;

function readAlgorithmVersion(request: Request): string {
  const value = String(request.query.algorithmVersion ?? DEFAULT_ALGORITHM_VERSION);
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : DEFAULT_ALGORITHM_VERSION;
}

function readLimit(request: Request): number {
  const value = Number.parseInt(String(request.query.limit ?? DEFAULT_LIMIT), 10);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}

function asFiniteNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function serializeRace(row: RaceBoardRow) {
  return {
    raceId: row.race_id,
    raceDate: row.race_date,
    venueName: row.venue_name,
    raceNumber: row.race_number,
    raceName: row.race_name,
    scheduledStartAt: row.scheduled_start_at,
    predictionGeneratedAt: row.prediction_generated_at,
    settlementCompletedAt: row.settlement_completed_at ?? null,
    displayState: row.display_state,
    displayLabel: row.display_label,
    displayNote: row.display_note,
    recommendedTicketCount: asFiniteNumber(row.recommended_ticket_count ?? row.ticket_count),
    settledTicketCount: asFiniteNumber(row.settled_ticket_count),
    pendingTicketCount: asFiniteNumber(row.pending_ticket_count),
    hitTicketCount: asFiniteNumber(row.hit_ticket_count),
    totalStakeYen: asFiniteNumber(row.total_stake_yen),
    totalReturnYen: asFiniteNumber(row.total_return_yen),
    totalNetYen: asFiniteNumber(row.total_net_yen),
    recoveryRatePct: asFiniteNumber(row.recovery_rate_pct),
  };
}

/**
 * 画面は sections のキーと displayLabel を表示し、結果待ちを不的中へ変換しない。
 * `app.use(createPredictionHistoryApiRouter(mysqlPool));` で既存アプリへ登録する。
 */
export function createPredictionHistoryApiRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/top-page/prediction-history-board?algorithmVersion=sql-v2&limit=8
  router.get("/api/top-page/prediction-history-board", async (request: Request, response: Response) => {
    const algorithmVersion = readAlgorithmVersion(request);
    const limit = readLimit(request);

    try {
      const [freshnessResult, upcomingResult, pendingResult, historyResult] = await Promise.all([
        pool.execute<FreshnessRow[]>(FRESHNESS_SQL, [algorithmVersion, algorithmVersion, algorithmVersion]),
        pool.execute<RaceBoardRow[]>(UPCOMING_SQL, [algorithmVersion, limit]),
        pool.execute<RaceBoardRow[]>(RESULT_PENDING_SQL, [algorithmVersion, limit]),
        pool.execute<RaceBoardRow[]>(SETTLED_HISTORY_SQL, [algorithmVersion, limit]),
      ]);

      const freshness = freshnessResult[0][0];
      response.json({
        algorithmVersion,
        refreshAfterSeconds: REFRESH_AFTER_SECONDS,
        freshness: {
          serverTimeUtc: freshness?.server_time_utc ?? null,
          latestPredictionGeneratedAt: freshness?.latest_prediction_generated_at ?? null,
          latestTicketSettledAt: freshness?.latest_ticket_settled_at ?? null,
          latestDailyAggregatedAt: freshness?.latest_daily_aggregated_at ?? null,
        },
        sections: {
          upcoming: {
            title: "これからの予想",
            state: "prediction_ready",
            description: "発走前に保存された予想です。結果・回収率は含みません。",
            items: upcomingResult[0].map(serializeRace),
          },
          resultPending: {
            title: "結果待ち",
            state: "result_pending",
            description: "レース終了後、払戻または精算が未確定の予想です。不的中ではありません。",
            items: pendingResult[0].map(serializeRace),
          },
          settledHistory: {
            title: "過去予想履歴・確定結果",
            state: "settled_history",
            description: "確定払戻に基づく投資額・払戻額・収支・回収率です。",
            items: historyResult[0].map(serializeRace),
          },
        },
      });
    } catch (error) {
      console.error("予想履歴ボードの取得に失敗しました", error);
      response.status(500).json({ error: "prediction_history_board_unavailable" });
    }
  });

  return router;
}
