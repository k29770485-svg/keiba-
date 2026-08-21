# 必要なDBスキーマ

## horse_race_history テーブル

全競走成績を格納するテーブル。1レコード = 1馬 × 1レース。

```sql
CREATE TABLE horse_race_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  horse_name VARCHAR(64) NOT NULL,
  horse_id INT,                    -- horsesテーブルへのFK
  race_date VARCHAR(16),           -- "YYYY/MM/DD"
  venue VARCHAR(64),               -- 競馬場名
  race_name VARCHAR(128),
  race_id VARCHAR(32),             -- netkeibaのレースID
  distance VARCHAR(16),            -- "1600" 等
  surface VARCHAR(16),             -- "芝"/"ダ"/"障害"
  track_condition VARCHAR(16),     -- "良"/"稍重"/"重"/"不良"
  finish_position VARCHAR(16),     -- "1"〜"18" or "中止"等
  horse_count INT,
  finish_time VARCHAR(16),         -- "1:34.5"
  last_3f VARCHAR(16),             -- "33.8"
  odds VARCHAR(16),
  popularity INT,
  jockey VARCHAR(64),
  weight VARCHAR(8),               -- 斤量 "56.0"
  horse_weight VARCHAR(16),        -- "480"
  margin VARCHAR(32),              -- 着差
  bracket_number INT,              -- 枠番
  horse_number INT,                -- 馬番
  corner_positions VARCHAR(32),    -- "3-3-2-1"
  weather VARCHAR(16),             -- "晴"/"曇"/"雨"
  prize_money VARCHAR(32),         -- 賞金（万円）
  horse_weight_diff VARCHAR(8),    -- "+4"/"-2"/"0"
  time_difference VARCHAR(16),     -- タイム差
  organizer ENUM('JRA','NAR') DEFAULT 'JRA',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## horses テーブル（関連カラムのみ）

```sql
-- 既存テーブルに必要なカラム:
ALTER TABLE horses ADD COLUMN netkeiba_id VARCHAR(32);  -- netkeibaの馬ID
ALTER TABLE horses ADD COLUMN image_url TEXT;           -- 馬写真URL
```

## scheduled_jobs テーブル

```sql
CREATE TABLE scheduled_jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  schedule_cron_task_uid VARCHAR(65),  -- Heartbeat task_uid
  last_run_at TIMESTAMP,
  last_run_result TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## race_entries テーブル（参照用）

出走予定馬を格納。`raceDate` + `horseName` で今週末の出走馬を特定。

```sql
-- 必須カラム:
-- raceDate VARCHAR(16)   -- "YYYY-MM-DD"
-- horseName VARCHAR(64)
-- venue VARCHAR(64)
-- raceNumber INT
```
