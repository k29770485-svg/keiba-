/*
 * Keiba De GO トップページ向け REST API のサンプル。
 *
 * 想定依存: express, mysql2/promise
 * `pool` はアプリで共有している MySQL/MariaDB Pool を渡す。
 * ユーザー入力は必ず ? プレースホルダーでバインドし、文字列連結しない。
 */

import { Router, type Request, type Response } from "express";
import type { Pool, RowDataPacket } from "mysql2/promise";

const DEFAULT_ALGORITHM_VERSION = "sql-v2";
const MAX_RACE_LIMIT = 8;
const MAX_LONGSHOT_LIMIT = 12;
const MAX_TREND_DAYS = 365;

type JsonValue = Record<string, unknown> | unknown[] | null;

type OverallRow = RowDataPacket & {
  total_stake_yen: number | string;
  total_return_yen: number | string;
  total_net_yen: number | string;
  settled_ticket_count: number | string;
  hit_ticket_count: number | string;
  hit_rate_pct: number | string;
  recovery_rate_pct: number | string;
};

type TicketMetricRow = RowDataPacket & {
  ticket_type: "trifecta" | "trio" | "wide";
  settled_ticket_count: number | string;
  total_stake_yen: number | string;
  total_return_yen: number | string;
  total_net_yen: number | string;
  hit_ticket_count: number | string;
  hit_rate_pct: number | string;
  recovery_rate_pct: number | string;
};

type UpcomingRaceRow = RowDataPacket & {
  race_id: string;
  algorithm_version: string;
  race_date: string;
  venue_name: string;
  race_number: number;
  race_name: string | null;
  scheduled_start_at: string;
  generated_at: string;
  total_stake_yen: number | string;
  ticket_count: number | string;
  top_predictions_json: string | JsonValue;
};

type LongshotRow = RowDataPacket & {
  race_id: string;
  race_date: string;
  venue_name: string;
  race_number: number;
  race_name: string | null;
  scheduled_start_at: string;
  horse_number: number;
  horse_name: string;
  jockey_name: string | null;
  odds: number | string | null;
  popularity: number | null;
  score: number | string;
  rating: string;
  win_probability_pct: number | string;
  expected_value_pct: number | string | null;
  score_breakdown_json: string | JsonValue;
  missing_fields_json: string | JsonValue;
};

type TrendRow = RowDataPacket & {
  settled_date: string;
  total_stake_yen: number | string;
  total_return_yen: number | string;
  total_net_yen: number | string;
  settled_ticket_count: number | string;
  hit_ticket_count: number | string;
  recovery_rate_pct: number | string;
};

const OVERALL_METRICS_SQL = `
  SELECT
    COALESCE(SUM(total_stake_yen), 0) AS total_stake_yen,
    COALESCE(SUM(total_return_yen), 0) AS total_return_yen,
    COALESCE(SUM(total_net_yen), 0) AS total_net_yen,
    COALESCE(SUM(settled_ticket_count), 0) AS settled_ticket_count,
    COALESCE(SUM(hit_ticket_count), 0) AS hit_ticket_count,
    COALESCE(ROUND(SUM(hit_ticket_count) / NULLIF(SUM(settled_ticket_count), 0) * 100, 2), 0) AS hit_rate_pct,
    COALESCE(ROUND(SUM(total_return_yen) / NULLIF(SUM(total_stake_yen), 0) * 100, 2), 0) AS recovery_rate_pct
  FROM sql_prediction_performance_summary
  WHERE algorithm_version = ?
`;

const TICKET_METRICS_SQL = `
  SELECT
    ticket_type, settled_ticket_count, total_stake_yen, total_return_yen,
    total_net_yen, hit_ticket_count, hit_rate_pct, recovery_rate_pct
  FROM sql_prediction_performance_summary
  WHERE algorithm_version = ?
  ORDER BY FIELD(ticket_type, 'trifecta', 'trio', 'wide')
`;

