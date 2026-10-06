# Установка на дешёвый VPS (рядом с Telegram-ботом)

Рассчитано на минимальный сервер: 1 ядро, 1 ГБ RAM, 10–20 ГБ диска, Ubuntu/Debian.
Проверено: ролик на 45–60 с рендерится на одном ядре примерно за 2–4 минуты, ffmpeg занимает около 300 МБ RAM.
Рендер идёт ночью с низким приоритетом, поэтому бот не тормозит.

Сервер в Нидерландах — VPN не нужен: Reddit, YouTube, Claude и ElevenLabs оттуда доступны напрямую.

## 0. Проверить ресурсы

```bash
nproc; free -h; df -h /
```

Нужно: свободно 3+ ГБ диска. Если RAM 1 ГБ и swap нет — добавьте swap (шаг 2).

## 1. Пакеты и код

```bash
sudo apt update
sudo apt install -y ffmpeg python3-venv python3-pip git fonts-dejavu-core fontconfig
sudo useradd -r -m -d /opt/faceless -s /usr/sbin/nologin faceless   # отдельный пользователь, не трогает бота
sudo -u faceless git clone -b claude/busy-mccarthy-bf77na https://github.com/gdima7249-cpu/3.git /opt/faceless/app
```

Если репозиторий приватный, `git clone` спросит логин: вместо пароля введите GitHub-токен
(Settings → Developer settings → Personal access tokens, право `Contents: Read`).
Или скопируйте папку проекта со своего компьютера: `scp -r 3 user@SERVER:/tmp/` и переместите в `/opt/faceless/app`.

Дальше всё делаем в `/opt/faceless/app` — на этот путь уже настроены systemd-юниты из `deploy/`.

```bash
cd /opt/faceless/app
sudo -u faceless python3 -m venv .venv
sudo -u faceless .venv/bin/pip install -r requirements.txt
sudo -u faceless .venv/bin/python -m faceless demo     # проверка: должен появиться output/demo/.../part1.mp4
```

> Python нужен 3.11+. На Ubuntu 22.04 и новее он есть из коробки; если `python3 --version` ниже — установите `python3.11-venv`.

## 2. Swap (если RAM ≤ 1 ГБ)

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Настройки и ключи

```bash
sudo -u faceless cp config.example.toml config.toml
sudo -u faceless cp .env.example .env
sudo -u faceless nano .env          # REDDIT_*, ANTHROPIC_API_KEY, при желании ELEVENLABS_API_KEY
sudo chmod 600 .env
```

В `config.toml` для слабого сервера уже стоят `preset = "veryfast"`, `threads = 1`,
`delete_after_upload = true` (mp4 удаляется после загрузки).

## 4. Фоновые видео

Залейте со своего компьютера 2–3 фоновых ролика по 5–10 минут (720p достаточно — меньше нагрузка и место):

```bash
scp bg1.mp4 bg2.mp4 user@SERVER:/tmp/
# на сервере:
sudo mv /tmp/bg*.mp4 /opt/faceless/app/assets/backgrounds/ && sudo chown faceless: /opt/faceless/app/assets/backgrounds/*
```

## 5. Авторизация YouTube (один раз, через SSH-туннель)

Положите `client_secret.json` (Google Cloud → OAuth client «Desktop app») в `secrets/`.
На **своём компьютере** откройте туннель:

```bash
ssh -L 8765:localhost:8765 user@SERVER
```

В этой SSH-сессии:

```bash
cd /opt/faceless/app && sudo -u faceless .venv/bin/python -m faceless auth-youtube
```

Скрипт напечатает ссылку — откройте её в браузере **на своём компьютере**, войдите в нужный Google-аккаунт
и выберите канал. Google вернёт вас на `localhost:8765`, туннель передаст ответ на сервер, токен сохранится в
`secrets/youtube_token.json`.

## 6. Пробный прогон

```bash
sudo -u faceless .venv/bin/python -m faceless candidates
sudo -u faceless .venv/bin/python -m faceless make -n 1
sudo -u faceless .venv/bin/python -m faceless publish --dry-run
sudo -u faceless .venv/bin/python -m faceless publish
sudo -u faceless .venv/bin/python -m faceless status
```

Проверьте ролик в YouTube Studio: он должен быть «Запланирован» на ближайший слот.

## 7. Автозапуск

```bash
sudo cp deploy/faceless-*.service deploy/faceless-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now faceless-make.timer faceless-publish.timer
systemctl list-timers | grep faceless
journalctl -u faceless-make -n 50      # логи сборки
journalctl -u faceless-publish -n 50   # логи загрузки
```

В юнитах стоят `Nice=15`, `CPUWeight=20`, `IOWeight=20`: если бот и рендер работают одновременно,
процессор и диск в первую очередь достаются боту.

## Обновление

```bash
cd /opt/faceless/app && sudo -u faceless git pull && sudo -u faceless .venv/bin/pip install -r requirements.txt
```
