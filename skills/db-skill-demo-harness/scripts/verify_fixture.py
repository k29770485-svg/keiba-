#!/usr/bin/env python3
"""
投入したフィクスチャが「意図した症状」を実際に含んでいるか検証する。

フィクスチャ生成は乱数を伴うため、狙った症状が出ていないことがある。
症状が出ていないデータで対象スキルを走らせても実演にならないので、
生成直後にこのスクリプトで検算する。

期待値は JSON で宣言する（expectations.json）:
  {
    "connection": {"table_result": "race_results", "table_analysis": "race_analysis_results",
                   "join_key": "analysisId", "date_col": "raceDate", "hit_col": "isHit"},
    "assertions": [
      {"name": "的中率の急落", "sql": "...", "expect": "lt", "value": 10},
      {"name": "大荒れ日の存在", "sql": "...", "expect": "gte", "value": 1}
    ]
  }

expect は eq / lt / lte / gt / gte / between のいずれか。
between のときは value を [min, max] で指定する。

使用方法:
    python3 verify_fixture.py --expectations expectations.json
    （DATABASE_URL 環境変数が必要）
"""
import argparse
import json
import os
import sys
from urllib.parse import urlparse, unquote

try:
    import mysql.connector
except ImportError:
    print("mysql-connector-python が必要です: sudo pip3 install mysql-connector-python",
          file=sys.stderr)
    sys.exit(1)


def connect():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL が未設定です。setup_local_db.sh の出力を export してください。",
              file=sys.stderr)
        sys.exit(1)
    u = urlparse(url)
    return mysql.connector.connect(
        host=u.hostname, port=u.port or 3306,
        user=u.username, password=unquote(u.password or ""),
        database=u.path.lstrip("/"),
    )


def compare(actual, expect, value):
    if actual is None:
        return False
    ops = {
        "eq": lambda a, v: a == v,
        "lt": lambda a, v: a < v,
        "lte": lambda a, v: a <= v,
        "gt": lambda a, v: a > v,
        "gte": lambda a, v: a >= v,
    }
    if expect == "between":
        return value[0] <= actual <= value[1]
    if expect not in ops:
        raise ValueError(f"未知の expect: {expect}")
    return ops[expect](actual, value)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--expectations", required=True, help="期待値を宣言したJSONファイル")
    args = ap.parse_args()

    with open(args.expectations, encoding="utf-8") as f:
        spec = json.load(f)

    conn = connect()
    cur = conn.cursor()

    # --- 構造チェック: JOINが成立するか ---
    c = spec.get("connection", {})
    tr, ta = c.get("table_result"), c.get("table_analysis")
    jk = c.get("join_key")
    print("=" * 72)
    print("フィクスチャ検証")
    print("=" * 72)

    if tr and ta and jk:
        cur.execute(f"SELECT COUNT(*) FROM `{tr}`")
        n_result = cur.fetchone()[0]
        cur.execute(f"SELECT COUNT(*) FROM `{ta}`")
        n_analysis = cur.fetchone()[0]
        cur.execute(f"SELECT COUNT(*) FROM `{tr}` r JOIN `{ta}` a ON r.`{jk}` = a.id")
        n_join = cur.fetchone()[0]
        print(f"\n[構造] {tr}={n_result}件 / {ta}={n_analysis}件 / JOIN成立={n_join}件")
        if n_join < n_result:
            print(f"  ⚠ 孤児レコードが {n_result - n_join} 件あります。"
                  "JOINで落ちる行があると分析結果が実際より小さくなります。")
        else:
            print("  OK: 全行がJOINで突合できます。")

    # --- 症状チェック ---
    print("\n[症状] 意図した症状が実際に含まれているか")
    passed = failed = 0
    for a in spec.get("assertions", []):
        cur.execute(a["sql"])
        row = cur.fetchone()
        actual = float(row[0]) if row and row[0] is not None else None
        ok = compare(actual, a["expect"], a["value"])
        mark = "PASS" if ok else "FAIL"
        shown = "NULL" if actual is None else f"{actual:g}"
        print(f"  [{mark}] {a['name']}: 実測 {shown} "
              f"(期待 {a['expect']} {a['value']})")
        if ok:
            passed += 1
        else:
            failed += 1
            if a.get("hint"):
                print(f"         → {a['hint']}")

    print("\n" + "=" * 72)
    print(f"結果: PASS {passed} / FAIL {failed}")
    if failed:
        print("FAIL がある場合は生成パラメータ（確率・シード）を調整して再投入すること。")
        print("症状が出ていないデータで対象スキルを走らせても実演にならない。")
    print("=" * 72)

    cur.close()
    conn.close()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