const UPCOMING_PREDICTIONS_SQL = `
  WITH upcoming_runs AS (
    SELECT
      spr.prediction_id, spr.race_id, spr.algorithm_version, spr.generated_at,
      spr.total_stake_yen, spr.ticket_count, r.race_date, r.venue_name,
      r.race_number, r.race_name, r.scheduled_start_at
    FROM sql_prediction_runs AS spr
    INNER JOIN races AS r ON r.race_id = spr.race_id
    WHERE spr.algorithm_version = ?
      AND spr.status = 'generated'
      AND r.race_status = 'scheduled'
      AND r.scheduled_start_at > UTC_TIMESTAMP()
    ORDER BY r.scheduled_start_at ASC
    LIMIT ?
  )
  SELECT
    ur.race_id, ur.algorithm_version, ur.race_date, ur.venue_name,
    ur.race_number, ur.race_name, ur.scheduled_start_at, ur.generated_at,
    ur.total_stake_yen, ur.ticket_count,
    JSON_ARRAYAGG(
      JSON_OBJECT(
        'rankPosition', sps.rank_position,
        'horseNumber', sps.horse_number,
        'horseName', sps.horse_name,
        'jockeyName', sps.jockey_name,
        'odds', sps.odds,
        'popularity', sps.popularity,
        'score', sps.score,
        'rating', sps.rating,
        'winProbabilityPct', sps.win_probability_pct,
        'expectedValuePct', sps.expected_value_pct,
        'isLongshot', sps.is_longshot,
        'missingFields', sps.missing_fields_json
      )
    ) AS top_predictions_json
  FROM upcoming_runs AS ur
  INNER JOIN sql_prediction_scores AS sps ON sps.prediction_id = ur.prediction_id
  WHERE sps.rank_position <= 5
  GROUP BY
    ur.prediction_id, ur.race_id, ur.algorithm_version, ur.race_date,
    ur.venue_name, ur.race_number, ur.race_name, ur.scheduled_start_at,
    ur.generated_at, ur.total_stake_yen, ur.ticket_count
  ORDER BY ur.scheduled_start_at ASC
`;

const LONGSHOTS_SQL = `
  SELECT
    r.race_id, r.race_date, r.venue_name, r.race_number, r.race_name,
    r.scheduled_start_at, sps.horse_number, sps.horse_name, sps.jockey_name,
    sps.odds, sps.popularity, sps.score, sps.rating, sps.win_probability_pct,
    sps.expected_value_pct, sps.score_breakdown_json, sps.missing_fields_json
  FROM sql_prediction_runs AS spr
  INNER JOIN races AS r ON r.race_id = spr.race_id
  INNER JOIN sql_prediction_scores AS sps ON sps.prediction_id = spr.prediction_id
  WHERE spr.algorithm_version = ?
    AND spr.status = 'generated'
    AND r.race_status = 'scheduled'
    AND r.scheduled_start_at > UTC_TIMESTAMP()
    AND sps.is_longshot = TRUE
  ORDER BY sps.expected_value_pct DESC, sps.score DESC, r.scheduled_start_at ASC
  LIMIT ?
`;

const RECOVERY_TREND_SQL = `
  SELECT
    DATE(spt.settled_at) AS settled_date,
    SUM(spt.stake_yen) AS total_stake_yen,
    SUM(spt.return_yen) AS total_return_yen,
    SUM(spt.net_yen) AS total_net_yen,
    COUNT(*) AS settled_ticket_count,
    SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) AS hit_ticket_count,
    ROUND(SUM(spt.return_yen) / NULLIF(SUM(spt.stake_yen), 0) * 100, 2) AS recovery_rate_pct
  FROM sql_prediction_tickets AS spt
  INNER JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
  WHERE spr.algorithm_version = ?
    AND spt.settlement_status = 'settled'
    AND spt.settled_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
  GROUP BY DATE(spt.settled_at)
  ORDER BY settled_date ASC
`;

function asFiniteNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseStoredJson(value: string | JsonValue): JsonValue {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

function sortTopPredictions(value: string | JsonValue): JsonValue {
  const parsed = parseStoredJson(value);
  if (!Array.isArray(parsed)) return parsed;
  return [...parsed].sort((left, right) => {
    const leftRank = Number((left as Record<string, unknown>).rankPosition ?? Number.MAX_SAFE_INTEGER);
    const rightRank = Number((right as Record<string, unknown>).rankPosition ?? Number.MAX_SAFE_INTEGER);
    return leftRank - rightRank;
  });
}

function readAlgorithmVersion(request: Request): string {
  const value = String(request.query.algorithmVersion ?? DEFAULT_ALGORITHM_VERSION);
  // アルゴリズム名はSQLプレースホルダーに渡すが、URL契約も限定しておく。
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : DEFAULT_ALGORITHM_VERSION;
}

function readBoundedInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function serializeOverall(row: OverallRow | undefined) {
  return {
    totalStakeYen: asFiniteNumber(row?.total_stake_yen),
    totalReturnYen: asFiniteNumber(row?.total_return_yen),
    totalNetYen: asFiniteNumber(row?.total_net_yen),
    settledTicketCount: asFiniteNumber(row?.settled_ticket_count),
    hitTicketCount: asFiniteNumber(row?.hit_ticket_count),
    hitRatePct: asFiniteNumber(row?.hit_rate_pct),
    recoveryRatePct: asFiniteNumber(row?.recovery_rate_pct),
  };
}

/**
 * 既存のExpressアプリへ追加するルーター。
 * `app.use(createTopPageApiRouter(mysqlPool));` のように登録する。
 */
export function createTopPageApiRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/top-page/prediction-summary?algorithmVersion=sql-v2&raceLimit=4&longshotLimit=6
  router.get("/api/top-page/prediction-summary", async (request: Request, response: Response) => {
    const algorithmVersion = readAlgorithmVersion(request);
    const raceLimit = readBoundedInt(request.query.raceLimit, 4, MAX_RACE_LIMIT);
    const longshotLimit = readBoundedInt(request.query.longshotLimit, 6, MAX_LONGSHOT_LIMIT);

    try {
      const [overallResult, byTicketResult, upcomingResult, longshotResult] = await Promise.all([
        pool.execute<OverallRow[]>(OVERALL_METRICS_SQL, [algorithmVersion]),
        pool.execute<TicketMetricRow[]>(TICKET_METRICS_SQL, [algorithmVersion]),
        pool.execute<UpcomingRaceRow[]>(UPCOMING_PREDICTIONS_SQL, [algorithmVersion, raceLimit]),
        pool.execute<LongshotRow[]>(LONGSHOTS_SQL, [algorithmVersion, longshotLimit]),
      ]);

      const overallRows = overallResult[0];
      const ticketRows = byTicketResult[0];
      const upcomingRows = upcomingResult[0];
      const longshotRows = longshotResult[0];

      response.json({
        algorithmVersion,
        generatedAt: new Date().toISOString(),
        metrics: {
          overall: serializeOverall(overallRows[0]),
          byTicketType: ticketRows.map((row) => ({
            ticketType: row.ticket_type,
            ...serializeOverall(row),
          })),
        },
        upcomingRaces: upcomingRows.map((row) => ({
          raceId: row.race_id,
          raceDate: row.race_date,
          venueName: row.venue_name,
          raceNumber: row.race_number,
          raceName: row.race_name,
          scheduledStartAt: row.scheduled_start_at,
          predictionGeneratedAt: row.generated_at,
          totalStakeYen: asFiniteNumber(row.total_stake_yen),
          ticketCount: asFiniteNumber(row.ticket_count),
          topPredictions: sortTopPredictions(row.top_predictions_json),
        })),
        longshots: longshotRows.map((row) => ({
          raceId: row.race_id,
          raceDate: row.race_date,
          venueName: row.venue_name,
          raceNumber: row.race_number,
          raceName: row.race_name,
          scheduledStartAt: row.scheduled_start_at,
          horseNumber: row.horse_number,
          horseName: row.horse_name,
          jockeyName: row.jockey_name,
          odds: row.odds === null ? null : asFiniteNumber(row.odds),
          popularity: row.popularity,
          score: asFiniteNumber(row.score),
          rating: row.rating,
          winProbabilityPct: asFiniteNumber(row.win_probability_pct),
          expectedValuePct: row.expected_value_pct === null ? null : asFiniteNumber(row.expected_value_pct),
          scoreBreakdown: parseStoredJson(row.score_breakdown_json),
          missingFields: parseStoredJson(row.missing_fields_json),
        })),
      });
    } catch (error) {
      console.error("トップページ予測サマリーの取得に失敗しました", error);
      response.status(500).json({ error: "prediction_summary_unavailable" });
    }
  });

  // GET /api/top-page/recovery-trend?algorithmVersion=sql-v2&days=90
  router.get("/api/top-page/recovery-trend", async (request: Request, response: Response) => {
    const algorithmVersion = readAlgorithmVersion(request);
    const days = readBoundedInt(request.query.days, 90, MAX_TREND_DAYS);

    try {
      const [rows] = await pool.execute<TrendRow[]>(RECOVERY_TREND_SQL, [algorithmVersion, days]);
      response.json({
        algorithmVersion,
        days,
        points: rows.map((row) => ({
          settledDate: row.settled_date,
          totalStakeYen: asFiniteNumber(row.total_stake_yen),
          totalReturnYen: asFiniteNumber(row.total_return_yen),
          totalNetYen: asFiniteNumber(row.total_net_yen),
          settledTicketCount: asFiniteNumber(row.settled_ticket_count),
          hitTicketCount: asFiniteNumber(row.hit_ticket_count),
          recoveryRatePct: asFiniteNumber(row.recovery_rate_pct),
        })),
      });
    } catch (error) {
      console.error("回収率推移の取得に失敗しました", error);
      response.status(500).json({ error: "recovery_trend_unavailable" });
    }
  });

  return router;
}
