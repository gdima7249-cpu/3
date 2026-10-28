#!/bin/bash
# Установка или обновление бота «Маркет-цены» одной командой:
#   curl -fsSL https://raw.githubusercontent.com/gdima7249-cpu/3/claude/adoring-euler-f2cetx/market-bot/install.sh | bash -s -- ТОКЕН_БОТА
# Повторный запуск обновляет код и не трогает .env и историю цен (data/). Токен при обновлении можно не указывать.
set -euo pipefail

REPO="gdima7249-cpu/3"
BRANCH="claude/adoring-euler-f2cetx"
DIR="${MARKET_BOT_DIR:-/opt/market-bot}"
TOKEN="${1:-}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Запустите от root."

# Node.js 22.13+
if ! command -v node >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    fail "Нет Node.js. Установите: dnf module reset -y nodejs && dnf module install -y --setopt=install_weak_deps=False nodejs:22/minimal && dnf clean all"
  else
    fail "Нет Node.js. Установите: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
  fi
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Нужен Node.js 22.13 или новее, сейчас $(node -v)."

# Место на диске: самому боту хватает ~20 МБ
AVAIL_MB=$(df -Pm / | awk 'NR==2 {print $4}')
[ "$AVAIL_MB" -ge 30 ] || fail "На диске свободно всего ${AVAIL_MB} МБ, нужно хотя бы 30 МБ."

say "Скачиваю бота…"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP"
SRC=$(find "$TMP" -mindepth 2 -maxdepth 2 -type d -name market-bot | head -1)
[ -n "$SRC" ] || fail "В архиве нет папки market-bot."

UPDATE=0
[ -f "$DIR/.env" ] && UPDATE=1
mkdir -p "$DIR"
# Код заменяем целиком, .env и data/ (история цен) остаются
rm -rf "$DIR/src" "$DIR/scripts" "$DIR/deploy" "$DIR/test"
cp -r "$SRC/src" "$SRC/scripts" "$SRC/deploy" "$SRC/test" "$SRC/package.json" "$SRC/README.md" "$SRC/.env.example" "$SRC/.gitignore" "$DIR/"
chmod +x "$DIR/deploy/backup.sh"

[ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
if [ -n "$TOKEN" ]; then
  sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=$TOKEN|" "$DIR/.env"
fi
grep -qE '^BOT_TOKEN=[0-9]+:' "$DIR/.env" || fail "Не задан токен бота. Запустите ещё раз, добавив токен в конце: … | bash -s -- 123456:AA..."

say "Проверяю страницу Маркета (одна загрузка)…"
cd "$DIR"
if node --disable-warning=ExperimentalWarning scripts/probe.js; then
  PROBE=ok
else
  PROBE=fail
fi

say "Запускаю бота как сервис…"
cp deploy/market-bot.service /etc/systemd/system/market-bot.service
sed -i "s|^ExecStart=/usr/bin/node|ExecStart=$(command -v node)|" /etc/systemd/system/market-bot.service
systemctl daemon-reload
systemctl enable market-bot >/dev/null 2>&1
systemctl restart market-bot
sleep 5
journalctl -u market-bot -n 12 --no-pager || true

if systemctl is-active --quiet market-bot; then
  say "✅ Бот $([ $UPDATE -eq 1 ] && echo обновлён || echo установлен) и работает."
  [ $UPDATE -eq 1 ] || echo "Напишите своему боту в Telegram /start — вы станете его владельцем."
else
  fail "Сервис не запустился. Логи: journalctl -u market-bot -n 50"
fi
[ "$PROBE" = ok ] || echo "⚠️  Самопроверка не нашла цену — пришлите её вывод выше (или файл $DIR/data/debug/probe.json)."
echo "Логи: journalctl -u market-bot -f    Перезапуск: systemctl restart market-bot"
