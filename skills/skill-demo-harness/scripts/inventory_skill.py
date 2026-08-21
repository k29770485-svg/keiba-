#!/usr/bin/env python3
"""対象スキルの実演計画を立てるための棚卸し。

スキルディレクトリを走査し、「何を実演できるか」を機械的に洗い出す。
SKILL.md を読む前にこれを走らせると、実行可能な資産（スクリプト・テスト）と
主張（表・箇条書きで書かれた効果や禁止事項）が一覧で得られる。

使い方:
    python inventory_skill.py <skill-name-or-path> [--json]
"""
import argparse
import json
import os
import re
import sys

CLAIM_PATTERNS = [
    (r"(?:必ず|MUST|必須|絶対に)", "obligation"),
    (r"(?:非推奨|してはならない|使わない|禁止|NEVER|DO NOT)", "prohibition"),
    (r"\b\d+(?:\.\d+)?\s*(?:ms|秒|件|頭|%|倍|リクエスト)", "metric"),
    (r"(?:実測|検証済み|事例がある)", "evidence"),
]

RUNNABLE_EXT = {".py": "python3", ".mjs": "node", ".js": "node", ".sh": "bash", ".ts": "vitest"}


def resolve(target: str) -> str:
    if os.path.isdir(target):
        return os.path.abspath(target)
    cand = os.path.join("/home/ubuntu/skills", target)
    if os.path.isdir(cand):
        return cand
    sys.exit(f"skill not found: {target}")


def read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return ""


def parse_frontmatter(body: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---\n", body, re.S)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def find_cli_args(text: str) -> list:
    """スクリプトが受け付けるフラグを推定する（--dry-run 等の存在確認に使う）"""
    flags = set(re.findall(r'["\'](--[a-z0-9-]{2,})["\']', text))
    flags |= set(re.findall(r'add_argument\(\s*["\'](--[a-z0-9-]+)', text))
    return sorted(flags)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("skill")
    ap.add_argument("--json", action="store_true", help="JSONで出力")
    args = ap.parse_args()

    root = resolve(args.skill)
    skill_md = os.path.join(root, "SKILL.md")
    body = read(skill_md)
    fm = parse_frontmatter(body)

    report = {
        "skill": os.path.basename(root),
        "path": root,
        "name": fm.get("name", ""),
        "description": fm.get("description", "")[:300],
        "skill_md_lines": body.count("\n") + 1 if body else 0,
        "runnable": [],
        "tests": [],
        "references": [],
        "templates": [],
        "claims": {"obligation": 0, "prohibition": 0, "metric": 0, "evidence": 0},
        "external_access": [],
        "env_vars": [],
    }

    env_vars = set()
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            ext = os.path.splitext(fn)[1]
            text = read(full)

            env_vars |= set(re.findall(r"process\.env\.([A-Z][A-Z0-9_]+)", text))
            env_vars |= set(re.findall(r"os\.environ(?:\.get)?[\[(]['\"]([A-Z][A-Z0-9_]+)", text))

            if fn.endswith((".test.ts", ".test.js", "_test.py", "test_" + fn)):
                report["tests"].append({"file": rel, "cases": len(re.findall(r"\b(?:it|test)\(", text))})
            elif ext in RUNNABLE_EXT and "/references/" not in full:
                entry = {"file": rel, "runner": RUNNABLE_EXT[ext], "flags": find_cli_args(text)}
                doc = re.match(r'\s*(?:"""|/\*\*)(.{0,200})', text, re.S)
                if doc:
                    entry["purpose"] = " ".join(doc.group(1).split())[:120]
                report["runnable"].append(entry)
            elif "/references/" in full:
                report["references"].append({"file": rel, "lines": text.count("\n") + 1})
            elif "/templates/" in full:
                report["templates"].append({"file": rel, "lines": text.count("\n") + 1})

            for host in set(re.findall(r"https?://([a-z0-9.-]+\.[a-z]{2,})", text)):
                if host not in report["external_access"]:
                    report["external_access"].append(host)

    for pat, kind in CLAIM_PATTERNS:
        report["claims"][kind] = len(re.findall(pat, body))
    report["env_vars"] = sorted(env_vars)
    report["external_access"].sort()

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    print(f"=== 棚卸し: {report['skill']} ===")
    print(f"SKILL.md: {report['skill_md_lines']} 行")
    if report["description"]:
        print(f"description: {report['description'][:160]}")
    print(f"\n実行可能な資産 ({len(report['runnable'])}件) — これが実演の骨格になる")
    for r in report["runnable"]:
        flags = f"  flags={' '.join(r['flags'])}" if r["flags"] else ""
        print(f"  [{r['runner']:>6}] {r['file']}{flags}")
        if r.get("purpose"):
            print(f"           {r['purpose']}")
    print(f"\nテスト ({len(report['tests'])}件) — 実アクセス不要の検証に使う")
    for t in report["tests"]:
        print(f"  {t['file']}  ({t['cases']} cases)")
    print(f"\nリファレンス ({len(report['references'])}件)")
    for r in report["references"]:
        print(f"  {r['file']}  {r['lines']} 行")
    print(f"\nテンプレート ({len(report['templates'])}件)")
    for t in report["templates"]:
        print(f"  {t['file']}  {t['lines']} 行")
    print(f"\n必要な環境変数: {', '.join(report['env_vars']) or 'なし'}")
    print(f"外部アクセス先: {', '.join(report['external_access'][:8]) or 'なし'}")
    c = report["claims"]
    print(f"\nSKILL.md 内の主張: 義務{c['obligation']} 禁止{c['prohibition']} "
          f"数値{c['metric']} 実測根拠{c['evidence']}")
    print("→ 禁止と数値の主張は対照実験・実測で裏を取る対象になる")


if __name__ == "__main__":
    main()
