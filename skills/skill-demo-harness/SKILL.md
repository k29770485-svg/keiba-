---
name: skill-demo-harness
description: 追加されたスキルを実データ・実環境で実演し、その主張が成立するかを実測で検証してレポートにまとめるスキル。棚卸しで実行可能な資産を洗い出し、サンドボックスに専用環境を立て、段階ごとのコストと効果を計測し、安全機構については機構なし版との対照実験で必要性を実証する。Use when demonstrating a newly added skill, showcasing what a skill can do, validating or reviewing a skill's claims, benchmarking a pipeline's cost efficiency, proving that a safety guard is necessary, or producing an evidence-based report about a skill or tool.
---

# スキル実演ハーネス

スキルを「動かして見せる」のではなく、**主張が成立するかを実測で示す**ための手順。
成功ケースを並べるだけでは、そのスキルが防いでいる失敗の価値が伝わらない。

## 中核原則

1. **実データ・実環境で行う** — モックや模擬データを実測値として提示しない
2. **前後の数値を残す** — 「動きました」ではなく「0% → 100%、外部0件、6ms」
3. **安全機構は対照実験で示す** — 機構なし版が実際に壊れることを同一条件で見せる
4. **後片付けを必ず用意する** — 破壊実験はサンドボックス専用環境で行い、元に戻す

## 実行手順

### 段階1: 棚卸し（対象スキルを読む前に実行する）

```bash
python /home/ubuntu/skills/skill-demo-harness/scripts/inventory_skill.py <skill-name>
```

実行可能なスクリプトとそのフラグ、テスト件数、必要な環境変数、外部アクセス先、
SKILL.md 内の「義務・禁止・数値・実測根拠」の件数が出る。
**禁止と数値の主張が対照実験と実測の対象になる。**

続いて対象スキルの SKILL.md と、パーサ仕様やスキーマ定義など実演に必要な
リファレンスのみを読む。全リファレンスを読む必要はない。

### 段階2: デモ計画を立てる

棚卸し結果を実演項目に対応させる。対応表と規模の決め方は
`references/demo-design.md` の1〜2章を読む。

デモは4〜8本。**最も価値のあるデモを1本決めておく**（多くの場合、安全機構の対照実験）。

### 段階3: 環境を用意する

```bash
bash /home/ubuntu/skills/skill-demo-harness/scripts/setup_demo_env.sh \
  /home/ubuntu/<demo-dir> --mysql <dbname> --node --vitest
```

MariaDB の導入・起動・DB作成・専用ユーザー作成までを冪等に行い、
`DATABASE_URL` を `.env.sh` に書き出す。以後は `source .env.sh` で読み込む。

**ESM スクリプトは cwd の `node_modules` から依存を解決する。**
スキル同梱スクリプトは必ずプロジェクト直下で実行する
（スキルディレクトリから直接実行すると `ERR_MODULE_NOT_FOUND` になる）。

対象スキルにスキーマ定義があれば、それに準拠した SQL を書いて適用する。

### 段階4: 前提条件を検証する

対象スキルに契約テスト・検証系スクリプトがあれば**最初に実行する**。
前提が崩れていれば以降のデモは無意味になる。

無い場合は、パーサが依存する外部仕様を1回だけ手動で確認し、結果を記録する。

### 段階5: 段階ごとに実行し、前後を計測する

対象スキルが優先順位や段階を定義しているなら**その順序どおりに**実行する。
順序を変えるとコスト効率の主張が検証できない。

各段階で次を守る。

- `--dry-run` があれば dry-run → 本実行の順で実行する
- レポート・集計系スクリプトを**各段階の前後で実行**し、出力をファイルに保存する
- 消費した外部リクエスト数と所要時間を記録する
- 取得された実データを3〜5件、後で表にできる形で残す

**意図的に全件を埋めない。** 一部を未処理で残すことで、オンデマンド補完など
次段階の対象が残っている状態を可視化できる。

### 段階6: 安全機構の対照実験

対象スキルが「これが無いと壊れる」と主張する機構について実施する。

```bash
python /home/ubuntu/skills/skill-demo-harness/scripts/ab_guard_probe.py experiment.json
```

`templates/experiment.example.json` をコピーして編集する。設定項目は
setup（破壊条件を仕込む）、guarded（正しい実装）、unguarded（機構だけ外した実装）、
observe（状態を出力）、teardown（元に戻す。失敗時も必ず実行される）。

**unguarded は正しい実装からガード部分のみを削除して作る。**
別実装を書くと「実装が違うから結果が違う」という反論を許す。

判定は「機構ありで状態が変化せず、機構なしで変化する」の両方が成立して成功。
機構なしでも壊れなかった場合は破壊条件の仕込みが弱い。

主張の種類別の検証方法は `references/demo-design.md` の3章を読む。

### 段階7: 単体テストを実行する

同梱テストがあれば実行する。実アクセスに依存しないためレート制限で落ちない。

```bash
cd <demo-dir> && mkdir -p src && cp <skill>/templates/*.ts src/ && npx vitest run src/
```

### 段階8: 可視化する

```bash
python /home/ubuntu/skills/skill-demo-harness/scripts/plot_demo_metrics.py metrics.json -o chart.png
```

`templates/metrics.example.json` をコピーして実測値を入れる。左に効果の推移
（折れ線 + 累計コストの棒）、右に手法別コスト比較（非推奨手法は赤）を描く。
**実測値のみを入れる。** 非推奨手法の理論値を並べる場合は算出根拠をレポートに書く。

生成後は必ず画像を確認し、CJK が豆腐になっていないか、ラベルが重なっていないかを見る。

### 段階9: レポートを書く

`templates/demo-report-template.md` をコピーして書く。構成は概要 → 各デモ →
対照実験 → 総括（コスト効率の表 / スキルとして優れている点 / 運用上の補足）。

必ず含める。

- 実データ・実環境を使ったことと、その規模
- 各段階の前後の数値とコスト
- 取得された実データの実物（表で3〜5件）
- 対照実験の両側の結果
- 規模を絞ったことによる限界（未再現の条件を正直に書く）
- データ出典

**ログの全文は貼らない。** 判定に効く数行だけ引用し、全文はファイルで添付する。

### 段階10: 後片付け

破壊実験で変更した状態を元に戻したか確認する。起動したサーバプロセスを停止する。
成果物（レポート、グラフ、CSV、各段階のログ）を添付して納品する。

## アンチパターン

やりがちな失敗と対処は `references/demo-design.md` の5章にまとめてある。
特に頻出する3つを挙げる。

| やりがちなこと | 代わりにすること |
|---|---|
| 成功ケースだけ並べる | 対照実験で機構なし版の破綻を見せる |
| 全件処理して充填率100%にする | 一部を残し、次段階の対象を可視化する |
| スキルの記述をそのまま要約する | 実測値と突き合わせ、一致/不一致を述べる |

## リソース

| ファイル | 用途 |
|---|---|
| `scripts/inventory_skill.py` | 対象スキルの棚卸し。実演計画の起点 |
| `scripts/setup_demo_env.sh` | MySQL / Node / vitest 環境の冪等セットアップ |
| `scripts/ab_guard_probe.py` | 安全機構の対照実験ハーネス。判定と後片付け込み |
| `scripts/plot_demo_metrics.py` | 効果推移とコスト比較の2枚組グラフ生成 |
| `references/demo-design.md` | デモ選定・規模決定・主張別検証法・アンチパターン |
| `templates/demo-report-template.md` | レポート構成のテンプレート |
| `templates/experiment.example.json` | 対照実験の設定例 |
| `templates/metrics.example.json` | グラフ設定の例 |
