# Backups

The bot's durable state lives in the `vaporzr-data` Docker volume: queues, presets,
uploads, Spotify/librespot credentials, the Google service-account file, cookies,
tapes and the AMOK memory store. None of it is in git, and none of it can be
rebuilt from the image.

Two copies exist, and they must not be on the same disk:

| Copy | Where | Kept by | Retention |
| --- | --- | --- | --- |
| Local archive | `/opt/backups/vaporzr-data-*.tgz` on the VPS | `deploy/backup.sh` (cron) | 4 newest |
| Off-site, option A | S3-compatible bucket (R2, B2, …) | `deploy/backup-offsite.sh` | 7 daily / 5 weekly / 6 monthly |
| Off-site, option B | GitHub Release asset, encrypted | `deploy/backup-github.sh` | newest 6 |
| Secondary | GitHub Actions artifact | `.github/workflows/backup.yml` | 90 days |

The local archive is for fast restores. It is **not** a backup on its own — the
disk that holds the volume also holds the archives. At least one off-site target
must be configured; `backup.sh` says so loudly when neither is.

## What is and is not in the archive

The exclusion list is a single file, `deploy/backup-excludes.txt`, read by both
`backup.sh` and `restore-drill.sh`. It is deliberately short — only rebuildable
caches:

| Excluded | Why |
| --- | --- |
| `go-librespot/` | ~1.1 GB of Spotify audio cache, refetched on demand |
| `video-cache/` | ~1.7 GB of YouTube fragments, refetched on demand |
| `hf/` | ~81 MB of HuggingFace model weights (Demucs), re-downloaded when needed |
| `tmp/`, `backup-state.json`, `backup-last-error.txt` | working files |

Everything else is state someone would miss, including the two that used to be
excluded and should not have been:

- **`decks/`** — every server's custom decks. Small JSON, user-authored, and
  impossible to reconstruct. It was silently absent from every backup until the
  restore drill compared the archive against the live volume.
- **`stems/`** — ~225 MB of separated vocals/instrumentals produced by Replicate
  and paid for per run. Losing them means paying again, so they are backed up.

Because stems roughly double the archive (~260 MB → ~485 MB), the local
retention is four archives rather than seven. The off-site copy is the one that
matters if the disk goes away, and its retention is set by the target.

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

Both off-site targets are driven by the same `deploy/backup.sh` cron. Install the
scripts once:

```sh
install -m 755 deploy/backup.sh            /opt/vaporzr/backup.sh
install -m 644 deploy/backup-excludes.txt  /opt/vaporzr/backup-excludes.txt
install -m 755 deploy/backup-offsite.sh    /opt/vaporzr/backup-offsite.sh   # option A
install -m 755 deploy/backup-github.sh     /opt/vaporzr/backup-github.sh    # option B
install -m 755 deploy/restore-drill.sh     /opt/vaporzr/restore-drill.sh
install -m 600 deploy/backup.env.example   /etc/vaporzr/backup.env
$EDITOR /etc/vaporzr/backup.env
(crontab -l; echo "0 4 * * * /opt/vaporzr/backup.sh >> /var/log/vaporzr-backup.log 2>&1") | crontab -
```

### Option A — restic to an S3-compatible bucket

Best automation: incremental, deduplicated, encrypted, prunable. Create the
bucket and an access key (R2: *Object Read & Write* on that bucket; B2: an
application key scoped to it), then set `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`
and the `AWS_*` values. First run initialises the repository; `restic check` runs
every night.

Verify from a machine that is not the VPS:

```sh
RESTIC_REPOSITORY=... RESTIC_PASSWORD=... restic snapshots
```

Run `restic check --read-data` monthly, by hand or from a second cron line — it
reads every pack, so it is the check that catches silent corruption.

### Option B — GitHub Release asset (no payment method)

Every worthwhile S3 free tier (R2, B2) asks for a card on file even at zero spend.
This path needs none:

1. Create a **private** repo, e.g. `vaporzr-backups`. It holds only ciphertext.
2. Create a token with write access to it (classic: `repo` scope; fine-grained:
   *Contents → Read and write*).
3. Set `GH_BACKUP_REPO=owner/vaporzr-backups` and `GH_BACKUP_TOKEN=…`.

The job encrypts the newest local archive with `BACKUP_PASSPHRASE_FILE`
(`/opt/vaporzr/backup-passphrase.txt` by default), uploads it to a single rolling
release tagged `backup-rolling`, and deletes all but the newest six assets.
Requires `curl`, `openssl`, `python3` — all present on Debian/Ubuntu.

The trade against option A: no dedupe, so each run uploads a full ~260 MB blob,
and retention is a raw asset count rather than a policy.

### Heartbeat (both options)

Set `BACKUP_HEALTHCHECK_URL` to a check URL from healthchecks.io (free, no card):
the script pings it on success and `<url>/fail` on failure. A missing ping is what
tells you the job stopped — including when the host is gone, which is exactly when
`/health` cannot answer. Configure the check for a 24-hour period with a ~2-hour
grace.

## The passphrase

`RESTIC_PASSWORD` must also live in a password manager and in the repo's secrets.
A restic repository whose passphrase exists only on the host it backs up is not a
backup; it is a backup that dies with its source. (The old workflow had the same
problem with `/opt/vaporzr/backup-passphrase.txt`.)

## Restoring

### From a restic bucket (option A)

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

### From a GitHub release asset (option B)

Needs the asset and the passphrase, nothing else:

```sh
gh release download backup-rolling --repo owner/vaporzr-backups \
  --pattern 'vaporzr-data-*.tgz.enc' --dir .

openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass file:./backup-passphrase.txt \
  -in vaporzr-data-*.tgz.enc -out vaporzr-data.tgz

docker volume create vaporzr-data
docker run --rm -v vaporzr-data:/data -v "$PWD:/restore:ro" alpine \
  sh -c 'tar xzf /restore/vaporzr-data.tgz -C /data'
```

Then recreate the container with the same `--env-file`, `cookies.txt` mount and
`-v vaporzr-data:/app/data` (`deploy/vps-setup.sh` does exactly this), and check
`/health`.

## The restore drill

A backup nobody has restored is a belief. Run the drill monthly, and after any
change to the exclusion list:

```sh
install -m 755 deploy/restore-drill.sh     /opt/vaporzr/restore-drill.sh
install -m 644 deploy/backup-excludes.txt  /opt/vaporzr/backup-excludes.txt
/opt/vaporzr/restore-drill.sh
```

It downloads the newest asset from the off-site target (so it also proves the
token works and the upload is readable), decrypts it with the passphrase the
nightly job uses, checks the gzip, extracts to scratch space, parses every JSON
file, and then compares against the live volume: every live state file that
existed when the snapshot was taken must be present in the restored tree. Nothing
on the running bot is touched — no volume is overwritten, no second process
connects to Discord.

`RESTORE_DRILL_KEEP=1` leaves the extracted tree at `/var/tmp/restore-drill` for
inspection.

The completeness step is the one that earns its keep. Integrity checks passed
happily while `decks/` — every server's custom decks — was missing from every
archive; only comparing the restore against the live volume found it.

Verified on 2026-11-19 against `vaporzr-data-20261119-0400.tgz.enc`
(sha256 `63774281…625327`): decrypted, extracted 337 MB / 109 files, 58/58 JSON
files valid. The same run reported 44 missing state files, which is how the
`decks/` and `stems/` exclusions were found and removed.

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
