#!/usr/bin/env bash
# 実演用のローカル環境を用意する。
#
# スキルが DB / Node / テストランナーを前提にしている場合、実演のたびに同じ
# 手順を踏むことになる。冪等に書いてあるので繰り返し実行して差し支えない。
#
# 使い方:
#   bash setup_demo_env.sh <project-dir> [--mysql <dbname>] [--node] [--vitest]
#
# 例:
#   bash setup_demo_env.sh /home/ubuntu/demo --mysql demo_db --node --vitest
#
# --mysql を付けた場合、以下を stdout に出力する（呼び出し側で読み取って使う）:
#   DATABASE_URL=mysql://demo:demopass@127.0.0.1:3306/<dbname>
set -euo pipefail

PROJECT_DIR="${1:-}"
[ -z "$PROJECT_DIR" ] && { echo "usage: setup_demo_env.sh <project-dir> [--mysql <db>] [--node] [--vitest]"; exit 1; }
shift

DB_NAME=""
WANT_NODE=0
WANT_VITEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mysql)  DB_NAME="${2:-demo_db}"; shift 2 ;;
    --node)   WANT_NODE=1; shift ;;
    --vitest) WANT_VITEST=1; WANT_NODE=1; shift ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

if [ "$WANT_NODE" = "1" ]; then
  # ESM スクリプトは cwd の node_modules から依存を解決するため、
  # スキル同梱スクリプトは必ずプロジェクト直下で実行する必要がある
  [ -f package.json ] || { npm init -y >/dev/null 2>&1; npm pkg set type=module >/dev/null 2>&1; }
  echo "[ok] Node プロジェクト: $PROJECT_DIR"
fi

if [ "$WANT_VITEST" = "1" ]; then
  npm ls vitest >/dev/null 2>&1 || npm install -D vitest typescript >/dev/null 2>&1
  echo "[ok] vitest 準備完了"
fi

if [ -n "$DB_NAME" ]; then
  if ! command -v mysqld >/dev/null 2>&1 && ! command -v mariadbd >/dev/null 2>&1; then
    echo "[..] MariaDB を導入中（数分かかる）"
    sudo apt-get update -qq >/dev/null 2>&1 || true
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mariadb-server >/dev/null 2>&1
  fi
  sudo mkdir -p /var/run/mysqld && sudo chown mysql:mysql /var/run/mysqld
  sudo mysqladmin status >/dev/null 2>&1 || { sudo service mariadb start >/dev/null 2>&1; sleep 8; }

  sudo mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'demo'@'127.0.0.1' IDENTIFIED BY 'demopass';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO 'demo'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
  URL="mysql://demo:demopass@127.0.0.1:3306/${DB_NAME}"
  echo "export DATABASE_URL=\"$URL\"" > "$PROJECT_DIR/.env.sh"
  echo "[ok] MySQL 準備完了（.env.sh を生成。以後 'source .env.sh' で読み込む）"
  echo "DATABASE_URL=$URL"
fi
