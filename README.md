# 競馬プロジェクト・スキル集

このリポジトリは、競馬予想アプリケーションのデータ基盤、予想運用、検証、UI改善に用いる **Manus スキルの管理元**です。各スキルは `skills/<skill-name>/SKILL.md` を必須の入口とし、必要に応じて `scripts/`、`references/`、`templates/` を同梱しています。個々のスキルに補助的な README は置かず、実行時に必要な指示とリソースをスキルディレクトリに集約しています。

## ディレクトリ構成

```text
.
├── prediction_batch/   # 既存の予想バッチ実装・設計資料
├── test_artifacts/     # 既存の検証成果物
└── skills/             # 再利用可能な Manus スキル
    └── <skill-name>/
        ├── SKILL.md
        ├── scripts/       # 任意: 実行用スクリプト
        ├── references/    # 任意: スキーマ・運用資料
        └── templates/     # 任意: 実装・出力テンプレート
```

## 収録スキル

| 分類 | スキル | 用途 |
|---|---|---|
| 検証基盤 | `db-skill-demo-harness` | 実データがない環境でDB前提スキルを安全に実演・監査する。 |
| 予想UI | `ev-transparency-tooltips` | 期待値、確率、オッズ、マイナス期待値警告を説明可能なUIにする。 |
| 予想UI | `hero-realtime-alert-badge` | リアルタイムの重要シグナルをヒーロー領域の優先アラートとして実装・検証する。 |
| レース履歴 | `keiba-data-complement` | レース履歴の枠番・馬番を補完し、枠順バイアスを検証する。 |
| 馬図鑑 | `keiba-db-builder` | **廃止済み**の馬図鑑DB構築手順。新規実装には使用せず、後継スキルへの移行経緯の参照用に保管する。 |
| 馬図鑑 | `keiba-horse-db-pipeline` | 馬名照合を含む段階的な馬図鑑データ補完、netkeiba連携、画像表示の問題解決を行う。 |
| 予想分析 | `keiba-prediction-analysis` | 的中率低下・外れ要因、スコア構成、荒れ判定を分析し、改善点を特定する。 |
| 予想運用 | `keiba-prediction-operations` | データ取込、レース条件検証、予想・穴馬・買い目・精算・回収率の運用を安全に改善する。 |
| プロフィール | `keiba-profile-updater` | レース履歴から全馬・全騎手プロフィールを集計して最新化する。 |
| 予想基盤 | `keiba-sql-prediction-operations` | 発走前スナップショット、予想・買い目保存、払戻精算、日次回収率を含むSQL蓄積型の予想基盤を構築する。 |
| オッズUI | `multi-horse-odds-comparison` | 複数馬のオッズ推移を共通グラフ上で比較するReactモーダルを構築・拡張する。 |
| レース履歴 | `netkeiba-horse-history-batch` | netkeibaから競走成績・写真URLを取得し、週末出走馬の履歴を定期補完する。 |
| 検証基盤 | `skill-demo-harness` | スキルを実環境で実演し、効果・コスト・安全機構を実測で評価する。 |

## 利用方法

必要なスキルディレクトリを Manus のスキルディレクトリへコピーします。スキルのメタデータと実行手順は、各ディレクトリの `SKILL.md` を参照してください。

```bash
cp -a skills/<skill-name> /home/ubuntu/skills/
```

スキルを変更する場合は、`SKILL.md` のフロントマターと同梱リソースの整合性を保ち、変更後にスキル検証を実行してください。

```bash
python3 /home/ubuntu/skills/skill-creator/scripts/quick_validate.py <skill-name>
```

## 保守方針

`skills/` をスキルの正本として扱い、関連する実装・スキーマ・テンプレートは各スキル内へ配置します。既存アプリケーション固有のコードは `prediction_batch/` に残し、再利用可能な手順だけを `skills/` に切り出します。将来の更新は、スキル単位で変更内容を検証したうえでコミットしてください。
