# Running the webhook mode at boot, unattended

This directory makes the multi-repo webhook mode (`src/provisioning-webhook/`) come up on
its own when an EC2 instance boots, in the right order, and refuse to come up at all when
something is missing.

It does not touch the runner mode (`src/provisioning/`) or the single-repo demo (`setup.sh`).

## What runs, and what only has to be installed

| | what it is | how it runs |
| --- | --- | --- |
| `cloudflared` | the public address GitHub posts to | long-lived, `hermes-tunnel.service` |
| `receiver.mjs` | listens on `127.0.0.1:$WEBHOOK_PORT`, dispatches | long-lived, `hermes-receiver.service` |
| `hermes` | orchestrates one review | **not a service.** Spawned per delivery |
| `claude` | reads the code, writes the fix | **not a service.** Spawned by `hermes` |

`hermes` and `claude` are CLIs invoked per `/review`. Nothing keeps them running. What
matters is that they are installed, configured and logged in *before* the receiver accepts
its first delivery — which is what the preflight is for.

## The chain

```
hermes-preflight.service   oneshot   is this machine fit to serve?
        |  Requires + After
hermes-tunnel.service      always    cloudflared, publishes a url into .tunnel.json
        |  ExecStartPost fires ------> hermes-webhook-sync.service  oneshot
        |                              re-points every GitHub hook at that url
        |  Wants + After
hermes-receiver.service    always    node src/provisioning-webhook/receiver.mjs
```

Four decisions in there are worth knowing about, because each one is a bug if reversed.

**The preflight gates everything.** `Requires=` + `After=`, so a failed check leaves the
tunnel and the receiver `inactive dead`, not "running and quietly useless". A revoked token
or an unconfigured hermes stops the machine at boot, where someone will see it, instead of
at 3am on a pull request nobody is watching.

**The tunnel is cloudflared itself, not a wrapper.** `ops/tunnel-run.sh` ends in `exec`, so
the process systemd supervises *is* cloudflared: `Restart=always` restarts the real thing
and `$MAINPID` is real. `src/provisioning-webhook/tunnel-lifecycle.mjs` is unchanged and
still works by hand; it double-forks into the background, which is right for a shell you are
going to close and wrong under a supervisor. `ops/tunnel-ready.sh` writes the same
`.tunnel.json` that script would have written, so `tunnel-lifecycle.mjs url|status`, the web
console and `sync-repos.mjs` all keep working and cannot tell the difference.

**The webhook refresh is triggered by the tunnel, not by the boot order.**
`cloudflared tunnel --url` is a *quick* tunnel: Cloudflare issues a brand new
`<random>.trycloudflare.com` on every single start. After a crash, a restart or a reboot the
tunnel is at a new address and every webhook GitHub holds points at a hostname that no longer
resolves. GitHub does not tell anyone; it records failed deliveries nobody reads. So the
refresh has to run after *every* start of the tunnel, and an ordinary `Wants=`/`After=`
dependency only fires once at boot. `ExecStartPost` fires on automatic restarts too, which is
why it lives there. Measured on a real crash: the url rotated and the hooks were re-pointed
within seconds, with no human in the loop.

**A tunnel restart does not touch the receiver.** The receiver has `Wants=` on the tunnel,
deliberately not `Requires=`. `Requires=` propagates restarts, and it was observed stopping
the receiver every time cloudflared came back — which would destroy a review in flight, up to
forty minutes of hermes and claude work, because of a ten-second blip in something the
receiver does not even talk to. The receiver listens on loopback and does not care what the
tunnel's address is.

## `--user`, not a system service

These are `systemd --user` units running as an ordinary login user, and they need
**lingering** enabled to start at boot.

The reason is `hermes` and `claude`. Both keep their state in the home directory
(`~/.hermes`, `~/.claude/.credentials.json`) and both are logged in interactively, once, by a
human. A system unit would have to reproduce `HOME`, the credentials and the PATH of that
human by hand, and every one of those is a silent failure when it drifts. Running as the user
who logged them in means there is nothing to reproduce.

The cost is one command, without which nothing starts at boot:

```bash
sudo loginctl enable-linger $USER
```

Without it the user manager only exists while someone is logged in, and the symptom is the
worst kind: everything works when you ssh in to check, and nothing works at 4am.

## Before the first boot: three things only a human can do

None of these can be automated, and all three are checked by the preflight.

1. **A GitHub PAT.** Classic token with the `repo` scope (fine-grained: Administration and
   Webhooks read/write on the repositories you register). Put it in `.env` as `GITHUB_TOKEN`.
2. **Configure hermes**, as the service user:
   ```bash
   hermes config set model.provider <provider>
   hermes config set model.name <model>
   ```
3. **Log claude in**, as the service user: run `claude` once, interactively, and log in.
   This writes `~/.claude/.credentials.json`. There is no headless equivalent — without it
   the first review opens a browser prompt on a machine with no browser and hangs until the
   forty minute timeout kills it.

## Install

On the instance, as the service user:

