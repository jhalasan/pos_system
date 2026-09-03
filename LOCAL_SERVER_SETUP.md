# Local Server Setup (Mini PC, Self-Hosted PocketBase)

This replaces PocketHost with a self-hosted PocketBase instance running on-premise, to fix
peak-hour rate-limit slowdowns (see `POS_AUDIT_REGISTER.md`). Hardware: Dell OptiPlex 3040 mini
PC, i3 6th gen, 8GB RAM, 120GB SSD — comfortably capable, no resource concerns.

## Architecture (read this before starting)

```
Cashier terminals (Wi-Fi) ──────► Mini PC (LAN, local IP) : PocketBase :8090
                                        │
                                        │  Tailscale Funnel (HTTPS, public)
                                        ▼
                          Vercel web admin + /api/cashier/* proxy routes
```

Two different paths reach the same PocketBase instance, for two different reasons:

- **Terminals talk to the mini PC's local LAN IP directly.** Fast, works even if the shop's
  internet is down, and is what actually fixes the rate-limit problem.
- **Vercel talks to the mini PC through a Tailscale Funnel HTTPS URL**, because Vercel is a public
  cloud service and cannot reach a private LAN address. This bridge is required because four
  desktop cashier features route through Vercel rather than PocketBase directly — manager barcode
  approval (`/api/cashier/manager-approval-hashes`, `/authorize-void`), quick-login account
  listing, and barcode login (`src/cashier-pos/services/desktopApi.js`) — plus the entire remote
  web admin portal. Without this bridge, those four features would keep checking the old PocketHost
  copy after cutover and quietly go stale (new staff/barcodes wouldn't show up there).

**Do not skip the Tailscale section** even though the terminals themselves don't need it — it's
what keeps the whole system pointed at one consistent database instead of two silently diverging
ones.

---

## Part 1 — Install Ubuntu Server

You've already flashed Ubuntu Server 26.04.1 LTS to the USB with Rufus. Boot the mini PC from it
(F2/F10/F12/Del at startup, varies by machine) and run through the installer:

- Language/keyboard: your preference
- Network: it should auto-detect Wi-Fi or Ethernet — connect it here if possible (you can also
  configure it after install)
- Storage: **use the entire disk** with the default layout — no need for manual partitioning on a
  single-purpose server
- Profile setup: pick a username/password you'll remember — this is your SSH login going forward
- **Install OpenSSH server: say YES to this prompt.** You'll want to manage this machine remotely
  from your own PC rather than needing a monitor/keyboard plugged into it every time
- Skip the "featured server snaps" screen (Docker, etc.) — none of it is needed
- Let it finish, reboot, remove the USB when prompted

Once it reboots to a login prompt, you're in.

---

## Part 2 — Basic system setup

Log in locally, or from your own PC via SSH once you know its IP (`ip a` on the mini PC shows
its current address):

```bash
ssh your-username@<mini-pc-ip>
```

Update the system:

```bash
sudo apt update && sudo apt upgrade -y
```

### Give it a fixed local IP

Find your network interface name and current settings:

```bash
ip a
```

Edit the netplan config (filename varies, usually `/etc/netplan/50-cloud-init.yaml` or similar —
check with `ls /etc/netplan/`):

```bash
sudo nano /etc/netplan/50-cloud-init.yaml
```

Example for a static IP on `192.168.1.50` (adjust to match your router's actual subnet and pick
an address outside your router's DHCP range so it never gets handed to another device):

```yaml
network:
  version: 2
  ethernets:      # or wifis: if using the Wi-Fi dongle
    enp1s0:       # replace with your actual interface name from `ip a`
      dhcp4: no
      addresses: [192.168.1.50/24]
      routes:
        - to: default
          via: 192.168.1.1   # your router's IP
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
```

Apply it:

```bash
sudo netplan apply
```

**Alternative, simpler option:** instead of a static IP on the mini PC, reserve its current
DHCP-assigned IP in your router's admin settings (usually under "DHCP reservation" or "static
lease," keyed to the mini PC's MAC address, also shown by `ip a`). Either approach works — pick
whichever your router makes easier.

---

## Part 3 — Install PocketBase

Grab the latest Linux build from PocketBase's releases page (check
`https://github.com/pocketbase/pocketbase/releases/latest` for the current version number and
substitute it below):

```bash
cd ~
wget https://github.com/pocketbase/pocketbase/releases/download/vX.Y.Z/pocketbase_X.Y.Z_linux_amd64.zip
sudo apt install -y unzip
unzip pocketbase_X.Y.Z_linux_amd64.zip -d pocketbase
```

### Run it as a systemd service (auto-start on boot, auto-restart on crash)

```bash
sudo mkdir -p /opt/pocketbase
sudo mv ~/pocketbase/pocketbase /opt/pocketbase/
sudo chmod +x /opt/pocketbase/pocketbase
```

Create the service file:

```bash
sudo nano /etc/systemd/system/pocketbase.service
```

```ini
[Unit]
Description=PocketBase
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/pocketbase
ExecStart=/opt/pocketbase/pocketbase serve --http=0.0.0.0:8090
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`--http=0.0.0.0:8090` (not the default `127.0.0.1:8090`) matters — it makes PocketBase listen on
every network interface, which is what lets both the LAN terminals and, later, Tailscale Funnel
reach it.

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pocketbase
sudo systemctl start pocketbase
sudo systemctl status pocketbase   # confirm it says "active (running)"
```

### Open the firewall for the LAN

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8090   # adjust subnet to match your network
sudo ufw enable   # if not already enabled
```

Now visit `http://<mini-pc-ip>:8090/_/` from any device on the same network — you should see
PocketBase's admin login screen, prompting you to create the first superuser. **Create one now
with a throwaway password** — you'll restore over it in Part 5, and log back in with the real
PocketHost superuser credentials afterward.

---

## Part 4 — Install Tailscale and set up Funnel

This is the bridge that lets Vercel reach this instance. On the mini PC:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

This prints a login URL — open it in a browser (on any device, doesn't have to be the mini PC),
sign in or create a free Tailscale account (the free "Personal" plan covers this — up to 6 users,
100 devices, includes Funnel at no cost).

### Enable Funnel for this device

In the Tailscale admin console (`https://login.tailscale.com/admin`):

1. **DNS page** → enable **HTTPS Certificates** for your tailnet (a one-time toggle, required
   before Funnel works at all)
2. **Access Controls page** → find the **Funnel** section → **Add Funnel to policy** (this adds a
   default policy allowing tailnet members to use Funnel — saves automatically)

Back on the mini PC, expose PocketBase's port through Funnel, running persistently in the
background:

```bash
sudo tailscale funnel --bg 8090
```

Confirm it's active:

```bash
tailscale funnel status
```

This gives you a permanent HTTPS URL, something like:

```
https://mini-pc-name.your-tailnet.ts.net
```

**Write this URL down — it's what Vercel will use as `POCKETBASE_URL`.** Note that port 8090
itself never needs to be opened to the raw internet — Funnel handles the public HTTPS side
entirely through Tailscale's own infrastructure and reverse-proxies internally to `localhost:8090`
on the same machine.

---

## Part 5 — Migrate data from PocketHost (full backup/restore)

Do this **as close to the actual cutover moment as possible** — ideally when both terminals are
between shifts / not actively ringing up sales. Any sale rung up on PocketHost *after* this backup
is taken and *before* the terminals are switched over in Part 7 will not carry over.

1. Log into your **PocketHost** instance's Admin UI (`https://your-instance.pockethost.io/_/`)
2. Go to **Settings → Backups**
3. Create a new backup, then download it once it's ready (a `.zip` of the full database)
4. Log into the **new local instance**'s Admin UI (`http://<mini-pc-ip>:8090/_/`), using the
   throwaway superuser from Part 3
5. Go to **Settings → Backups → Upload backup**, upload the `.zip` from step 3
6. Once it restores, the local instance now has PocketHost's full schema and data — you'll be
   logged out (the session no longer matches the restored data). Log back in using the **real**
   PocketHost superuser credentials — the same ones already in this repo's `.env` as
   `POCKETBASE_SUPERUSER_EMAIL`/`POCKETBASE_SUPERUSER_PASSWORD` — to confirm the restore worked.

---

## Part 6 — Point Vercel at the new server

In Vercel's project settings (Environment Variables), update:

```
POCKETBASE_URL=https://mini-pc-name.your-tailnet.ts.net
```

(the Funnel URL from Part 4 — **not** the local LAN IP, since Vercel can't reach that). Redeploy
for the change to take effect.

Leave everything else in Vercel's env vars as-is (superuser credentials stay the same, since
they're the same account, just now reached through a different URL).

---

## Part 7 — Cut both terminals over together

On **each** cashier terminal's machine, edit `.env.cashier` (or wherever `VITE_POCKETBASE_URL` is
configured for that build):

```
VITE_POCKETBASE_URL=http://<mini-pc-ip>:8090
```

This is the **local LAN IP**, not the Funnel URL — terminals should talk to the mini PC directly
for speed and so checkout keeps working even if the shop's internet connection drops.

Rebuild and redeploy the desktop app on both terminals with this new `.env.cashier`
(`npm run build:cashier` then the Tauri build step per `TAURI_WINDOWS_BUILD.md`), and do this on
**both terminals at the same time** — not one today, one next week. A gap where one terminal
writes to the old PocketHost and the other writes to the new local instance is exactly the kind of
split-brain data problem this whole migration is meant to avoid.

---

## Part 8 — Verify

- Ring up a test sale on each terminal, confirm it appears in the local instance's Admin UI
  (`Settings → Backups` aside, just browse the `sales` collection directly)
- Test a manager-barcode void/refund approval on each terminal — this exercises the Vercel →
  Funnel → mini PC path end-to-end
- Log into the remote web admin (Vercel) and confirm today's test sales show up there too
- Only after this all checks out: **do not cancel or downgrade PocketHost yet** — per the earlier
  decision, keep it running untouched as a safety net until you're fully confident, then revisit
  cancelling it later.

---

## Ongoing: backups on the mini PC

PocketBase's own `Settings → Backups` page can create backups on a schedule, but they're stored on
the same disk by default — not useful if the SSD itself fails. At minimum, periodically download a
backup `.zip` from the local instance's Admin UI and copy it somewhere off the mini PC (a USB
drive, cloud storage, etc.). A proper automated off-device backup schedule (e.g., a cron job that
copies the nightly backup to cloud storage) is worth setting up once the migration itself is
stable — flag this back to Claude in a future session if you want that built out.

---

## Troubleshooting

- **Terminal can't reach the mini PC**: confirm both are on the same network, `ping <mini-pc-ip>`
  from the terminal, check `sudo ufw status` on the mini PC allows port 8090 from the terminal's
  subnet.
- **Vercel can't reach the mini PC**: confirm `tailscale funnel status` still shows it active on
  the mini PC (it can drop after a reboot unless re-run — consider adding `tailscale funnel --bg
  8090` to a startup script, or check Tailscale's docs on making Funnel persist across reboots).
- **PocketBase service won't start**: `sudo systemctl status pocketbase` and
  `sudo journalctl -u pocketbase -n 50` for the actual error.
- **Restore says data.db not found / fails**: the uploaded file must be the exact `.zip` PocketBase
  itself generated from Settings → Backups, not a manually re-zipped `pb_data` folder.
