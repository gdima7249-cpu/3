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

free_mb() { df -Pm "$1" | awk 'NR==2 {print $4}'; }
ROOT_FREE=$(free_mb /)
NEED_MB=500                                   # программа ~150 МБ + запас под фоны и ролики
command -v ffmpeg >/dev/null || NEED_MB=900   # ffmpeg с зависимостями ещё ~400 МБ
[ -x "$APP/.venv/bin/python" ] && NEED_MB=100   # обновление уже установленной программы: нужно немного
if [ "$ROOT_FREE" -lt "$NEED_MB" ]; then
  printf '\n\033[1;31mНа диске свободно всего %s МБ, а нужно минимум %s МБ.\033[0m\n' "$ROOT_FREE" "$NEED_MB"
  echo "Что занимает место:"
  du -xh --max-depth=1 / 2>/dev/null | sort -h | tail -8
  echo
  echo "Освободить место безопасно можно так (бот это не затронет):"
  echo "  apt-get clean; journalctl --vacuum-size=50M; rm -rf /root/.cache/pip /opt/faceless/.cache"
  echo "Потом запустите установку ещё раз. Если не помогло — пришлите вывод этих команд."
  exit 1
fi

say "Ставлю системные пакеты (ffmpeg, python, git, шрифты)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ffmpeg git python3 python3-venv fonts-dejavu-core fontconfig ca-certificates curl >/dev/null
apt-get clean

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
# /tmp на дешёвых VPS часто крошечный — распаковываем на основной диск и без кэша
export TMPDIR="$HOME_DIR/tmp" PIP_NO_CACHE_DIR=1
mkdir -p "$TMPDIR" && chown faceless: "$TMPDIR"
rm -rf "$HOME_DIR/.cache/pip"
[ -x "$APP/.venv/bin/python" ] || runuser -u faceless -- "$PY" -m venv "$APP/.venv"
runuser -u faceless -- env TMPDIR="$TMPDIR" PIP_NO_CACHE_DIR=1 "$APP/.venv/bin/pip" install -q --upgrade pip
runuser -u faceless -- env TMPDIR="$TMPDIR" PIP_NO_CACHE_DIR=1 "$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt" \
  || die "библиотеки не установились. Пришлите вывод команды: df -h"
rm -rf "$TMPDIR"/*

chmod 700 "$APP/secrets"
[ -f "$APP/config.toml" ] || runuser -u faceless -- cp "$APP/config.example.toml" "$APP/config.toml"
[ -f "$APP/.env" ] || { runuser -u faceless -- touch "$APP/.env"; chmod 600 "$APP/.env"; }

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
# Недописанный swap-файл от неудачной попытки съедает диск — убираем, если он не подключён
if [ -f /swapfile ] && ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  rm -f /swapfile
fi
if [ "$MEM_MB" -lt 1800 ] && [ "$SWAP_MB" -lt 256 ] && [ ! -f /swapfile ]; then
  # swap берём из свободного места, но оставляем минимум 700 МБ запаса: диск не должен забиваться под завязку
  FREE_NOW=$(free_mb /)
  SWAP_SIZE=0
  [ "$FREE_NOW" -ge 1200 ] && SWAP_SIZE=256
  [ "$FREE_NOW" -ge 2200 ] && SWAP_SIZE=512
  if [ "$SWAP_SIZE" -gt 0 ]; then
    say "Памяти ${MEM_MB} МБ — добавляю swap ${SWAP_SIZE} МБ, чтобы рендер не уронил бота"
    if { fallocate -l "${SWAP_SIZE}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_SIZE" status=none; } \
       && chmod 600 /swapfile && mkswap -q /swapfile >/dev/null && swapon /swapfile; then
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    else
      swapoff /swapfile 2>/dev/null || true
      rm -f /swapfile
      echo "  (swap включить не удалось — на некоторых VPS он запрещён, это не критично)"
    fi
  else
    echo "  Диск маленький (свободно ${FREE_NOW} МБ), swap не добавляю. Ролики будут собираться по одному."
  fi
fi

say "Ставлю команду faceless и таймеры автозапуска"
cat > /usr/local/bin/faceless.new <<EOF
#!/bin/sh
# Обёртка: запускает faceless от пользователя faceless в папке проекта
if [ "\$(id -u)" -ne 0 ]; then exec sudo "\$0" "\$@"; fi
if [ "\$1" = "autopilot" ]; then
  case "\$2" in
    on)  systemctl enable --now faceless-make.timer faceless-publish.timer faceless-bot.service && echo "Автопилот включён." ;;
    off) systemctl disable --now faceless-make.timer faceless-publish.timer faceless-bot.service && echo "Автопилот выключен." ;;
    run) systemctl reset-failed faceless-make.service 2>/dev/null
         if systemctl is-active --quiet faceless-make.service; then echo "Сборка уже идёт."
         else systemctl start --no-block faceless-make.service; fi
         echo "Сборка идёт в фоне (на слабом сервере каждый ролик займёт 2-5 минут)."
         echo "Ниже живой ход работы. Выйти из просмотра: Ctrl+C (сборка при этом продолжится)."; echo
         exec journalctl -fu faceless-make -n 0 -o cat ;;
    log) journalctl -u faceless-make -n 60 --no-pager -o cat ;;
    *)   systemctl is-active faceless-bot.service | sed 's/^/Telegram-бот: /'; systemctl list-timers 'faceless-*' --no-pager ;;
  esac
  exit
fi
cd "$APP" || exit 1
exec runuser -u faceless -- "$APP/.venv/bin/python" -u -m faceless "\$@"
EOF
chmod 755 /usr/local/bin/faceless.new && mv -f /usr/local/bin/faceless.new /usr/local/bin/faceless
# старый опрос раз в 2 минуты заменён службой faceless-bot (иначе они подерутся за сообщения)
systemctl disable --now faceless-telegram.timer faceless-telegram.service 2>/dev/null || true
rm -f /etc/systemd/system/faceless-telegram.timer /etc/systemd/system/faceless-telegram.service
cp "$APP"/deploy/faceless-*.service "$APP"/deploy/faceless-*.timer /etc/systemd/system/
systemctl daemon-reload 2>/dev/null || true
# Автопилот включается сразу; пока нет ключей, запуски тихо пропускаются (см. ExecCondition в юнитах)
systemctl enable faceless-make.timer faceless-publish.timer faceless-bot.service 2>/dev/null \
  && systemctl start faceless-make.timer faceless-publish.timer 2>/dev/null \
  && systemctl restart faceless-bot.service 2>/dev/null \
  || echo "  (systemd недоступен: автозапуск включите вручную, когда сможете)"

say "Готово! Свободно на диске: $(free_mb "$HOME_DIR") МБ"
FREE_MB=$(free_mb "$HOME_DIR")
[ "$FREE_MB" -ge 400 ] || echo "  Внимание: осталось ${FREE_MB} МБ. Фоновых видео добавляйте не больше 3, они сжимаются автоматически."
cat <<'EOF'

Дальше (подробно — в ИНСТРУКЦИЯ.md):
  faceless setup --keys                 ключ Gemini и подключение Telegram/YouTube (один раз)
  faceless autopilot run                собрать ролики прямо сейчас
  faceless status                       что настроено и что в очереди
  faceless doctor                       самопроверка, если бот молчит
Автопилот уже включён: как только появится ключ Gemini, ролики будут собираться сами.
EOF