```bash
# 1. the checkout, anywhere you like -- nothing here hardcodes a path
git clone <repo> ~/hermes-pr-review && cd ~/hermes-pr-review

# 2. .env, mode 600, never committed. It needs at least:
#      GITHUB_TOKEN, WEBHOOK_MULTI_SECRET, WEBHOOK_PORT
#    WEBHOOK_MULTI_SECRET is deliberately not WEBHOOK_SECRET: setup.sh regenerates that one
#    on every run, which would silently invalidate every hook this mode created.
install -m 600 /dev/null .env && $EDITOR .env

# 3. register at least one repository (writes repos.yml and creates the webhook)
node src/provisioning-webhook/sync-repos.mjs add <owner>/<name>

# 4. check the machine before installing anything
ops/preflight.sh

# 5. render and install the units
ops/install-systemd.sh
sudo loginctl enable-linger $USER
systemctl --user enable --now hermes-webhook.target
```

`ops/install-systemd.sh` renders `ops/systemd/*.in` into `~/.config/systemd/user/`. It
renders rather than symlinks because two things cannot be known until install time and
cannot be expressed in a unit file:

- **where the checkout is.** systemd does not expand variables in `WorkingDirectory=`, so the
  path has to be literal — but it must not be literal *in git*, where it would bake in one
  person's home directory. Every unit carries the resolved path in a comment at the top.
- **where the tools are.** systemd does not read `.bashrc`, `.profile` or nvm's shell hook. A
  service gets a bare PATH. The installer resolves `node`, `cloudflared`, `hermes`, `claude`,
  `git` and `gh` in the shell you run it from and writes their directories into `PATH=`.
  Run it from a shell where those commands work.

That last point has a sharp edge worth stating plainly: **an old distro node will shadow a
new one.** Ubuntu 22.04 ships node 12 in `/usr/bin`, Amazon Linux 2 ships 10, and `/usr/bin`
comes before `~/.nvm` in most PATHs. `node -v` in your shell can say 22 while the service
gets 12. The preflight checks the major version, not just that `node` exists.

## Day to day

```bash
systemctl --user list-units 'hermes-*' --all     # the real state of the whole mode
systemctl --user status hermes-receiver
journalctl --user -u hermes-receiver -f          # reviews as they happen
journalctl --user -u hermes-tunnel -n 50         # cloudflared's own output
journalctl --user -u hermes-preflight -n 40      # why it refused to start
journalctl --user -u hermes-webhook-sync         # when the hooks were last re-pointed

systemctl --user restart hermes-webhook.target   # everything
systemctl --user start hermes-webhook-sync       # re-point the hooks by hand
node src/provisioning-webhook/sync-repos.mjs list # 'stale' = hook is on an old url
```

Logging is journald's job: every process writes to stdout/stderr and systemd takes it from
there. There is no log file to rotate. `.tunnel.log` is the one exception, and it exists only
because `tunnel-lifecycle.mjs` and the web console parse the url out of it.

## Uninstall

```bash
ops/uninstall-systemd.sh
```

Stops, disables and removes the units. It leaves `.env`, `repos.yml`, `webhooks.json` and the
webhooks registered on GitHub alone — it uninstalls the supervision, not the setup. Those
hooks now point at a tunnel that is gone; either re-install, or remove them properly with
`sync-repos.mjs remove <owner>/<name>`. It also leaves any drop-in you added under
`hermes-*.service.d/` in place, since it did not put them there.

## `ops/systemd.env`

Optional, gitignored, absent by default. Every unit reads it with `EnvironmentFile=-`, so it
is the place for per-instance values that should not be in `.env`. It can hold secrets;
never commit it. Anything here wins over `.env`, because both `loadEnv()` in node and
`env_value()` in `ops/lib.sh` let the real environment beat the file.

Most useful for `WEBHOOK_PUBLIC_URL`. Point it at a named cloudflared tunnel with a real DNS
route and the whole rotating-hostname problem above disappears: `sync-repos.mjs` uses that
url instead of the quick tunnel's, and the refresh after every restart becomes a no-op.
That is what to do for anything beyond a prototype.

## The files

| file | what it does |
| --- | --- |
| `preflight.sh` | every check that has to pass before a delivery is accepted |
| `lib.sh` | shared helpers; reads `.env` with exactly `loadEnv()`'s rules, never sources it |
| `tunnel-run.sh` | `exec`s cloudflared (ExecStart of the tunnel unit) |
| `tunnel-ready.sh` | waits for the url, writes `.tunnel.json` (ExecStartPost) |
| `webhook-sync.sh` | `sync-repos.mjs refresh` under a lock |
| `receiver-run.sh` | `exec`s the receiver |
| `receiver-ready.sh` | polls `/healthz` so "started" means "answers" |
| `install-systemd.sh` | renders and installs the units |
| `uninstall-systemd.sh` | stops, disables and removes them |
| `systemd/*.in` | the unit templates |

`.env` is read but never `source`d: it holds a token and an HMAC secret, and a stray backtick
in it must never become a command.
