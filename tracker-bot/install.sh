#!/bin/bash
# Установка или обновление SkinWatch одной командой (от root):
#   curl -fsSL https://raw.githubusercontent.com/gdima7249-cpu/3/claude/adoring-euler-f2cetx/tracker-bot/install.sh | bash
# Первая установка — добавьте токен бота и свой chat id:
#   … | bash -s -- 123456789:AA… 123456789
# Обновление не трогает .env (настройки, ЮMoney) и data/ (пользователи, подписки, история цен).
# Если бот был остановлен или выключен — запускает его и включает автозапуск.
set -euo pipefail

REPO="gdima7249-cpu/3"
BRANCH="claude/adoring-euler-f2cetx"
DIR="${SKINWATCH_DIR:-/opt/tracker-bot}"
SERVICE="skinwatch"
TOKEN="${1:-}"
ADMIN="${2:-}"

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

AVAIL_MB=$(df -Pm / | awk 'NR==2 {print $4}')
[ "$AVAIL_MB" -ge 50 ] || fail "На диске свободно всего ${AVAIL_MB} МБ, нужно хотя бы 50 МБ."

say "Скачиваю SkinWatch…"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP"
SRC=$(find "$TMP" -mindepth 2 -maxdepth 2 -type d -name tracker-bot | head -1)
[ -n "$SRC" ] || fail "В архиве нет папки tracker-bot."

UPDATE=0
[ -f "$DIR/.env" ] && UPDATE=1
OLD=$(node -p "try{require('$DIR/package.json').version}catch{''}" 2>/dev/null || true)

# Перед заменой файлов — копия базы (на случай отката)
if [ -f "$DIR/data/bot.db" ]; then
  mkdir -p /opt/backups
  BK="/opt/backups/skinwatch-before-update-$(date +%F-%H%M).db"
  node -e "new (require('node:sqlite').DatabaseSync)('$DIR/data/bot.db').exec(\"VACUUM INTO '$BK'\")" 2>/dev/null \
    && echo "Копия базы: $BK" || echo "⚠️  Не удалось сделать копию базы — продолжаю."
fi

mkdir -p "$DIR"
# Код заменяем целиком; .env и data/ остаются
rm -rf "$DIR/src" "$DIR/scripts" "$DIR/deploy" "$DIR/test"
cp -r "$SRC/src" "$SRC/scripts" "$SRC/deploy" "$SRC/test" "$SRC/package.json" "$SRC/README.md" "$SRC/.env.example" "$DIR/"
[ -d "$DIR/assets" ] || cp -r "$SRC/assets" "$DIR/"
chmod +x "$DIR/deploy/"*.sh 2>/dev/null || true

[ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
[ -n "$TOKEN" ] && sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=$TOKEN|" "$DIR/.env"
[ -n "$ADMIN" ] && sed -i "s|^ADMIN_CHAT_IDS=.*|ADMIN_CHAT_IDS=$ADMIN|" "$DIR/.env"
grep -qE '^BOT_TOKEN=[0-9]+:' "$DIR/.env" || fail "Не задан токен бота. Запустите ещё раз, добавив в конце токен и свой chat id: … | bash -s -- 123456:AA… 123456789"

say "Запускаю…"
cp "$DIR/deploy/skinwatch.service" "/etc/systemd/system/$SERVICE.service"
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$DIR|; s|^ExecStart=/usr/bin/node|ExecStart=$(command -v node)|" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 6
journalctl -u "$SERVICE" -n 15 --no-pager || true

NEW=$(node -p "require('$DIR/package.json').version")
if systemctl is-active --quiet "$SERVICE"; then
  if [ $UPDATE -eq 1 ]; then say "✅ SkinWatch обновлён${OLD:+ с $OLD} до $NEW и работает."; else say "✅ SkinWatch $NEW установлен и работает."; fi
else
  fail "Бот не запустился. Логи: journalctl -u $SERVICE -n 50"
fi
echo "Проверка площадок (Rust, TF2 и др.): cd $DIR && npm run check"
echo "Логи: journalctl -u $SERVICE -f    Перезапуск: systemctl restart $SERVICE    Остановить: systemctl disable --now $SERVICE"
