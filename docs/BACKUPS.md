# Backups

The bot's durable state lives in the `vaporzr-data` Docker volume: queues, presets,
uploads, Spotify/librespot credentials, the Google service-account file, cookies,
tapes and the AMOK memory store. None of it is in git, and none of it can be
rebuilt from the image.

Two copies exist, and they must not be on the same disk:

| Copy | Where | Kept by | Retention |
| --- | --- | --- | --- |
| Local archive | `/opt/backups/vaporzr-data-*.tgz` on the VPS | `deploy/backup.sh` (cron) | 7 newest |
| Off-site snapshot | Any S3-compatible bucket (R2, B2, …) | `deploy/backup-offsite.sh` (called by the same cron) | 7 daily / 5 weekly / 6 monthly |
| Secondary | GitHub Actions artifact | `.github/workflows/backup.yml` | 90 days |

The local archive is for fast restores. It is **not** a backup on its own — the
disk that holds the volume also holds the archives.

## Why the off-site job pushes instead of pulls

The previous off-host copy was the GitHub workflow above, which SSHed into the
VPS. GitHub's runner IPs could not reach port 22 (fail2ban or the Hetzner
firewall), so every scheduled run failed at `dial tcp …:22` and produced no
artifact. Five weeks passed before anyone noticed, and the first thing that
revealed it was the host itself going away.

`backup-offsite.sh` inverts the direction: the VPS pushes to a bucket. Nothing
needs inbound access, there is no IP allowlist to maintain, and the repository is
incremental, so a nightly run uploads only what changed.

## Setup

1. Create the bucket and an access key (R2: *Object Read & Write* on that bucket;
   B2: an application key scoped to it).

2. On the VPS:

   ```sh
   install -m 755 deploy/backup-offsite.sh /opt/vaporzr/backup-offsite.sh
   install -m 600 deploy/backup.env.example /etc/vaporzr/backup.env
   $EDITOR /etc/vaporzr/backup.env     # RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_*
   /opt/vaporzr/backup-offsite.sh      # first run initialises the repository
   ```

3. Add the nightly job, which does the local archive and then the off-site push:

   ```sh
   install -m 755 deploy/backup.sh /opt/vaporzr/backup.sh
   (crontab -l; echo "0 4 * * * /opt/vaporzr/backup.sh >> /var/log/vaporzr-backup.log 2>&1") | crontab -
   ```

4. Confirm it is real, from a machine that is not the VPS:

   ```sh
   RESTIC_REPOSITORY=... RESTIC_PASSWORD=... restic snapshots
   ```

`restic check` runs every night. Run `restic check --read-data` monthly, by hand
or from a second cron line — it reads every pack, so it is the check that catches
silent corruption.

## The passphrase

`RESTIC_PASSWORD` must also live in a password manager and in the repo's secrets.
A restic repository whose passphrase exists only on the host it backs up is not a
backup; it is a backup that dies with its source. (The old workflow had the same
problem with `/opt/vaporzr/backup-passphrase.txt`.)

## Restoring

```sh
# On a fresh host, with Docker installed and the bucket credentials exported:
docker volume create vaporzr-data
docker run --rm -v vaporzr-data:/data \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID \
  -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
  restic/restic:0.17.3 restore latest --target /restore --host vaporzr

# The snapshot contains /data, so copy the contents across:
docker run --rm -v vaporzr-data:/data -v /restore:/restore:ro \
  alpine sh -c 'cp -a /restore/data/. /data/'
```

Then recreate the container with the same `--env-file`, `cookies.txt` mount and
`-v vaporzr-data:/app/data` (`deploy/vps-setup.sh` does exactly this), and check
`/health`.

## Watching it

`/health` reports:

```json
"backup": { "lastBackupAt": "2026-11-17T04:00:12.000Z", "ageHours": 3.4,
            "error": null, "stale": false }
```

The repository URL is deliberately not published there: `/health` is open, and the
URL names the storage account and bucket. Check the destination on the host with
`restic snapshots` instead.

`stale` is true when no snapshot has ever succeeded, or the newest is older than
48 hours (`BACKUP_STALE_HOURS` in `apps/bot/src/backupState.ts`). Point the uptime
monitor at that field — that is the alert that would have caught the five-week gap
on day two.
