#!/bin/sh
# Ежедневная копия базы (добавьте в crontab: 0 4 * * * /opt/tracker-bot/deploy/backup.sh)
mkdir -p /opt/backups
cp /opt/tracker-bot/data/bot.db "/opt/backups/bot-$(date +%F).db"
find /opt/backups -name 'bot-*.db' -mtime +14 -delete
