# agent-ready

Can an AI agent sign up for your product and use it without a person? Two commands answer it for your own product.

```bash
npx @tansohq/agent-ready check yourproduct.com   # free, reads public pages, writes fix prompts
npx @tansohq/agent-ready test                    # a real agent tries it; a separate check decides
```

- **`check`** reads your public pages the way an agent does, shows seven steps (Discover, Understand, Sign up, Access, Use, Pay, Manage), asks three questions about how agents should onboard, and writes one fix prompt per gap for your coding agent. It submits nothing.
- **`test`** has a real agent (your local Claude Code) try the task on your product. The checker then calls your API with the agent's key, with no key and with a wrong key, using your `verify_call` or a call from your OpenAPI document.

The loop: check, hand a fix prompt to your coding agent, deploy, check again, then test. Neither needs a Tanso account, and Tanso charges nothing for the CLI. `check` only reads public pages; `test` uses your own Claude Code model time (capped at $5 by default) and creates a real account on your product. (`audit` and `verify` still work as the old names.)

## Quickstart

Needs Node 20.9 or later. `test` also needs [Claude Code](https://claude.com/claude-code), installed and signed in.

### In your terminal

```bash
npx @tansohq/agent-ready check yourproduct.com   # answer three questions, or add --yes for the defaults
npx @tansohq/agent-ready test --check            # free: checks your setup and shows what a run would do
npx @tansohq/agent-ready test                    # asks before it starts
```

`check` writes `agent-ready.yml`. In a terminal it then asks what next: run a test now, see the plan first (free), or quit with the commands; with `--yes` or no terminal it prints the commands under Next and waits for nothing; with `--json`, stdout carries only the report. `test` takes the call that checks the agent's key from your OpenAPI document when it can, and otherwise asks you to add a `verify_call` (see [Test with a real agent](#test-with-a-real-agent)). To skip `npx`, install once with `npm i -g @tansohq/agent-ready` and run `agent-ready check …`.

### With your coding agent

Any agent that can run shell commands and read a web page can use it with no install. Paste this into Claude Code, Codex, Cursor or another coding agent:

```text
Read https://raw.githubusercontent.com/tansohq/agent-ready-cli/main/skills/agent-ready/SKILL.md and follow it to check yourproduct.com.
```

To keep the instructions installed, add the two skills. `agent-ready` runs the check; `agent-ready-test` runs a test with a real agent and is written to run only when you ask.

```bash
# Claude Code, as a plugin
claude plugin marketplace add tansohq/agent-ready-cli
claude plugin install agent-ready@agent-ready

# Codex, Cursor and other agents that read skills, with the skills CLI (https://github.com/vercel-labs/skills)
npx skills add tansohq/agent-ready-cli
```

Then ask in plain words, such as "check yourproduct.com with agent-ready". A test starts only when you invoke it yourself, because it creates an account and spends money: in Claude Code, type `/agent-ready-test`. Agents that don't support user-only skills follow the skill's own rule: check the plan, then ask before a real run.

### In CI

```bash
npx @tansohq/agent-ready check $URL --fail-on high --json   # exit 1 when a high-severity gap is found
```

Commit `agent-ready.yml` so CI reuses your answers. `test` can run in CI with `--yes --json` where Claude Code is installed and signed in (or `ANTHROPIC_API_KEY` is set). Every run creates a real account and spends model money, so run it there only on purpose.

## Cost, accounts and data

| | `check` | `test --check` | `test` |
| --- | --- | --- | --- |
| Costs | nothing | nothing | your Claude Code's model use, capped at $5 by default (`--max-budget-usd`) |
| Creates | `agent-ready.yml` (with your answers; with the defaults only if none exists) and a run folder | nothing (with `--yes`, saves an inferred `verify_call` to `agent-ready.yml`) | a real account on your product, named with the run id, and a run folder |
| Sends requests to | your product's public pages | nothing to your product when `verify_call` is set; without one, GETs your public docs to pick a call; it runs `claude --version` and `claude auth status` | your product, Anthropic (through your Claude Code), AgentMail if `AGENTMAIL_API_KEY` is set |

- **Cost.** Test runs in October 2026 cost $0.06 to $0.47 and took 27 seconds to 4 minutes; runs in September, with an earlier version of this tool, cost $1.10 to $3.00. Cost depends on the model your Claude Code uses and on how many turns the agent takes. Claude Code checks the cap after each turn, so a run can end slightly above it; a run stopped by the cap is reported as inconclusive, not as a failure.
- **Accounts.** The account the agent creates stays on your product after the run; remove it the way you would any test account. With `AGENTMAIL_API_KEY` set, each run gets a fresh [AgentMail](https://agentmail.to) inbox, deleted when the run ends.
- **Your data.** The CLI sends nothing to Tanso: no account, no key, no telemetry. Check requests carry the user agent `agent-ready/<version> (+https://tansohq.com)`. The agent runs with its own isolated settings: none of your MCP servers, hooks, plugins or CLAUDE.md files, and only the test identity's email address (a hook refuses any other).
- **Secrets.** The agent's key, claim codes, connection-string passwords and one-time codes and links are scrubbed from every file in the run folder after the check. The run folder (`.agent-ready/`) stays on your machine; keep it out of version control.

## Limits

- **`check`** sends GET requests only (the aeo-ready catalog's benchmarks make their own requests to your site and, for Cloudflare's, to isitagentready.com): at most 36 per run (well-known paths such as `/llms.txt`, plus at most 14 links it follows from your pages), all on your product's own registrable domain, so docs on another domain are not read. Each request times out after 10 seconds and reads at most 2 MB. It does not run JavaScript, so a page that renders only in the browser reads as empty, and it cannot see anything behind a login. Steps found in page text can be wrong; only a test with a real agent shows a step works.
- **`test`** gives the agent 40 turns (`--max-turns`) and $5 of model use (`--max-budget-usd`). A run is stopped after 30 minutes, or after 5 minutes with no output. The agent can reach only your product's own domain and its usual subdomains (`www`, `api`, `docs`, `app`, `auth`, `console`, `dashboard`, `developers`), the hosts in `verify_call` and `verify_exchange`, the registries in `verify_cli`, and anything in `verify_hosts`. It can use Bash, WebFetch and file tools, not a browser, so a signup that works only in a browser (a form that needs JavaScript, or a CAPTCHA) stops it. One run is one attempt; results can differ between runs.

## Check your product

```bash
npx @tansohq/agent-ready check yourproduct.com
```

`check` reads your public pages (GET only, nothing is submitted), shows the seven steps, asks three questions about how agents should onboard, and writes one fix prompt per gap for your coding agent (Claude Code, Cursor). It never writes your product's code.

After the seven steps it runs the [aeo-ready](https://www.npmjs.com/package/aeo-ready) standards catalog: five third-party benchmarks of your public surface (agentic-seo, Cloudflare's isitagentready, Fern's afdocs, Vercel's agent-readability, AgentGrade), about 125 checks covering llms.txt, robots rules, markdown and content negotiation, MCP server cards, A2A agent cards, x402, UCP, ACP, AP2, Web Bot Auth, rate-limit headers and structured JSON errors. It is free, spawns `npx` for three of the benchmarks, and takes 1-3 minutes, so a check takes that much longer than before; `--no-standards` skips it and the seven steps print in seconds. The catalog is theirs, not ours: aeo-ready runs `agentgrade-cli`, `agentic-seo` and `@vercel/agent-readability` unpinned through `npx`, so their checks change when those packages do, and nothing in it changes the seven-step verdict. A benchmark that did not run says why; an aeo-ready failure is printed, never hidden.

```
  Standards  5 third-party benchmarks of your public surface (aeo-ready 1.7.9)
             Their checks and scores; they do not change the seven steps above.
    · agentic-seo   no individual checks    score 63/100 C
    ✓ Cloudflare    6/6 checks passed       score 1/5 F
    ✗ Fern          12/20 checks passed     score 70/100 C
    ✗ Vercel        14/21 checks passed     score 69/100 C
    ✗ AgentGrade    31/65 checks passed     score 74/100 B

  Failed checks  names as each benchmark reports them
    Fern
      ✗ markdown-endpoint
      ...
```

Scores are each benchmark's own (Cloudflare grades a level out of 5, the others out of 100). Checks a benchmark skipped are not counted; a warning counts as failed, as aeo-ready itself counts it.

```
  agent-ready check · neon.com
  Read 23 public pages. GET only, nothing submitted.

  Your public pages document 5 of 7 steps.
  No step has been tested yet: a test runs a real agent.
  1 needs a fix. 1 needs a test run.

  ✓ Discover      The site is open to agents and has an index   from your files
                  written for them (/llms.txt with 279 links).
  ✓ Understand    Prices are written in the page text, so an    from page text
                  agent can read them, though it has to
                  interpret prose to compare plans.
  ✓ Sign up       The docs describe an agent signing up on its  from page text
                  own (Try first, claim later). It needs:
                  inbox.
  ✓ Access        The agent signup path hands back a key the    from your files
                  agent can use.
  ✓ Use           164 API operations in a machine-readable API  from your files
                  spec.
  ✗ Pay           Paid plans are published, but nothing         from page text
                  documents a way for an agent to buy one, so
                  a person has to check out.
  · Manage        Changing a plan or a limit can only be        needs a test run
                  proven by a test run.

  Onboarding  Try first, claim later (documented · defaults saved to agent-ready.yml)

  1 fix  a prompt for your coding agent
    01  Pay       Let an agent buy a plan without a browser checkout

  Fix   paste this prompt into your coding agent:
        .agent-ready/neon.com/2026-10-10T00-52-29-37wa6t/prompts/01-pay.md
        then run npx @tansohq/agent-ready check neon.com again

  Folder  .agent-ready/neon.com/2026-10-10T00-52-29-37wa6t/
          prompts/ for the fixes · brief.md for security, legal, billing

  Next  When the fixes are in, a test shows whether a real agent can do the steps.
        npx @tansohq/agent-ready test --check   see the plan (free, runs nothing)
        npx @tansohq/agent-ready test           run it: your Claude Code signs up for real
```

The right-hand column says how each step was found: `from your files` (a structured file or an HTTP status), `from page text` (matched in prose, so it can be wrong), or `needs a test run` (public pages cannot show it). A check never reports a step as verified; only a test with a real agent can.

The three questions pick the onboarding model the prompts build toward: who holds the account when an agent first uses it, what one abusive free account costs, and whether a verified person must exist before the agent acts. Defaults come from what your docs describe. Answers are saved to `agent-ready.yml`; commit it and later runs reuse it.

`agent_identity` covers an agent signing in as itself. It is detected for [AgentID](https://www.agentid.com) when your own pages say agents sign in with it: a sign-in phrase ("Sign in with AgentID", "signed in to Acme with AgentID", "Sign-up with **AgentID**", "Acme accepts AgentID"); "via AgentID", "the AgentID path" or "chooses AgentID" next to sign-in words; "Identity provider: AgentID" or "Issuer: https://auth.agentid.com" on a page written for agents (llms.txt, auth.md, skill.md); or your own `/auth/agentid` route in your docs or OpenAPI document. The name alone does not count, and neither do sentences that place the sign-in at other products ("where apps accept it", "add Sign in with AgentID to your app"), integration guides ("Add AgentID to Clerk"), or AgentID's own site. When it is detected, the Sign up reason names AgentID, what the agent needs (an AgentMail inbox, an AgentMail key with `app_connect` on, and usually a browser), and whether your docs mention the owner claims. If another agent-first path is the one the report follows, Sign up and Access add a sentence about the AgentID path. `test` cannot complete an AgentID sign-in yet.

Each run writes `.agent-ready/<host>/<runId>/` with `audit-report.json`, `interface.json`, `aeo-ready.json` (the catalog's own output, unless `--no-standards`), `brief.md` (a one-page brief for security, legal and billing) and `prompts/` (one file per fix, plus `ALL.md`). Every prompt says why, what to build for the chosen model, the security rules, and acceptance tests the coding agent writes and makes pass. With `onboarding: agent_identity`, the Sign up prompt adds Sign in with AgentID to the sign-in the repo already has (Clerk, Auth0, Supabase, Better Auth, Auth.js or its own OpenID Connect client), and names the device flow as the other option. With `try_then_claim`, `limited_until_claimed` or `agent_is_customer`, the Sign up prompt builds the signup endpoint and adds a short note that an existing OpenID Connect sign-in can accept AgentID instead, with what that costs. Choosing `agent_identity` also makes a Sign up that only describes a person handing over a key a gap to fix.

| Flag | Does |
| --- | --- |
| `--yes` | Accept the defaults without asking. Writes `agent-ready.yml` with them if there is none; never overwrites one. |
| `--ask` | Ask again even if `agent-ready.yml` has answers. |
| `--json` | Print `audit-report.json` (`agent-ready/audit-report@1`) to stdout. |
| `--fail-on high\|medium` | Exit 1 when a fix at that severity or above is found. |
| `--no-standards` | Skip the aeo-ready standards catalog. Without it a check spawns `npx` and takes 1-3 minutes longer; still free. |
| `--no-color` | Plain output. `NO_COLOR` is respected too. |

Exit codes: `0` done, `1` fixes at or above `--fail-on`, `2` usage error, a malformed address, or no answers without a terminal (run it in a terminal once, or pass `--yes`), `3` the site did not answer (no DNS record, refused, timeout or a 5xx; nothing is written), `130` cancelled at a question.

In CI: `npx @tansohq/agent-ready check $URL --fail-on high --json`, with `agent-ready.yml` committed.

## Test with a real agent

```bash
npx @tansohq/agent-ready test
```

`test` has a real agent (your local Claude Code) try the task in `agent-ready.yml` on your product. The checker then calls your API with the agent's key, with no key and with a wrong key, using `verify_call` or a call from your OpenAPI document. `check` writes the file.

With no `verify_call` in it, `test` takes the call from your OpenAPI document: it reuses the latest `interface.json` that `check` wrote in `.agent-ready/<host>/` (or reads your public pages the same way `check` does), then picks a GET that needs a key and has no required parameters, preferring paths like `/me`, `/account`, `/user` and `/whoami`, on the document's first server. When your site's own OpenAPI document has no such GET (or there is none), it tries the OpenAPI documents in JSON that your `llms.txt`, `auth.md` and other agent files link to on the same registrable domain (`app.` and `api.` hosts included), and picks one whose call reads the caller's account when it can. The header comes from the security scheme: a bearer scheme gives `Authorization: Bearer {key}`, and an API key in a header gives `<its name>: {key}`. An API key in `Authorization` takes the prefix the document gives for it (the scheme's description or `x-` fields, or an Authorization header parameter: "Prefix your key with 'Token '", "Token <key>"), for example `Authorization: Token {key}`. When no prefix is documented, or two different ones, that call is skipped for the next one. The plan names the call's API host and the document it came from. When the host is on a different site than your product, it says so: the key the agent gets is sent there. `checker.apiHost` and `checker.apiHostOffSite` carry the same in `--json`. In a terminal it asks `Will check with GET <url> on <host> (<header>) (from <document>). Use it? [Y/n]` and saves the call to `agent-ready.yml` on yes; `--yes` accepts and saves it; without either, the call is used for that run and not saved. `--json` marks it with `checker.inferred: true` and `checker.inferredFrom` (the OpenAPI document's URL) in both the plan and the result, plus `checker.inferredVia` (the page that linked it) when the document came from a link; the plan output says the same. When no operation fits (no OpenAPI document in JSON, or no GET with a bearer or header key and no required parameters), `test` exits `2` and asks for a `verify_call`.

To choose the call yourself, add the `verify_*` lines. A complete file:

```yaml
url: yourproduct.com
task: Sign up as an agent, get an API key, and make one authenticated read call
onboarding: try_then_claim      # try_then_claim | limited_until_claimed | agent_is_customer | agent_identity | existing_account | pay_per_request
# agent_identity: the agent signs in as itself with an identity provider for agents, for example Sign in with AgentID (OpenID Connect).
abuse_cost: low                 # low | high
human_before: never             # never | outbound | always

verify_call: GET https://api.yourproduct.com/v1/me
verify_header: Authorization: Bearer {key}   # default
verify_expect: 200                           # default
verify_assert: id                            # optional: a field that must be present, or field=value
```

Some products need more than one plain call, and four optional lines cover the cases seen so far:

- `verify_fields: PROJECT_ID` asks the agent to save other values next to its key, and `{PROJECT_ID}` in the call fills them in (Cloudflare's check names the account: `GET https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/subdomain`).
- `verify_call: POST <url>` with `verify_body` sends a body; one starting with `{` goes as JSON, anything else as a form.
- `verify_exchange: POST <url>`, `verify_exchange_body` and `verify_exchange_token` make a first call that turns the key into the token the check uses. Neon's agent gets an identity assertion and exchanges it for an access token:

```yaml
verify_call: GET https://claimable.neon.tech/v1/projects/{PROJECT_ID}/credentials
verify_fields: PROJECT_ID
verify_exchange: POST https://claimable.neon.tech/v1/oauth2/token
verify_exchange_body: grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={key}&resource=https://claimable.neon.tech/
verify_exchange_token: access_token
verify_assert: database_url
```

- `verify_cli: npm` (or `pypi`, or both) lets the agent install the product's command-line tool from that registry. A CLI that downloads more while it installs, such as a binary from GitHub releases, needs those hosts in `verify_hosts` too.
- `verify_hosts` lists other hosts the agent may reach beyond the product's own, such as a second dashboard domain.

**A product whose agents start with its CLI.** Write the task the way your docs tell an agent to start, add `verify_cli`, and check the key over your HTTP API: a token the CLI uses is usually the same token the API takes. Cloudflare passed this way through `wrangler deploy --temporary` (24 turns, $0.22), and Mem0 (`mem0 init --agent`) and Neon (`neon init --claimable`) through their CLIs too:

```yaml
url: cloudflare.com
task: Make a minimal Hello World Worker and deploy it with Wrangler (npx wrangler deploy --temporary) without logging in. Use Wrangler, not the HTTP API. The temporary account's API token that Wrangler uses is the key; its account id is ACCOUNT_ID
verify_cli: npm
verify_hosts: workers.dev, dash.cloudflare.com
verify_call: GET https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/subdomain
verify_fields: ACCOUNT_ID
```

The agent installs CLIs inside the run folder (`.tools/`), since its sandbox can write nowhere else, and a CLI that saves a login is run with its home there too, so the login is scrubbed with everything else. A CLI built on Node's `fetch` reaches the network only on Node 22.21, or 24 and later (`NODE_USE_ENV_PROXY`); on older Node it fails to connect. When a person has to create the token first (`existing_account`), the agent stops at that step and says so, which `test` counts as a correct handoff.

You don't tell the agent where to save its key: the run asks it to write `AGENT_READY_KEY` (and each `verify_fields` name) to `work/CREDENTIAL.env`, and the checker reads them from there. When the product hands back several secrets, say in `task` which one the check uses (for Neon, "the identity assertion is the key"); without that, an agent may save the wrong one. Before the real run, `test --check` shows what it would do without starting the agent or sending a request to your product (with no `verify_call`, it reads your public docs to infer one, GET only): whether Claude Code is installed and signed in, the hosts the agent may reach, the inbox, what the agent saves, and the calls the checker makes. It exits `0` when ready and `2` when not.

```bash
npx @tansohq/agent-ready test --check
```

The checker makes that call three times: with the agent's key (must return `verify_expect` and pass the assertion), with no key, and with a wrong key (both must be refused with 400, 401 or 403). A call that answers without a key proves nothing, so `test` says so instead of passing.

```
  agent-ready test · app.tansohq.com
  Task: Sign up as an agent, get an API key, and make one authenticated read call

  ✓ Got a key          the agent got its own key; redacted from every file
  ✓ Key works          GET https://app.tansohq.com/v1/account → 200
  ✓ No key refused     without a key → 401
  ✓ Wrong key refused  with a wrong key → 401

  PASS  A real agent got its own key and the checker confirmed it works.
  11 turns · $0.37 · evidence in .agent-ready/app.tansohq.com/2026-10-05T02-35-22-et9ch3/

  Keep it passing: app.tansohq.com runs this test on a schedule and emails you
  when it breaks (5 free runs a month).
```

It works on a product running on your machine too (`url: localhost:3000` means `http://localhost:3000`; on macOS the agent's sandbox opens localhost only for a local target).

It creates a real account on the product, named with the run id, and asks before starting (`--yes` skips the question). The agent can reach only the hosts listed under [Limits](#limits). For products that email a code or a link, set `AGENTMAIL_API_KEY` (an [AgentMail](https://agentmail.to) key): each run gets a fresh inbox, the agent reads the mail from it, and the inbox is deleted afterwards. Cosmic and Telnyx both passed this way. With no inbox (`AGENTMAIL_API_KEY` unset and no `--inbox`), the agent stops and says so where a product requires email. The key, claim codes, passwords in connection strings (`postgres://user:password@…`), and one-time codes and links in the agent's mail are scrubbed from every file after the check, and an assertion like `verify_assert: database_url` reports that the field is present, never its value. The agent may use only its test identity's email address: Claude Code tells the model the signed-in account's email, so a hook refuses any command, request or written file that carries another real address, and with no inbox the agent has no address at all.

Exit codes: `0` passed (or a correct handoff when your onboarding model says a person sets access up first), `1` failed (a fix prompt is written to the run's `prompts/`), `2` usage error, no `verify_call` and none could be inferred, or Claude Code missing or signed out, `3` inconclusive (the product returned server errors, the run did not finish, or the verify call answers without a key), `130` cancelled.

## For agents and scripts

Everything works without a terminal:

```bash
npx @tansohq/agent-ready check example.com --json --yes
npx @tansohq/agent-ready check example.com --json --onboarding existing_account --abuse-cost high --human-before always
npx @tansohq/agent-ready test --check --json   # free: checks setup and prints the plan, runs nothing
npx @tansohq/agent-ready test --json --yes     # creates a real account on the product; ask the developer first
```

- `--json` prints one JSON document to stdout: `agent-ready/audit-report@1` for `check` (with `files.prompts`, `files.brief`, `files.config` and `files.standards`, relative to where it ran; `standards` holds the aeo-ready catalog as `{ generator: { name, version }, averageScore, benchmarks: [{ id, name, score, maxScore, grade, passed, total, failed: [check names], error }], warnings, error }` and is absent with `--no-standards`; a benchmark that did not run has `score: null` and its reason in `error`), `agent-ready/verify@1` for `test`, `agent-ready/verify-plan@1` for `test --check`, and `agent-ready/error@1` for any error, as `{ error: { code, message, hint } }`. Nothing else goes to stdout.
- The three questions have flags: `--onboarding`, `--abuse-cost`, `--human-before`. Any of them, or `--yes`, means no prompt; unanswered ones take their defaults. `--human-before never` lets an agent act alone, `outbound` requires a verified person before an agent sends, publishes, charges or invites, and `always` requires a verified person to own the account before any use. The fix prompts carry that rule.
- Exit codes: `0` done, `1` fixes at or above `--fail-on` (`check`) or the test failed (`test`), `2` usage or setup, `3` the site did not answer or the run was inconclusive, `130` cancelled.
- Each fix prompt is written for a coding agent: read `files.prompts[0]`, make the change in the developer's repository, run its acceptance tests, deploy, then run `check` again.

## More

`agent-ready execute --task <id>` runs one of the built-in example tasks against its public product with a real agent. It uses your Claude Code with no spending cap and does not ask first; `--mode signup` creates an account on that product. `agent-ready execute --help` lists the tasks. For your own product, use `agent-ready test`.

Source: https://github.com/tansohq/agent-ready-cli. Issues and questions go there. The hosted dashboard at [app.tansohq.com](https://app.tansohq.com) ([docs](https://app.tansohq.com/docs), [agent access](https://app.tansohq.com/auth.md)) runs saved tests on a schedule with email or webhook alerts. A hosted test run is not the same harness as `test`: Tanso's model proposes one action at a time and the runner makes bounded HTTP requests to the product's own hosts. It does not drive browser UI or complete arbitrary signup forms.

| | CLI `test` | Hosted test run |
|---|---|---|
| Where it runs | Your machine | Tanso's servers |
| Model and who pays | Your Claude Code; you pay its model time (capped at $5 by default, `--max-budget-usd`). Tanso charges nothing | Tanso's model key; 5 free runs a month in a workspace a person owns, then $5.00 per run |
| What the agent can do | Claude Code with Bash, WebFetch and file tools, limited to the product's hosts (Bash in Claude Code's sandbox, WebFetch to an allowlist) | Bounded HTTP requests to the product's own hosts, up to 12 steps by default; no browser UI, no arbitrary signup forms, no real purchases |
| Scheduling and alerts | None; run it yourself or in CI | Daily or weekly schedules, email or webhook alerts when a test stops passing or passes again |
| Shows in the dashboard | No; evidence stays in `.agent-ready/` on your machine | Yes |

Hosted test runs: 5 free each calendar month in a workspace a person owns, then $5.00 per run. A run that doesn't finish (inconclusive), or fails on our side, is not charged: a free run goes back to the month, a paid run goes back to your balance. CLI runs stay on your machine and never appear in the dashboard.

### Manage your workspace

An agent (an API key or an AgentID agent session) may move its hosted workspace toward spending less; only the signed-in owner may move it toward spending more. Cancelling, pausing and lowering the cap needs a key with run or write scope (read-only keys can view usage and list purchases). Exact routes: [app.tansohq.com/auth.md](https://app.tansohq.com/auth.md).

- See usage: `GET /v1/account` returns `billing.usage` (`runsUsed`, `freeRunsUsed`, `paidRunsUsed`, `runsReturned`, `spentCents`, `capCents`, `remainingCents`, `resetsAt`, and `recentRuns`, the last 20, each `charged`: `free`, `paid` or `returned`) when payments are on; on app.tansohq.com payments are on. All runs: `GET /v1/runs`.
- List purchases: `GET /v1/purchases`, newest first, at most 50.
- Cancel a purchase still waiting for approval, or at an unpaid checkout: `POST /v1/purchases/:id/cancel`. Its status becomes `cancelled`, its approval link stops working, and nothing is charged. Keys and agent sessions together can cancel up to 10 purchases a workspace a UTC day; the owner's cancels don't count (`429 cancel_limit`).
- Pause agent purchases: `POST /v1/billing/pause` with `{ "paused": true }`. Unpausing is owner-only (`403 person_required`).
- Lower the monthly cap: `POST /v1/billing/cap` with `{ "capCents": 1000 }`, below the current approved cap. Raising it is owner-only; with no cap approved yet it answers `403 person_required` ("No monthly cap was approved for this workspace, so there is none to lower.").
- Revoke its own key: `POST /v1/keys/self/revoke` (API keys only, not AgentID sessions). Revokes only the calling key; other keys keep working. If it is the workspace's last key and no person owns it yet, only the claim code reaches the workspace afterwards. Give the claim code to the person before revoking.

Owner-only: unpausing, raising the cap, approving, paying and rotating keys. A revoked key can't be restored and a cancelled purchase stays cancelled. The owner can unpause, raise the cap again, rotate in a new key, or approve a new purchase.
