# 競馬プロジェクト・成果物・スキル集

このリポジトリは、競馬予想アプリケーションの**予想生成・SQL蓄積・精算・表示連携**に加え、再利用可能な競馬関連スキルを一元管理します。Python バッチ、MySQL/MariaDB スキーマ、テスト、Web API／React UI の統合サンプル、設計・検証資料、およびスキルの実装資産を同じ履歴で追跡します。

> 予想は不確実性を伴う分析結果であり、的中・収益を保証しません。実データは、利用許諾のある公式 API または契約済みフィードだけから取得してください。

## ディレクトリ構成

```text
.
├── prediction_batch/   # 予想バッチ実装・SQL・設計資料・API/UIサンプル
├── test_artifacts/     # 検証成果物
└── skills/             # 再利用可能な Manus スキル
    └── <skill-name>/
        ├── SKILL.md    # 必須: スキルの実行手順と制約
        ├── scripts/    # 任意: 実行用スクリプト
        ├── references/ # 任意: スキーマ・運用資料
        └── templates/  # 任意: 実装・出力テンプレート
```

## 成果物の構成

| パス | 種別 | 内容 |
| --- | --- | --- |
| [`prediction_batch/`](prediction_batch/) | 実装 | Python 3.10+ の定期予想バッチ、決定論的 SQL 予想パイプライン、日次精算集計 |
| [`prediction_batch/schema.sql`](prediction_batch/schema.sql) | DB | レース、予想、発走前スナップショット、買い目、払戻、日次集計の MySQL/MariaDB DDL |
| [`prediction_batch/tests/`](prediction_batch/tests/) | テスト | バッチ、設定、SQL 予想、日次集計、複数レース条件のフィクスチャ検証 |
| [`prediction_batch/*.sample.ts`](prediction_batch/) | API サンプル | トップページの予想概要・回収率・履歴を返す Express API の実装例 |
| [`prediction_batch/*.sample.tsx`](prediction_batch/) | UI サンプル | 予想履歴・確定結果・スコア根拠を表示する React コンポーネント例 |
| [`prediction_batch/*.md`](prediction_batch/) | 設計資料 | 二つの予想モード、厳格な価値判定、トップページ連携の設計資料 |
| [`test_artifacts/`](test_artifacts/) | 検証資料 | SQL 予想パイプラインの複数条件フィクスチャ実行レポート |
| [`skills/`](skills/) | スキル | 競馬データ、予想運用、UI、検証の再利用可能なワークフローと補助資産 |
| [`CONNECTOR_TEST.md`](CONNECTOR_TEST.md) | 連携検証 | 外部連携の確認結果・前提条件 |

## 中核モジュール

| モジュール | 役割 |
| --- | --- |
| [`batch.py`](prediction_batch/batch.py) | 発走前の対象選択、最新データの検証、構造化予想生成、保存処理 |
| [`sql_pipeline.py`](prediction_batch/sql_pipeline.py) | 発走前スナップショットを用いた決定論的スコアリング、買い目作成、確定払戻による精算 |
| [`daily_performance.py`](prediction_batch/daily_performance.py) | 精算済みチケットから日次回収率を冪等に再構築 |
| [`config.py`](prediction_batch/config.py) | 環境変数の検証と実行設定の読み込み |
| [`models.py`](prediction_batch/models.py) | SQLAlchemy モデルおよび入力・出力スキーマ |
| [`main.py`](prediction_batch/main.py) | 定期バッチの起動入口 |

## 収録スキル

各スキルは `skills/<skill-name>/SKILL.md` を必須の入口とし、実行に必要な補助資産を同じディレクトリに配置しています。

