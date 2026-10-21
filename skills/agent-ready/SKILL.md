---
name: agent-ready
description: "Check whether an AI agent can find, sign up for, get a key to, use and pay for a product without a person, using the agent-ready CLI. Reads public pages only and writes one fix prompt per gap. Use when the developer asks if agents can sign up for or use their product, asks about agent readiness, agent onboarding, llms.txt or agent signup, or wants to re-check after a fix. Also use when they ask to run agent-ready test: this skill says how to start it safely."
---

# agent-ready check

`npx @tansohq/agent-ready check <url>` reads a product's public pages with GET requests, shows seven steps (Discover, Understand, Sign up, Access, Use, Pay, Manage) and writes a fix prompt for each gap. It submits nothing to the product, creates no account and costs nothing (it writes only `agent-ready.yml` and a run folder), so you may run it whenever the developer asks about their product. After the seven steps it runs the aeo-ready standards catalog (five third-party benchmarks, about 125 checks of the public surface: llms.txt, MCP and A2A cards, x402, content negotiation and more). That part sends the product's URL to two benchmark services, Cloudflare's isitagentready.com and AgentGrade's, spawns `npx` and takes usually 1-3 minutes, up to 15 on a large site; `--no-standards` skips it when the developer wants only the seven steps, fast, or does not want the URL sent anywhere.

## If the developer asks for a test

Do not run `check` in its place, and do not run `test` from this skill. Explain in one or two sentences that `test` runs a real agent that creates an account on the product and spends model money through the developer's Claude Code, then point to the `agent-ready-test` skill: in Claude Code the developer starts it by typing `/agent-ready-test`. You may run the free `npx @tansohq/agent-ready test --check --json` first and show the plan.

## Run it

```bash
npx @tansohq/agent-ready check <url> --json --yes
```

- Needs Node 20.9 or later. The first `npx` run downloads the package.
- `--json` prints one JSON document (`agent-ready/audit-report@1`) to stdout. Read `headline`, `steps` (each has `name`, `state`, `basis` and `reason`), `findings` (each has `step`, `title`, `severity` and `reason`) and `files`.
- `standards` (absent with `--no-standards`) is the aeo-ready catalog: `benchmarks` (each has `name`, `score`, `maxScore`, `grade`, `passed`, `total`, `failed` with the failed checks' names, and `error` when that benchmark did not run) and a top-level `error` when aeo-ready itself did not run. These are the benchmarks' own checks and scores; they never change `headline`, `steps` or `findings`. aeo-ready runs `agentgrade-cli` and two other tools unpinned through `npx`, so the catalog changes when they do.
- `check` never asks the three onboarding questions unless `--ask` is passed. It uses the answers in `agent-ready.yml`, or what the docs describe, or the defaults, and writes them to `agent-ready.yml` in the current directory if that file does not exist. It never overwrites one. `--yes` skips the offer to run a test next.
- Exit codes: `0` done, `1` a fix at or above `--fail-on` was found, `2` usage error, `3` the site did not answer, `130` interrupted (with `--ask`, at a question; otherwise during the standards catalog, after the fixes were written). Errors print `agent-ready/error@1` as `{ error: { code, message, hint } }`; tell the developer the message and the hint.

## The three questions

The defaults come from what the product's docs describe. If the developer knows the answers, pass them:

| Flag | Values | Asks |
| --- | --- | --- |
| `--onboarding` | `try_then_claim` (Try first, claim later), `limited_until_claimed` (Limited until claimed), `agent_is_customer` (Agent is the customer), `agent_identity` (Agent identity), `existing_account` (Person sets up access first), `pay_per_request` (Payment instead of signup) | Who holds the account when an agent first uses it? |
| `--abuse-cost` | `low` (reads and storage), `high` (compute, email, SMS, phone numbers) | What does one abusive free account cost? |
| `--human-before` | `never`, `outbound` (before sending, publishing or charging), `always` (a verified person owns the account first) | Must a verified person exist before the agent acts? |

`agent_identity` is detected when the product's own pages say agents sign in with AgentID ("Sign in with AgentID", "Acme accepts AgentID", "Identity provider: AgentID" on llms.txt or auth.md, or its own `/auth/agentid` route). It becomes the default answer only when no other agent-first path comes first; either way the Sign up reason names AgentID and what the agent needs, and the Access reason names AgentID. A bare mention of AgentID does not count.

The fix prompts build toward the chosen model. Say which answers you used and that they were defaults, so the developer can correct them.

## Report it

1. Lead with `headline` ("Your public pages document N of 7 steps. No step has been tested yet: a test runs a real agent."). `documented` and `verified` hold the two counts; a check never verifies, so `verified` is 0.
2. List each finding: its step, its title and its reason.
3. Never call a step verified or confirmed: a check only reads pages. Say how each step was found (`basis`): `observed` comes from a structured file or an HTTP status, `heuristic` from matching page text (it can be wrong), and `not_checked` means public pages cannot show it. Only a test with a real agent shows a step works. `state`: `agent_can`/`agent_did` pass, `handoff` passes with one person step, `needs_person`/`blocked` are gaps, `not_checked` needs a test.
4. After the findings, summarize `standards` in a few lines: each benchmark's passed/total and score, then the failed check names the developer asks about. Say they are third-party benchmarks and separate from the seven steps. If `standards.error` is set, tell the developer aeo-ready did not run and quote it.
5. Give the paths in `files`: `files.prompts` (one fix prompt per finding), `files.brief` (a one-page brief for security, legal and billing), `files.config` and `files.standards` (aeo-ready's full output).
6. Then tell the developer the next step is a test, and offer the free plan: `npx @tansohq/agent-ready test --check --json`. Do not run `test` itself; see 'If the developer asks for a test'.

## Fix a gap

Only when the developer asks: read the prompt file in `files.prompts`, make the change in the developer's own repository, write and run the acceptance tests the prompt lists, then run the check again to confirm the step changed. The check reads the deployed site, so a fix shows up only after it is deployed. Never change a product the developer does not own.

## What it cannot see

- Pages behind a login, and pages that render only with JavaScript.
- Docs on another domain. It stays on the product's registrable domain. A purchase path documented on another company's site (a payments provider's catalog, such as Stripe Projects on stripe.com) is not read, so Pay says what the product's own pages document, not that no purchase API exists.
- More than 36 requests' worth of pages per run (well-known paths plus at most 14 followed links).
- Whether signup actually works. That needs `agent-ready test`, which runs a real agent, creates a real account and costs model use.

## Hosted runs and buying

- On a hosted workspace at app.tansohq.com you may check usage (`GET /v1/account`, `billing.usage`), cancel a purchase still waiting for approval (`POST /v1/purchases/:id/cancel`), pause buying (`POST /v1/billing/pause` with `{ "paused": true }`) or lower the cap (`POST /v1/billing/cap` with `{ "capCents": 1000 }`). Changing anything needs a key with run or write scope (read-only keys can view usage and list purchases). Keys and agent sessions together can cancel up to 10 purchases a workspace a UTC day; the owner's cancels don't count.
- A 402 with `approval_url: null` means a purchase already waits and you were given its link earlier; if it is lost, `POST /v1/purchases/:id/approval-link` returns a new one (at most 5 per purchase, `429 approval_link_limit`).
- Leave unpausing, raising the cap, approving and paying to the person; they answer an agent `403 person_required`.
- Routes and limits: https://app.tansohq.com/auth.md, section "Manage your workspace".
