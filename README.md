# hermes-pr-review

AI code review on your pull requests. Runs on your machine. No SaaS.

You comment `/review`. It answers on the exact lines.

## Try it

```bash
gh repo create my-sandbox --template iFeyz/hermes-pr-review --public --clone
cd my-sandbox
./setup.sh
```

Then comment `/review` on the pull request it opened.

That pull request has **3 real bugs planted in it**. See how many come back.

**Using an AI to set this up?** Point it at [AGENTS.md](AGENTS.md). It has the exact steps, the
failures you will hit, and what not to do.

## The three commands

| You type | It does |
| --- | --- |
| `/review` | reads the diff, runs your tests, comments on the lines |
| `/fix` | writes the smallest fix, tests it, pushes it |
| `/revert` | undoes that commit |

You get a 👀 within a second, so you know it was seen.

## How it works

![sequence](https://www.plantuml.com/plantuml/png/ZLRBSjis5DtZAr1gaOtrZcHBez74rYDUPDfCqbtTwK3a9GcR15WyvAQP_4kMqNVentf1WWfbKpDTYSGvk8zp7-8xRPWoDi_8BoQ576YHCIw8VkAYO8hbTCV2fqH9AwALpAIYdS5wE1nUDnWHnCncPYk5-PMXXNl8zc1uoDevd_c_G8UJ1gXJ5ibdBX8Qiqn34u6_BOWGw5T2wQrIyja7CRcvdMwtzQ4pwu7LR3rSpn3um6Fum0NSIHM1ykXuC9wErqtqPNR3wV1kD4B6HvI5XxnWmlm_KgkV1g4Hv6QwMM_7h-5Q6amhD59Tzbl1JO-ZpUtWxRY6sdozHql5AvEZuMWwMfzW6Nsvkr3m4wKjpnAwwFKU6DvfWzTypn6wd6bDQFNgmORXw_NDP3OWtnez9AIf-kUoatRhhyrMPrMLnkY466uoe0kD9_FHQBa87Ntkqrj-Whq56hsn0iVAPXbLhfsrkQAHfQ7CSn26SGMKkLUb83GyNlHB8yj5trbTFWX2c2if3TR7mnuoMHHWLK2Png7Qa-9d1z7WFJVtTbTYINeEOLjmAVI3K5O8gEvNZ-UyUr0vw19EoyTpMC6UmtDFfoL3XueNvfonofYDWAva12KdBD_FEGatgTtryiVAKI6rmJW8iqOAc-y0artibdyC1dy6X62MjBl4XEYy5Wre4FIhK8A0889ubGnoKANZ3m6EXpIkjOM__3qaUrfjC0W-_lRvTzhhzT0UgpH2LjapYYUfeJAkJVj-cLCMXbOV3wW_pR1cLi63045poONsvTOGIe5fD_nLSfO-8wuBPiBKAK37RsVqb8iBOS_GkMTtXjlfTdD7Y7z7EvNefPqTqodLAkoVodB1ch_J6OrlfkCf8VxzfmhuKoWQyJXs5fnEW7c9wiGA7lFZuOKgjSrQ5NKyXBOu7l2Nfb9fr-IvZ8u_ChXw48yiPrnJ_7FHJhhZTvgzOGdMf1bCrIjbGFwnMz1kj-HHgS8KXqSn78PcRfxPkPbDhZSJGjo85tI5WY7VAdr5iJPk5MIPYmM7kBRTSEZ7Ju3MxGGig5NSVBc0yWn3xCQCPzWD14H4sbXFKE0GN3cfOkj2Jnak15fmxF-s2uysIW2tnV4GIRlB9BOI1UDmhLrlLJKAWfYB2Fy-TUzHIu7QHF12dHCN_k663fe4FyED1gl6iMgBqw2MfxutJdSzixCUpMQuIFthYzdgkzMd-tZLjwaRi0jK_1WnLeFkVyLlWc_dcTHRed7aDvJV06vHpC_sAXO-uub02RLD4cmU7EyhL1t29qBUOPNSTyz_)

Two brains:

- **Hermes** dispatches and publishes. Never reads code.
- **Claude Code** does the work. Reads the diff, opens files, runs tests.

Separate accounts, so neither eats the other's quota.

## Why it does not spam you

![pipeline](https://www.plantuml.com/plantuml/png/fLNDRXCn4BxlKmpYq5OKsYHjMf9IMff42264L10N9EHwPpT3l7RgdvIVyYuSoOKNuBWlnjX9O4LJE71RpOpd-nbxziHvONseL7R7Zx52c2f1EdCJqbDXHGKNGavAQuBEpumo5kxk3bgjra6Z8iT21EL7HliNWZiyHJL3JrAihpcdJmYj_KRIZKLkhaYNK0Zbi94vjTPSBN4F1eVx3tV_JCQE_onOG7OQAI4zpSX_XCyPm9C_9RQwhIVjTimOcwDTHZkxdMvdmD46vh0x78mw71kGg8pERxHgjzhTzg1HiBRZChckyNcSpwhPy7HtBmQ7l_gF3lTRUm-JY5NN_SFJxcYKVMawV4ML4XfVaLTu6yTRoc-I-alXmkc3DINhXD-iUaEv7qFdi3b6RJp-xvoMTsCHMrs7Brdc8t4uSXpfjTl7HpAMzvP2Zv_pSw0fAjB8DnWipW9knoybEE6ObWWWJLMXze8i7ksayyT7Ex7XyLkTPTTdOxHoZC6wwoozjQmmTi9CUj9OYz9hTAwVWY3A-FOuvL06ozVpHfmKGzql1AbWiP-XpY6rwoKw3gJGEUM2F_kCVIvnwkaou7NMCs5coGAhbIPggUUe-XaLi1bO7NUD4SvfQUjlFadCwxbaF6OFZxU0ruE6JMtqLcJo7ZtQFd-bwLWgnxun3xxHGhi8bflWsJDIm2SyFaZ9rup8-y0vDb2XzH6t_k7ZyWakLJ2cXSkm4JIOSA4edejY8zhYCqDU5R1f0YK-BbomkzeJgzW6CKCP5SYngBypsAoUMofYBdb61PlpB9JH5nQPHmYZTHJKS_KyLVjw3YeWkC2cRL0rvPK1mPCYn_O6k_2EULQaWOzV1aR_xTEA5sVa9AwsH-1jYF29zif6zjlnNXIUYXMp7c_W8h61-YjKuiExWZYXopJIbz4DoVL6NoS6h59HoHfbfCoJT1xobVbK5BUCRdjvYlICPv-CMMThutA3Y5TZ3lVOah9a6ARmYpFx82V0RxDanmXMghTXnkFbY8wrpfjfbftmaVY_-Ga0)

- **3 finders** raise anything suspicious
- **1 skeptic** opens the real code and tries to kill each one. When unsure, it kills.
- **1 judge** dedups, ranks, caps

Severity is read off one sentence: what a user sees when it breaks. Not off how loudly it fails.

Target is **1 or 2 findings** on a normal pull request.

## Settings

One file, `review.config.yml`:

| Key | What it changes |
| --- | --- |
| `model` | `claude-opus-5[1M]` reads deeply. `claude-sonnet-5` is 4x faster. |
| `agents` | remove one, it stops looking for that |
| `paths.blocking` | a must-fix here turns the check red |
| `skeptics` | set to 3 and a finding needs a majority to survive |
| `max_findings` | hard cap |

## What it costs

| | |
| --- | --- |
| Time | 15 min on 350 lines. It reads, it does not skim. |
| Orchestration | a few cents per review |
| The rest | your existing Claude plan |

## What you need

`node` · `gh` · `cloudflared` · `hermes` · `claude`

`setup.sh` tells you which are missing and prints the install command.

No API key anywhere. Both sides run on subscription logins.

## On your own repo

```bash
REPO=you/your-project SKIP_DEMO=1 ./setup.sh
```

The webhook is removed when you stop the script. Nothing is left behind.

## Make the bot post, not you

GitHub will not let you request changes on your own pull request. So in the mode above, reviews land as plain comments.

Want `github-actions[bot]` to post instead:

1. Clone this repo on the machine that will run it. hermes and claude logged in there.
2. Register a runner on your repo with the label `hermes-review`.
3. Copy `workflow/review.yml` into `.github/workflows/`, on the **default branch**.
4. Set repo variables `HERMES_PROVIDER` and `HERMES_MODEL`.

Costs a self-hosted runner. Gets you change requests and a bot identity.

## Many repositories, one machine

The mode above, done once per repository, from a page on `localhost`.

The trick is that nothing is duplicated. `review.sh` clones each target repository on demand
into `.work/`, so **one checkout of this repository serves them all**. What is per repository is
the runner process, because a self-hosted runner registers against a single repository.

```
repos.yml ──▶ sync-repos.mjs ──▶ HERMES_PROVIDER / HERMES_MODEL set as repo variables
                              ├─▶ runners/<owner>-<name>/run.sh, label hermes-review
                              └─▶ workflow committed on the default branch, last
```

Every runner carries the same `hermes-review` label and every job `cd`s into this same checkout.

### The token

One classic PAT, scopes **`repo` and `workflow`**. `workflow` is not optional: GitHub refuses
any write to `.github/workflows/` from a token without it. You must also be **admin** on each
repository, that is what mints a runner registration token.

Fine-grained equivalent: Contents, Workflows, Variables and Administration, all read/write.

```bash
cp .env.example .env
$EDITOR .env      # GITHUB_TOKEN, and HERMES_PROVIDER / HERMES_MODEL if you use them
```

`.env` is gitignored. The token is never logged, never passed to a review job, and never
written into a runner directory.

### Start it

```bash
node web/server.mjs      # http://127.0.0.1:8788
```

Start it from a shell where `node`, `gh`, `hermes` and `claude` are on `PATH`, with `hermes` and
`claude` logged in. A runner keeps the `PATH` it was registered with and hands it to every job.

Type `owner/name`, press **Add repository**. The row goes amber while it works, green when the
runner says it is listening. The first one is the slow one: the `actions/runner` package is
downloaded once, checksum-checked, and unpacked into `runners/_bin/`. Every repository after
that is copied from there.

Each runner is told where this checkout is through `REVIEWER_HOME`, written into its own `.env`.
That is what makes one checkout serve every repository.

Then comment `/review` on a pull request of that repository.

**Remove** takes the workflow file off the default branch, stops the runner and unregisters it.

Same thing without the page:

```bash
node src/provisioning/sync-repos.mjs add owner/name
node src/provisioning/sync-repos.mjs list
node src/provisioning/sync-repos.mjs remove owner/name
node src/provisioning/sync-repos.mjs            # re-check everything, restart runners that died
node src/provisioning/runner-lifecycle.mjs log owner/name
```

`repos.yml` is the registry, `sync-repos.mjs` is its only writer, and every command is
idempotent. Run the bare `sync` after a reboot to bring the runners back up.

### Before you expose it

`web/server.mjs` binds `127.0.0.1` and nothing else. It has no login, and it can reach a token
that writes workflow files on your company repositories, so a workflow file is arbitrary code
execution on this machine. Do not put it on `0.0.0.0`, behind a tunnel, or on a shared host.
Host and Origin are checked to keep a web page you visit from driving it through DNS rebinding.

### Limits of this mode

- One runner process per repository, each with its own copy of the runner package. That is about
  700 MB per repository, plus 220 MB for the cached tarball in `runners/.cache/`.
- Runners are plain background processes, not services. They die with the machine, `sync` brings
  them back. Use systemd if you want them at boot.
- Nothing serialises reviews across repositories, the runners will happily work in parallel.

## Running it unattended

Everything above needs a terminal held open. To have the webhook multi-repo mode come up on
its own at boot — on an EC2 instance nobody logs into — see [ops/README.md](ops/README.md).

It is a set of `systemd --user` units in a chain: a preflight that refuses to start anything
on a machine that would fail later (no PAT, hermes unconfigured, claude not logged in, an old
node shadowing a new one), then cloudflared, then a webhook refresh, then the receiver.

Three things still have to be done by hand, once, before the first boot: mint the PAT,
`hermes config set model.provider`, and log `claude` in. They are interactive or they are
secrets. The preflight checks all three and says so by name when one is missing.

## Limits

- The quick tunnel is ephemeral and capped at 200 concurrent requests. Fine for a sandbox, wrong for production.
- Leave the terminal open. Close it, everything stops. (Unless you install the units in `ops/`.)
- On a very large diff, one pass samples rather than covers.

## Licence

MIT.
