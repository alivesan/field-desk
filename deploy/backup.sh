#!/bin/sh
# A verified backup of the live data (database + every photo, server/backup.ts) into $FD_BACKUP_DIR/<UTC stamp>,
# keeping the newest $FD_BACKUP_KEEP. Run as root from anywhere: sudo ~/field-desk/deploy/backup.sh
# The systemd timer in deploy/field-desk-backup.timer runs it on Friday and Sunday nights. A backup holds admin codes
# and session hashes, so the folder is root-only.
set -eu
cd "$(dirname "$0")"
DEST="${FD_BACKUP_DIR:-/home/ubuntu/field-desk-backups}"
KEEP="${FD_BACKUP_KEEP:-8}"
stamp=$(date -u +%Y%m%d-%H%M%S)
tmp="/tmp/fd-backup-$stamp"

docker compose exec -T app node server/backup.ts /data "$tmp" >/dev/null
docker compose exec -T app node server/backup.ts --verify "$tmp" >/dev/null
mkdir -p "$DEST"
chmod 700 "$DEST"
docker compose cp "app:$tmp" "$DEST/$stamp" >/dev/null
docker compose exec -T app rm -rf "$tmp"
chmod -R go-rwx "$DEST/$stamp"

# Oldest first; drop all but the newest $KEEP.
ls -1d "$DEST"/*/ | sort | head -n -"$KEEP" | xargs -r rm -rf
echo "backup: $DEST/$stamp ($(du -sh "$DEST/$stamp" | cut -f1)) — $(ls -1d "$DEST"/*/ | wc -l) kept"
