#!/usr/bin/env bash
# Установка faceless на Ubuntu/Debian одной командой:
#   curl -fsSL https://raw.githubusercontent.com/gdima7249-cpu/3/claude/busy-mccarthy-bf77na/deploy/install.sh | sudo bash
# Повторный запуск безопасен: обновит код и зависимости, настройки и ключи не трогает.
set -euo pipefail

REPO="https://github.com/gdima7249-cpu/3.git"
BRANCH="claude/busy-mccarthy-bf77na"
HOME_DIR="/opt/faceless"
APP="$HOME_DIR/app"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запустите через sudo (или под root)"
command -v apt-get >/dev/null || die "скрипт рассчитан на Ubuntu/Debian"

say "Ставлю системные пакеты (ffmpeg, python, git, шрифты)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg git python3 python3-venv fonts-dejavu-core fontconfig ca-certificates curl >/dev/null

PY=""
for v in python3.13 python3.12 python3.11; do
  if command -v "$v" >/dev/null; then PY="$v"; break; fi
done
if [ -z "$PY" ]; then
  say "Нужен Python 3.11+, пробую поставить python3.11"
  apt-get install -y -qq python3.11 python3.11-venv >/dev/null 2>&1 && PY=python3.11 \
    || die "в этой системе нет Python 3.11+. Нужна Ubuntu 22.04+ или Debian 12+"
fi
"$PY" -m venv --help >/dev/null 2>&1 || apt-get install -y -qq "${PY}-venv" >/dev/null
say "Python: $($PY --version)"

if ! id faceless >/dev/null 2>&1; then
  say "Создаю отдельного пользователя faceless (ваш Telegram-бот его не касается)"
  useradd -r -m -d "$HOME_DIR" -s /usr/sbin/nologin faceless
fi

if [ -d "$APP/.git" ]; then
  say "Обновляю код"
  runuser -u faceless -- git -C "$APP" pull -q --ff-only
else
  say "Скачиваю код"
  runuser -u faceless -- git clone -q -b "$BRANCH" "$REPO" "$APP"
fi

say "Ставлю Python-библиотеки (пару минут)"
[ -x "$APP/.venv/bin/python" ] || runuser -u faceless -- "$PY" -m venv "$APP/.venv"
runuser -u faceless -- "$APP/.venv/bin/pip" install -q --upgrade pip
runuser -u faceless -- "$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"

chmod 700 "$APP/secrets"
[ -f "$APP/config.toml" ] || runuser -u faceless -- cp "$APP/config.example.toml" "$APP/config.toml"
[ -f "$APP/.env" ] || { runuser -u faceless -- touch "$APP/.env"; chmod 600 "$APP/.env"; }

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 1800 ] && [ "$SWAP_MB" -lt 512 ] && [ ! -f /swapfile ]; then
  say "Памяти ${MEM_MB} МБ — добавляю swap 1 ГБ, чтобы рендер не уронил бота"
  if fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none; then
    chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile \
      && echo '/swapfile none swap sw 0 0' >> /etc/fstab \
      || { rm -f /swapfile; echo "  (swap включить не удалось — на некоторых VPS он запрещён, это не критично)"; }
  fi
fi

say "Ставлю команду faceless и таймеры автозапуска"
cat > /usr/local/bin/faceless <<EOF
#!/bin/sh
# Обёртка: запускает faceless от пользователя faceless в папке проекта
if [ "\$(id -u)" -ne 0 ]; then exec sudo "\$0" "\$@"; fi
cd "$APP" || exit 1
exec runuser -u faceless -- "$APP/.venv/bin/python" -m faceless "\$@"
EOF
chmod 755 /usr/local/bin/faceless
cp "$APP"/deploy/faceless-*.service "$APP"/deploy/faceless-*.timer /etc/systemd/system/
systemctl daemon-reload 2>/dev/null || true

FREE_GB=$(df -BG --output=avail "$HOME_DIR" | tail -1 | tr -dc '0-9')
say "Готово! Свободно на диске: ${FREE_GB} ГБ"
[ "${FREE_GB:-0}" -ge 3 ] || echo "  Внимание: места мало, нужно хотя бы 3 ГБ."
cat <<'EOF'

Дальше (подробно — в ИНСТРУКЦИЯ.md):
  faceless demo                         проверка: соберёт тестовый ролик (2–4 минуты)
  faceless add-background ССЫЛКА        добавить фоновое видео
  faceless setup                        ключи и подключение YouTube
  faceless make -n 1                    первый настоящий ролик
  faceless publish                      загрузить на YouTube
  systemctl enable --now faceless-make.timer faceless-publish.timer    включить автопилот
EOF
