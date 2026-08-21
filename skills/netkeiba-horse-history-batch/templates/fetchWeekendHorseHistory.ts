/**
 * 今週末出走予定馬の全競走成績を自動補完するスケジュールジョブ（テンプレート）
 *
 * 処理フロー:
 * 1. race_entriesテーブルから今週末（土日）の出走予定馬名を取得
 * 2. horsesテーブルとJOINしてnetkeibaIdを持つ馬を特定
 * 3. horse_race_historyに既にレコードが少ない（または無い）馬を優先的に補完
 * 4. netkeibaから全競走成績を取得してDBに保存
 *
 * 実行タイミング例: 毎週木曜日 18:00 UTC (金曜 03:00 JST)
 */
import { Request, Response } from "express";
import { eq, and, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { horses, raceEntries, horseRaceHistory, scheduledJobs } from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { fetchHorseRaceHistoryFromNetkeiba } from "../netkeibaFetcher";

const JOB_NAME = "fetchWeekendHorseHistory";
const MAX_HORSES_PER_RUN = 20;
const TIMEOUT_MS = 100_000; // 100秒
const DELAY_BETWEEN_HORSES_MS = 2500;

function getThisWeekendDates(): string[] {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dayOfWeek = jstNow.getUTCDay();
  const daysUntilSaturday = (6 - dayOfWeek + 7) % 7 || 7;
  const saturday = new Date(jstNow);
  saturday.setUTCDate(saturday.getUTCDate() + daysUntilSaturday);
  const sunday = new Date(saturday);
  sunday.setUTCDate(sunday.getUTCDate() + 1);
  const format = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  return [format(saturday), format(sunday)];
}

export async function fetchWeekendHorseHistoryHandler(req: Request, res: Response) {
  const startTime = Date.now();
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) {
      return res.status(403).json({ error: "cron-only" });
    }

    console.log(`[${JOB_NAME}] スケジュールジョブ開始`);
    const db = await getDb();
    if (!db) return res.status(500).json({ error: "Database not available" });

    // 対象日付（payloadで上書き可能）
    const payload = req.body || {};
    let targetDates: string[];
    if (payload.dates && Array.isArray(payload.dates)) {
      targetDates = payload.dates;
    } else {
      targetDates = getThisWeekendDates();
    }

    // 1. 今週末の出走馬名を取得（重複排除）
    const entries = await db
      .select({ horseName: raceEntries.horseName })
      .from(raceEntries)
      .where(inArray(raceEntries.raceDate, targetDates));
    const uniqueHorseNames = Array.from(new Set(entries.map(e => e.horseName)));

    if (uniqueHorseNames.length === 0) {
      const result = { ok: true, message: "出走予定馬なし", targetDates, processed: 0, inserted: 0 };
      await updateJobStatus(db, result);
      return res.json(result);
    }

    // 2. netkeibaIdを持つ馬を特定
    const matchedHorses = await db
      .select({ id: horses.id, name: horses.name, netkeibaId: horses.netkeibaId })
      .from(horses)
      .where(inArray(horses.name, uniqueHorseNames));
    const horsesWithNetkeibaId = matchedHorses.filter(h => h.netkeibaId);

    if (horsesWithNetkeibaId.length === 0) {
      const result = { ok: true, message: "netkeibaId保有馬なし", targetDates, processed: 0, inserted: 0 };
      await updateJobStatus(db, result);
      return res.json(result);
    }

    // 3. レコード数が少ない馬を優先
    const horseHistoryCounts: { horseId: number; count: number }[] = [];
    for (const horse of horsesWithNetkeibaId) {
      const [countResult] = await db
        .select({ cnt: sql<number>`count(*)` })
        .from(horseRaceHistory)
        .where(eq(horseRaceHistory.horseId, horse.id));
      horseHistoryCounts.push({ horseId: horse.id, count: Number(countResult?.cnt ?? 0) });
    }
    horseHistoryCounts.sort((a, b) => a.count - b.count);
    const targetHorseIds = horseHistoryCounts.slice(0, MAX_HORSES_PER_RUN).map(h => h.horseId);
    const targetHorses = horsesWithNetkeibaId.filter(h => targetHorseIds.includes(h.id));

    // 4. netkeibaから取得してDB保存
    let totalProcessed = 0, totalInserted = 0, totalSkipped = 0, totalErrors = 0;

    for (const horse of targetHorses) {
      if (Date.now() - startTime > TIMEOUT_MS) break;
      try {
        const records = await fetchHorseRaceHistoryFromNetkeiba(horse.netkeibaId!);
        if (records.length === 0) { totalProcessed++; continue; }

        const existing = await db
          .select({ raceDate: horseRaceHistory.raceDate, venue: horseRaceHistory.venue, raceName: horseRaceHistory.raceName })
          .from(horseRaceHistory)
          .where(eq(horseRaceHistory.horseId, horse.id));
        const existingKeys = new Set(existing.map(r => `${r.raceDate}-${r.venue}-${r.raceName}`));

        for (const record of records) {
          const key = `${record.raceDate}-${record.venue}-${record.raceName}`;
          if (existingKeys.has(key)) { totalSkipped++; continue; }
          await db.insert(horseRaceHistory).values({
            horseName: horse.name,
            horseId: horse.id,
            raceDate: record.raceDate,
            venue: record.venue,
            raceName: record.raceName,
            raceId: record.raceId || null,
            distance: record.distance || null,
            surface: record.surface || null,
            trackCondition: record.trackCondition || null,
            finishPosition: record.finishPosition || null,
            horseCount: record.horseCount || null,
            finishTime: record.finishTime || null,
            last3f: record.last3f || null,
            odds: record.odds || null,
            popularity: record.popularity || null,
            jockey: record.jockey || null,
            weight: record.weight || null,
            horseWeight: record.horseWeight || null,
            margin: record.margin || null,
            bracketNumber: record.bracketNumber || null,
            horseNumber: record.horseNumber || null,
            cornerPositions: record.cornerPositions || null,
            weather: record.weather || null,
            prizeMoney: record.prizeMoney || null,
            horseWeightDiff: record.horseWeightDiff || null,
            timeDifference: record.timeDifference || null,
          });
          totalInserted++;
        }
        totalProcessed++;
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_HORSES_MS));
      } catch (e) {
        totalErrors++;
        totalProcessed++;
        console.error(`[${JOB_NAME}] ${horse.name} エラー:`, e);
      }
    }

    const result = {
      ok: true, targetDates,
      totalWeekendHorses: uniqueHorseNames.length,
      withNetkeibaId: horsesWithNetkeibaId.length,
      processed: totalProcessed, inserted: totalInserted,
      skipped: totalSkipped, errors: totalErrors,
      elapsedMs: Date.now() - startTime,
    };
    await updateJobStatus(db, result);
    return res.json(result);
  } catch (error) {
    console.error(`[${JOB_NAME}] エラー:`, error);
    return res.status(500).json({
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startTime,
    });
  }
}

async function updateJobStatus(db: any, result: Record<string, any>) {
  try {
    await db.update(scheduledJobs).set({
      lastRunAt: new Date(),
      lastRunResult: JSON.stringify(result),
    }).where(eq(scheduledJobs.name, JOB_NAME));
  } catch (e) {
    console.warn(`[${JOB_NAME}] ジョブステータス更新失敗:`, e);
  }
}
