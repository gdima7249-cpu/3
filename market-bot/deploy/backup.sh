#!/bin/sh
# Ежедневная копия истории цен (добавьте в crontab: 10 4 * * * /opt/market-bot/deploy/backup.sh)
# VACUUM INTO делает целостную копию, даже если бот в этот момент пишет в базу.
mkdir -p /opt/backups
OUT="/opt/backups/market-bot-$(date +%F).db"
rm -f "$OUT"
node -e "new (require('node:sqlite').DatabaseSync)('/opt/market-bot/data/bot.db').exec(\"VACUUM INTO '$OUT'\")" 2>/dev/null
find /opt/backups -name 'market-bot-*.db' -mtime +30 -delete
