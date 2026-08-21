#!/usr/bin/env python3
"""実演で得た実測値を2枚組のグラフにする（効果の推移 + 手法別コスト）。

スキルが「コストが安い」「充填率が上がる」と主張する場合、文章より図の方が速い。
実測したJSONを渡すと、左に段階ごとの効果推移（折れ線 + 累計コストの棒）、
右に手法別コスト比較（横棒、非推奨手法は赤）を描く。

使い方:
    python plot_demo_metrics.py metrics.json -o chart.png

metrics.json の形（値はすべて実測値を入れる。推定値は使わない）:
{
  "title": "段階的補完による項目別充填率の推移",
  "total": 46,
  "unit": "頭",
  "stages": ["段階0\n初期状態", "段階1\nSQL一括補完"],
  "series": [{"label": "所属", "values": [0, 46]}],
  "cumulative_cost": [3, 3],
  "cost_label": "累計外部リクエスト数（棒）",
  "methods": [
    {"label": "段階1 SQL一括補完", "cost": 0},
    {"label": "全件取得（非推奨）", "cost": 138, "discouraged": true}
  ],
  "methods_title": "手法別の外部リクエスト消費量（実測）",
  "methods_xlabel": "消費した外部リクエスト数"
}
"""
import argparse
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# CJK を含むラベルが豆腐にならないようフォントを明示する
plt.rcParams["font.family"] = "Noto Sans CJK JP"
plt.rcParams["axes.unicode_minus"] = False

PALETTE = ["#2b6cb0", "#2f855a", "#38a169", "#d69e2e", "#c05621", "#805ad5", "#0987a0"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("-o", "--out", default="demo_metrics.png")
    ap.add_argument("--lang", default="ja", choices=["ja", "en"],
                    help="en を指定すると DejaVu Sans を使う")
    args = ap.parse_args()

    if args.lang == "en":
        plt.rcParams["font.family"] = "DejaVu Sans"

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    has_methods = bool(cfg.get("methods"))
    fig, axes = plt.subplots(1, 2 if has_methods else 1,
                             figsize=(15, 5.6) if has_methods else (8.5, 5.6))
    axes = np.atleast_1d(axes)

    # --- 左: 効果の推移 ---
    ax = axes[0]
    stages = cfg["stages"]
    total = cfg.get("total", 100)
    x = np.arange(len(stages))
    for i, s in enumerate(cfg.get("series", [])):
        pct = [v / total * 100 for v in s["values"]]
        ax.plot(x, pct, marker="o", linewidth=2.4, markersize=8,
                label=s["label"], color=s.get("color", PALETTE[i % len(PALETTE)]))
    ax.set_xticks(x)
    ax.set_xticklabels(stages, fontsize=10)
    ax.set_ylabel(cfg.get("ylabel", "充填率 (%)"), fontsize=11)
    ax.set_ylim(-6, 108)
    ax.set_title(cfg.get("title", ""), fontsize=13, pad=12)
    ax.grid(alpha=0.25, linestyle="--")
    if cfg.get("series"):
        ax.legend(fontsize=9, loc=cfg.get("legend_loc", "center left"))

    cost = cfg.get("cumulative_cost")
    if cost:
        ax2 = ax.twinx()
        ax2.bar(x, cost, alpha=0.14, color="#4a5568", width=0.5, zorder=0)
        ax2.set_ylabel(cfg.get("cost_label", "累計コスト（棒）"), fontsize=10, color="#4a5568")
        headroom = max(cost) * 2.6 if max(cost) else 1
        ax2.set_ylim(0, headroom)
        for xi, c in zip(x, cost):
            ax2.text(xi, c + headroom * 0.025, f"{c}", ha="center", fontsize=9, color="#4a5568")

    # --- 右: 手法別コスト ---
    if has_methods:
        ax = axes[1]
        labels = [m["label"] for m in cfg["methods"]]
        costs = [m["cost"] for m in cfg["methods"]]
        # 非推奨手法は赤で示し、「やらない選択」を視覚的に伝える
        colors = ["#c53030" if m.get("discouraged") else PALETTE[i % len(PALETTE)]
                  for i, m in enumerate(cfg["methods"])]
        bars = ax.barh(labels, costs, color=colors, height=0.55)
        suffix = cfg.get("cost_suffix", "")
        for b, c in zip(bars, costs):
            ax.text(b.get_width() + max(costs) * 0.02, b.get_y() + b.get_height() / 2,
                    f"{c}{suffix}", va="center", fontsize=10.5, fontweight="bold")
        ax.set_xlim(0, max(costs) * 1.28 if max(costs) else 1)
        ax.set_xlabel(cfg.get("methods_xlabel", "コスト"), fontsize=11)
        ax.set_title(cfg.get("methods_title", ""), fontsize=13, pad=12)
        ax.grid(axis="x", alpha=0.25, linestyle="--")
        ax.invert_yaxis()

    plt.tight_layout()
    plt.savefig(args.out, dpi=160, bbox_inches="tight")
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