| 分類 | スキル | 用途 |
| --- | --- | --- |
| 検証基盤 | [`db-skill-demo-harness`](skills/db-skill-demo-harness/) | 実データがない環境で、DB 前提スキルを安全に実演・監査する。 |
| 予想UI | [`ev-transparency-tooltips`](skills/ev-transparency-tooltips/) | 期待値、確率、オッズ、マイナス期待値警告を説明可能な UI にする。 |
| 予想UI | [`hero-realtime-alert-badge`](skills/hero-realtime-alert-badge/) | リアルタイムの重要シグナルをヒーロー領域の優先アラートとして実装・検証する。 |
| レース履歴 | [`keiba-data-complement`](skills/keiba-data-complement/) | レース履歴の枠番・馬番を補完し、枠順バイアスを検証する。 |
| 馬図鑑 | [`keiba-db-builder`](skills/keiba-db-builder/) | 廃止済みの馬図鑑 DB 構築手順を移行経緯の参照用として保管する。 |
| 馬図鑑 | [`keiba-horse-db-pipeline`](skills/keiba-horse-db-pipeline/) | 馬名照合を含む段階的な馬図鑑データ補完、netkeiba 連携、画像表示の問題解決を行う。 |
| 予想分析 | [`keiba-prediction-analysis`](skills/keiba-prediction-analysis/) | 的中率低下・外れ要因、スコア構成、荒れ判定を分析し、改善点を特定する。 |
| 予想運用 | [`keiba-prediction-operations`](skills/keiba-prediction-operations/) | データ取込、レース条件検証、予想・穴馬・買い目・精算・回収率の運用を安全に改善する。 |
| プロフィール | [`keiba-profile-updater`](skills/keiba-profile-updater/) | レース履歴から全馬・全騎手プロフィールを集計して最新化する。 |
| 予想基盤 | [`keiba-sql-prediction-operations`](skills/keiba-sql-prediction-operations/) | 発走前スナップショット、予想・買い目保存、払戻精算、日次回収率を含む SQL 蓄積型の予想基盤を構築する。 |
| オッズUI | [`multi-horse-odds-comparison`](skills/multi-horse-odds-comparison/) | 複数馬のオッズ推移を共通グラフ上で比較する React モーダルを構築・拡張する。 |
| レース履歴 | [`netkeiba-horse-history-batch`](skills/netkeiba-horse-history-batch/) | netkeiba から競走成績・写真 URL を取得し、週末出走馬の履歴を定期補完する。 |
| 検証基盤 | [`skill-demo-harness`](skills/skill-demo-harness/) | スキルを実環境で実演し、効果・コスト・安全機構を実測で評価する。 |

## 利用開始

予想バッチの導入・運用・データ連携は [`prediction_batch/README.md`](prediction_batch/README.md) を参照してください。最小構成では、次の流れで準備します。

```bash
cd prediction_batch
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# .env に DB 接続情報などを設定したうえで実行
python -m prediction_batch.main
```

DB の作成前に [`prediction_batch/schema.sql`](prediction_batch/schema.sql) を適用してください。実データ取得の実装箇所と利用上の制約は、[`prediction_batch/README.md`](prediction_batch/README.md) の「実データ連携の実装位置」に記載しています。

スキルを他の環境で使う場合は、必要なスキルディレクトリをコピーし、各スキルの `SKILL.md` を確認します。

```bash
cp -a skills/<skill-name> /home/ubuntu/skills/
```

## テスト

Python 仮想環境を有効化し、依存関係を導入したうえで、リポジトリ直下から次を実行します。

```bash
python -m unittest discover -s prediction_batch/tests -p 'test_*.py'
```

複数レース条件のフィクスチャ検証は、**隔離済みの MySQL/MariaDB データベース**に `schema.sql` を適用したうえで実行します。`DATABASE_URL` には、誤実行防止のため DB 名に `keiba_skill_test` を含む接続文字列を指定してください。

```bash
export DATABASE_URL='mysql+pymysql://USER:PASSWORD@HOST:3306/keiba_skill_test'
python -m prediction_batch.tests.run_multicondition_fixture
```

## 秘密情報の管理

実際の認証情報、接続文字列、API キーはコミットしません。ローカル設定には [`prediction_batch/.env.example`](prediction_batch/.env.example) をテンプレートとして使い、実値を含む `prediction_batch/.env` は `.gitignore` により除外されています。公開リポジトリへ反映する前に、設定ファイル、ログ、出力物に認証情報が含まれていないことを必ず確認してください。

## 追跡・保守方針

実行コードだけでなく、再現に必要なスキーマ、テスト、設計資料、UI/API サンプル、検証レポートも同じ履歴で管理します。生成物、ローカル実行環境、秘密情報は追跡対象外です。再利用可能な手順は `skills/` を正本として扱い、関連する実装・スキーマ・テンプレートは各スキル内へ配置します。既存アプリケーション固有のコードは `prediction_batch/` に残します。現在の追跡対象は `git ls-files` で確認できます。
