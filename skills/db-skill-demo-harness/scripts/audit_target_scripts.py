#!/usr/bin/env python3
"""
対象スキルの付属スクリプトを静的監査し、実行前に既知の欠陥を検出する。

今回の実演で実際に遭遇した「実行不能」「誤読を招く出力」の原因は
パターン化できる。フィクスチャを作る前にこのスクリプトを走らせると、
接続すらできずに時間を溶かす事故を防げる。

使用方法:
    python3 audit_target_scripts.py /home/ubuntu/skills/<target-skill>

出力: 検出した問題の一覧（重大度つき）。終了コードは常に0（情報提供目的）。
"""
import argparse
import re
import sys
from pathlib import Path

# (正規表現, 重大度, 対象拡張子, 問題名, 説明と修正方針)
CHECKS = [
    (
        r"""import\s+\w+\s+from\s+['"]\./node_modules/""",
        "CRITICAL", {".mjs", ".js"},
        "ESM相対パスによるnode_modules参照",
        "ESMの相対パスはスクリプト自身の位置基準で解決される。cwd基準ではないため、"
        "プロジェクトディレクトリで実行してもERR_MODULE_NOT_FOUNDで即死する。"
        "修正: import x from 'pkg' のようにベアインポートへ変更する。",
    ),
    (
        r"require\(\s*['\"]\./node_modules/",
        "CRITICAL", {".js", ".cjs"},
        "CJS相対パスによるnode_modules参照",
        "同上。ベアインポート require('pkg') に変更する。",
    ),
    (
        r"rejectUnauthorized\s*:\s*true",
        "HIGH", {".mjs", ".js", ".cjs", ".ts"},
        "SSL設定のハードコード",
        "マネージドDB前提の固定値。ローカルMySQLや自己署名証明書では"
        "HANDSHAKE_SSL_ERRORで接続不能。環境変数で切替可能にする。",
    ),
    (
        r"ssl\s*=\s*\{\s*['\"]?ca['\"]?",
        "HIGH", {".py"},
        "SSL証明書パスのハードコード",
        "証明書ファイルが存在しない環境で接続不能。環境変数化する。",
    ),
    (
        r"/\s*(?:stats\.)?total\s*\*\s*100",
        "MEDIUM", {".mjs", ".js", ".cjs", ".py"},
        "ゼロ除算の未対策",
        "対象期間が0件のとき NaN% を出力する。母数0を検知して '—' 等を返す。",
    ),
    (
        r"d\.hits\s*/\s*d\.total",
        "MEDIUM", {".mjs", ".js", ".cjs"},
        "セグメント集計での母数下限なし",
        "n=10前後のセグメントの率がそのまま出力され、外れ値を"
        "『得意/不得意』と誤読する。母数下限（例 n>=20）未満に注記を付ける。",
    ),
    (
        r"process\.env\.DATABASE_URL",
        "INFO", {".mjs", ".js", ".cjs"},
        "DATABASE_URL依存",
        "実行前に環境変数を用意する必要がある。setup_local_db.sh の出力を使う。",
    ),
    (
        r"\.toISOString\(\)\.split\('T'\)\[0\]",
        "LOW", {".mjs", ".js", ".cjs"},
        "UTC基準の日付計算",
        "ローカルタイムゾーンとずれ、開催日の境界で1日ずれる可能性がある。",
    ),
]

SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
CODE_EXT = {".mjs", ".js", ".cjs", ".ts", ".py", ".sh"}


def audit(skill_dir: Path):
    findings = []
    files = [p for p in skill_dir.rglob("*") if p.is_file() and p.suffix in CODE_EXT]
    if not files:
        print(f"警告: {skill_dir} に監査対象のコードファイルが見つかりません。")
        return findings, files

    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        lines = text.splitlines()
        for pattern, sev, exts, name, desc in CHECKS:
            if path.suffix not in exts:
                continue
            for i, line in enumerate(lines, 1):
                if re.search(pattern, line):
                    findings.append(dict(severity=sev, file=path, line=i,
                                         name=name, desc=desc, code=line.strip()))
                    break  # 同一ファイル・同一チェックは1件に集約
    findings.sort(key=lambda f: (SEVERITY_ORDER[f["severity"]], str(f["file"])))
    return findings, files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("skill_dir", help="監査対象スキルのディレクトリ")
    args = ap.parse_args()

    skill_dir = Path(args.skill_dir).expanduser().resolve()
    if not skill_dir.is_dir():
        print(f"エラー: ディレクトリが存在しません: {skill_dir}", file=sys.stderr)
        sys.exit(1)

    findings, files = audit(skill_dir)

    print("=" * 72)
    print(f"静的監査: {skill_dir.name}  (コードファイル {len(files)} 件)")
    print("=" * 72)

    if not findings:
        print("既知パターンの問題は検出されませんでした。")
    else:
        for f in findings:
            rel = f["file"].relative_to(skill_dir)
            print(f"\n[{f['severity']}] {f['name']}")
            print(f"  場所: {rel}:{f['line']}")
            print(f"  該当: {f['code'][:100]}")
            print(f"  対処: {f['desc']}")

    crit = sum(1 for f in findings if f["severity"] in ("CRITICAL", "HIGH"))
    print("\n" + "=" * 72)
    print(f"検出 {len(findings)} 件（うち CRITICAL/HIGH {crit} 件）")
    if crit:
        print("CRITICAL/HIGH はフィクスチャ投入前に修正版を用意すること。"
              "対象スキル本体は書き換えず、作業ディレクトリに修正版を置く。")
    print("=" * 72)


if __name__ == "__main__":
    main()
