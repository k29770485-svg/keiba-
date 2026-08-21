#!/usr/bin/env bash
# ローカルMySQLを用意し、フィクスチャ用のDBとユーザを作成する。
#
# 使用方法:
#   bash setup_local_db.sh [db_name]
#
# 出力: 最終行に DATABASE_URL を表示する。以降のコマンドで
#       export DATABASE_URL=... / DB_SSL=off として利用する。
set -euo pipefail

DB_NAME="${1:-fixture_demo}"
DB_USER="fixture"
DB_PASS="fixtureDemo$(date +%Y)"

if ! command -v mysqld >/dev/null 2>&1; then
  echo "[1/3] mysql-server をインストール（apt update が必要な場合あり）"
  sudo apt-get update -qq
  sudo apt-get install -y -qq mysql-server >/dev/null
fi

echo "[2/3] MySQL を起動"
sudo service mysql start >/dev/null 2>&1 || true
for i in $(seq 1 20); do
  sudo mysqladmin ping >/dev/null 2>&1 && break
  sleep 1
done

echo "[3/3] DB とユーザを作成: ${DB_NAME}"
sudo mysql -e "
  CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4;
  CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
  GRANT ALL ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';
  FLUSH PRIVILEGES;"

echo
echo "接続確認:"
mysql -h 127.0.0.1 -u "${DB_USER}" -p"${DB_PASS}" -e "SELECT VERSION() AS mysql_version;" "${DB_NAME}" 2>/dev/null

cat <<EOF

━━━ 以降のコマンドで使う環境変数 ━━━
export DATABASE_URL="mysql://${DB_USER}:${DB_PASS}@127.0.0.1:3306/${DB_NAME}"
export DB_SSL=off   # 対象スクリプトがSSL必須の場合の回避用
EOF
