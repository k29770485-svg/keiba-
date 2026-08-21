#!/usr/bin/env python3
"""安全機構の対照実験（A/B）を実行し、結果を判定する汎用ハーネス。

スキルが「この機構が無いと壊れる」と主張するとき、機構ありの成功だけを見せても
主張は裏付けられない。**機構を外した版が実際に壊れること**を同一条件で示して初めて
実証になる。このスクリプトは以下を機械的に行う。

  1. 破壊条件を仕込む      (setup コマンド)
  2. 機構ありで実行         (guarded コマンド)
  3. 状態を観測             (observe コマンド)
  4. 機構なしで実行         (unguarded コマンド)
  5. 状態を再観測           (observe コマンド)
  6. 元に戻す               (teardown コマンド)

観測結果が 2 回で「変化しない → 変化した」となれば、機構が効いていることの証拠になる。

使い方（JSON設定ファイルを渡す）:
    python ab_guard_probe.py experiment.json

experiment.json の形:
{
  "name": "名前照合ガード",
  "cwd": "/home/ubuntu/demo",
  "env": {"DATABASE_URL": "mysql://..."},
  "setup":     "node corrupt_ids.mjs",
  "guarded":   "node batch_fetch.mjs --limit 3",
  "unguarded": "node batch_fetch_noguard.mjs --limit 3",
  "observe":   "mysql -N -e 'SELECT trainer FROM horses WHERE id IN (1,2,3)'",
  "teardown":  "node restore_ids.mjs",
  "expect_guarded_unchanged": true
}

teardown は guarded/unguarded が失敗しても必ず実行される。
"""
import argparse
import json
import os
import subprocess
import sys
import time


def run(cmd: str, cwd: str, env: dict, label: str, timeout: int = 900) -> dict:
    print(f"\n--- {label} ---")
    print(f"$ {cmd}")
    t0 = time.time()
    proc = subprocess.run(cmd, shell=True, cwd=cwd, env=env, timeout=timeout,
                          capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    print(out.rstrip()[:4000])
    return {"cmd": cmd, "exit": proc.returncode, "output": out, "ms": int((time.time() - t0) * 1000)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("config", help="実験定義のJSONファイル")
    ap.add_argument("--out", help="結果JSONの保存先")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    for key in ("guarded", "observe"):
        if not cfg.get(key):
            sys.exit(f"config に '{key}' が必要")

    cwd = cfg.get("cwd", os.getcwd())
    env = {**os.environ, **cfg.get("env", {})}
    result = {"name": cfg.get("name", "experiment"), "steps": {}}

    print(f"=== 対照実験: {result['name']} ===")
    try:
        if cfg.get("setup"):
            result["steps"]["setup"] = run(cfg["setup"], cwd, env, "1. 破壊条件を仕込む")

        result["steps"]["baseline"] = run(cfg["observe"], cwd, env, "2. 実行前の状態を観測")
        result["steps"]["guarded"] = run(cfg["guarded"], cwd, env, "3. 機構ありで実行")
        result["steps"]["after_guarded"] = run(cfg["observe"], cwd, env, "4. 機構あり実行後の状態")

        if cfg.get("unguarded"):
            result["steps"]["unguarded"] = run(cfg["unguarded"], cwd, env, "5. 機構なしで実行")
            result["steps"]["after_unguarded"] = run(cfg["observe"], cwd, env, "6. 機構なし実行後の状態")
    finally:
        if cfg.get("teardown"):
            result["steps"]["teardown"] = run(cfg["teardown"], cwd, env, "7. 後片付け（必ず実行）")

    base = result["steps"]["baseline"]["output"].strip()
    after_g = result["steps"]["after_guarded"]["output"].strip()
    guarded_unchanged = base == after_g
    verdict = {"guarded_state_unchanged": guarded_unchanged}

    print("\n=== 判定 ===")
    if cfg.get("expect_guarded_unchanged", True):
        print(f"機構あり: 状態が変化しない … {'PASS' if guarded_unchanged else 'FAIL'}")
        if not guarded_unchanged:
            print("  ! 機構ありでも状態が変わった。ガードが機能していない可能性がある")
    if "after_unguarded" in result["steps"]:
        after_u = result["steps"]["after_unguarded"]["output"].strip()
        unguarded_changed = base != after_u
        verdict["unguarded_state_changed"] = unguarded_changed
        print(f"機構なし: 状態が変化する   … {'PASS' if unguarded_changed else 'FAIL'}")
        if not unguarded_changed:
            print("  ! 機構なしでも壊れなかった。破壊条件の仕込みが弱い可能性がある")
        verdict["proves_guard_necessary"] = guarded_unchanged and unguarded_changed
        print(f"\n結論: 機構の必要性が実証された … "
              f"{'YES' if verdict['proves_guard_necessary'] else 'NO'}")

    result["verdict"] = verdict
    out_path = args.out or "ab_guard_result.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n結果を保存: {out_path}")
    sys.exit(0 if verdict.get("proves_guard_necessary", guarded_unchanged) else 1)


if __name__ == "__main__":
    main()
