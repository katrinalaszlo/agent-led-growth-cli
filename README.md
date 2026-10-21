# agent-ready

Find out whether an AI agent can sign up for your product and use it without a person, and get a fix for each step where it can't.

## Quickstart

Needs Node 20.9 or later. Step 3 also needs [Claude Code](https://claude.com/claude-code), installed and signed in.

**1. Check your product.** Free, and it submits nothing to your product. It reads your public pages, then runs a standards catalog that sends your URL to Cloudflare's isitagentready.com and AgentGrade's service and takes 1-3 minutes; add `--no-standards` to skip that and finish in seconds.

```bash
npx @tansohq/agent-ready check yourproduct.com
```

You get seven steps (Discover, Understand, Sign up, Access, Use, Pay, Manage), each marked documented, missing or needs a test, and one fix prompt per gap. It asks no questions: how agents should onboard comes from your docs, or a recommended default, and is saved to `agent-ready.yml`.

**2. Fix the gaps.** Paste the prompt it names (`.agent-ready/<host>/<run>/prompts/01-….md`) into your coding agent (Claude Code, Cursor, Codex), deploy, and run `check` again.

**3. Test with a real agent.** Your Claude Code tries to sign up and use your product; a separate checker then calls your API with the key it got.

```bash
npx @tansohq/agent-ready test yourproduct.com --check   # free: shows what the run would do
npx @tansohq/agent-ready test yourproduct.com           # asks before it starts; creates a real account on your product
```

A run uses your Claude Code's model time, capped at $5; October runs cost $0.06 to $0.47. `test` finds the API call that checks the key in your OpenAPI document; if there is none, it asks you to add a `verify_call` to `agent-ready.yml`.

At the end of a `check` in a terminal you can start step 3 from a menu. Neither command needs a Tanso account, and Tanso charges nothing for the CLI.

## Other ways to run it

### With your coding agent

Paste this into Claude Code, Codex, Cursor or another agent that can run shell commands:

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

### Installed

`npm i -g @tansohq/agent-ready`, then `agent-ready check …`. `audit` and `verify` still work as the old names of `check` and `test`.

## Cost, accounts and data

| | `check` | `test --check` | `test` |
| --- | --- | --- | --- |
| Costs | nothing | nothing | your Claude Code's model use, capped at $5 by default (`--max-budget-usd`) |
| Creates | `agent-ready.yml` (with your answers; with the defaults only if none exists) and a run folder | nothing (with `--yes`, saves an inferred `verify_call` to `agent-ready.yml`) | a real account on your product, named with the run id, and a run folder |
| Sends requests to | your product's public pages (GET); the standards catalog also sends your URL to isitagentready.com and AgentGrade's service, unless `--no-standards` | nothing to your product when `verify_call` is set; without one, GETs your public docs to pick a call; it runs `claude --version` and `claude auth status` | your product, Anthropic (through your Claude Code), AgentMail if `AGENTMAIL_API_KEY` is set |

- **Cost.** Test runs in October 2026 cost $0.06 to $0.47 and took 27 seconds to 4 minutes; runs in September, with an earlier version of this tool, cost $1.10 to $3.00. Cost depends on the model your Claude Code uses and on how many turns the agent takes. Claude Code checks the cap after each turn, so a run can end slightly above it; a run stopped by the cap is reported as inconclusive, not as a failure.
- **Accounts.** The account the agent creates stays on your product after the run; remove it the way you would any test account. With `AGENTMAIL_API_KEY` set, each run gets a fresh [AgentMail](https://agentmail.to) inbox, deleted when the run ends.
- **Your data.** The CLI sends nothing to Tanso: no account, no key, no telemetry. Check requests carry the user agent `agent-ready/<version> (+https://tansohq.com)`. The agent runs with its own isolated settings: none of your MCP servers, hooks, plugins or CLAUDE.md files, and only the test identity's email address (a hook refuses any other).
- **Secrets.** The agent's key, keys a product showed or a CLI saved, claim codes, connection-string passwords, the sandbox proxy's credential and one-time codes and links are scrubbed from every file in the run folder after the check. The run folder (`.agent-ready/`) stays on your machine; keep it out of version control.

## Limits

- **`check`** finds the seven steps with GET requests to your product's own pages: at most 36 per run (well-known paths such as `/llms.txt`, plus at most 14 links it follows from your pages), all on your product's own registrable domain, so docs on another domain are not read. Each request times out after 10 seconds and reads at most 2 MB. It does not run JavaScript, so a page that renders only in the browser reads as empty, and it cannot see anything behind a login. Steps found in page text can be wrong; only a test with a real agent shows a step works. The standards catalog is not GET-only to your product: it sends your product's URL to Cloudflare's isitagentready.com and to AgentGrade's service (through `agentgrade-cli`), which scan the site from there, while agentic-seo, Fern's afdocs and Vercel's agent-readability fetch your pages from your machine; `--no-standards` avoids all of it. Running many checks in parallel can exhaust local ports, because the catalog's benchmarks fetch a site's whole sitemap at once; run checks one at a time, or run them with `--no-standards` and one catalog pass later.
- **`test`** gives the agent 40 turns (`--max-turns`) and $5 of model use (`--max-budget-usd`). A run is stopped after 30 minutes, or after 5 minutes with no output. The agent can reach only your product's own domain and its usual subdomains (`www`, `api`, `docs`, `app`, `auth`, `console`, `dashboard`, `developers`), the hosts in `verify_call` and `verify_exchange`, the registries in `verify_cli`, and anything in `verify_hosts`. It can use Bash, WebFetch and file tools, not a browser, so a signup that works only in a browser (a form that needs JavaScript, or a CAPTCHA) stops it. One run is one attempt; results can differ between runs.

## Check your product

```bash
npx @tansohq/agent-ready check yourproduct.com
```

`check` reads your public pages (GET requests, nothing is submitted to your product), shows the seven steps, takes how agents should onboard from your docs or the defaults, and writes one fix prompt per gap for your coding agent (Claude Code, Cursor). It never writes your product's code.

It writes `agent-ready.yml` if the folder has none. The answer comes first ("Not yet. Your pages don't show how an agent pays."), then the seven steps, the fixes, and Next: step 2 names the first fix prompt by its path, step 3 the test commands. The fixes and Next are written and printed before the standards catalog runs, so you can act on them during the wait; Ctrl+C then skips the catalog, keeps everything else and exits `130`. In a terminal the catalog shows its elapsed time, and the last line repeats the next step. With no fixes, a terminal then asks whether to run a test now, see the plan first (free) or quit; with `--yes` or no terminal nothing waits. With `--json`, stdout carries only the report.

After the seven steps it runs the [aeo-ready](https://www.npmjs.com/package/aeo-ready) standards catalog: five third-party benchmarks of your public surface (agentic-seo, Cloudflare's isitagentready, Fern's afdocs, Vercel's agent-readability, AgentGrade), about 125 checks covering llms.txt, robots rules, markdown and content negotiation, MCP server cards, A2A agent cards, x402, UCP, ACP, AP2, Web Bot Auth, rate-limit headers and structured JSON errors. It is free, spawns `npx` for three of the benchmarks, sends your URL to isitagentready.com (Cloudflare) and AgentGrade's service, and takes usually 1-3 minutes, up to 15 on a large site (aeo-ready is killed after 15; `AGENT_READY_STANDARDS_TIMEOUT_MS` changes that), so a check takes that much longer than before; `--no-standards` skips it and the seven steps print in seconds. The catalog is theirs, not ours: aeo-ready runs `agentgrade-cli`, `agentic-seo` and `@vercel/agent-readability` unpinned through `npx`, so their checks change when those packages do, and nothing in it changes the seven-step verdict. A benchmark that did not run says why; an aeo-ready failure is printed, never hidden.

```
  Benchmarks  optional: 5 third-party scores. Sends your URL to Cloudflare
              and AgentGrade; --no-standards skips them.
              Scores from aeo-ready 1.7.9; they do not change the seven steps.
              agentic-seo, Fern and Vercel fetched your pages from here.
    · agentic-seo   no individual checks    score 63/100 C
    ✗ Cloudflare    4/21 checks passed      level 1/5 F
    ✗ Fern          12/20 checks passed     score 70/100 C
    ✗ Vercel        14/21 checks passed     score 69/100 C
    ✗ AgentGrade    31/65 checks passed     score 74/100 B

  Failed checks  66, the first names shown. All of them:
    .agent-ready/yourproduct.com/2026-10-21T03-04-21-cfgxrw/aeo-ready.json
    Cloudflare   17  linkHeaders, dnsAid, markdownNegotiation, +14
    ...
```

Scores are each benchmark's own (Cloudflare grades a level out of 5, the others out of 100). Failed checks get one line per benchmark: the first names that fit, then `+N`; `aeo-ready.json` in the run folder and `standards.benchmarks[].failed` in `--json` list them all. Checks a benchmark skipped are not counted; a warning counts as failed, as aeo-ready itself counts it.

`check neon.com --no-standards`, October 2026:

```
  agent-ready check · neon.com
  Read 23 public pages. GET only, nothing submitted.

  Not yet. Your pages don't show how an agent pays.
  Your public pages document 5 of 7 steps.
  No step has been tested yet: a test runs a real agent.
  1 needs a fix. 1 needs a test run.

  ✓ Discover      The site is open to agents and has an index   from your files
                  written for them (/llms.txt with 304 links).
  ✓ Understand    Prices are written in the page text, so an    from page text
                  agent can read them, though it has to
                  interpret prose to compare plans.
  ✓ Sign up       The docs describe an agent signing up on its  from page text
                  own (Try first, claim later). Needs an inbox
                  the agent can read.
  ✓ Access        The agent signup path hands back a key the    from your files
                  agent can use.
  ✓ Use           164 API operations in a machine-readable API  from your files
                  spec.
  ✗ Pay           Paid plans are published. The pages read      from page text
                  document no way for an agent to buy one, so
                  a person may have to check out.
  · Manage        Changing a plan or a limit can only be        needs a test run
                  proven by a test run.

  1 fix  a prompt for your coding agent
    01  Pay       Let an agent buy a plan without a browser checkout
  Onboarding: Try first, claim later (documented). Change it in
  agent-ready.yml or with --ask.
  Files: .agent-ready/neon.com/2026-10-21T05-45-24-c75l1m/
         prompts/ for the fixes, brief.md for security, legal, billing

  Benchmarks  skipped (--no-standards)

  Next  Step 2 of 3: fix. Paste a prompt into your coding agent, deploy,
        then check again:
        .agent-ready/neon.com/2026-10-21T05-45-24-c75l1m/prompts/01-pay.md
        npx @tansohq/agent-ready check neon.com
  Then  Step 3 of 3: test. The plan is free; a signup uses your Claude Code.
        npx @tansohq/agent-ready test neon.com --check
        npx @tansohq/agent-ready test neon.com
```

The right-hand column says how each step was found: `from your files` (a structured file or an HTTP status), `from page text` (matched in prose, so it can be wrong), or `needs a test run` (public pages cannot show it). A check never reports a step as verified; only a test with a real agent can.

The three questions pick the onboarding model the prompts build toward: who holds the account when an agent first uses it, what one abusive free account costs, and whether a verified person must exist before the agent acts. `check` does not ask them: it takes what your docs describe, or the recommended model when they describe none, and prints the onboarding model it used. The headline and the seven steps are the same whatever the answers; the answers change the findings and the fix prompts. Edit `agent-ready.yml`, pass the flags, or run with `--ask` to answer in the terminal (a model your agent-facing pages document is shown, not asked; "not sure" keeps a default). Answers are saved to `agent-ready.yml`; commit it and later runs reuse it.

`agent_identity` covers an agent signing in as itself. It is detected for [AgentID](https://www.agentid.com) when your own pages say agents sign in with it: a sign-in phrase ("Sign in with AgentID", "signed in to Acme with AgentID", "Sign-up with **AgentID**", "Acme accepts AgentID"); "via AgentID", "the AgentID path" or "chooses AgentID" next to sign-in words; "Identity provider: AgentID" or "Issuer: https://auth.agentid.com" on a page written for agents (llms.txt, auth.md, skill.md); or your own `/auth/agentid` route in your docs or OpenAPI document. The name alone does not count, and neither do sentences that place the sign-in at other products ("where apps accept it", "add Sign in with AgentID to your app"), integration guides ("Add AgentID to Clerk"), or AgentID's own site. When it is detected, the Sign up reason names AgentID, what the agent needs (an AgentMail inbox, an AgentMail key with `app_connect` on, and usually a browser), and whether your docs mention the owner claims. If another agent-first path is the one the report follows, Sign up and Access add a sentence about the AgentID path. `test` cannot complete an AgentID sign-in yet.

Each run writes `.agent-ready/<host>/<runId>/` with `audit-report.json`, `interface.json`, `aeo-ready.json` (the catalog's own output, unless `--no-standards`), `brief.md` (a one-page brief for security, legal and billing) and `prompts/` (one file per fix, plus `ALL.md`). Every prompt says why, what to build for the chosen model, the security rules, and acceptance tests the coding agent writes and makes pass. With `onboarding: agent_identity`, the Sign up prompt adds Sign in with AgentID to the sign-in the repo already has (Clerk, Auth0, Supabase, Better Auth, Auth.js or its own OpenID Connect client), and names the device flow as the other option. With `try_then_claim`, `limited_until_claimed` or `agent_is_customer`, the Sign up prompt builds the signup endpoint and adds a short note that an existing OpenID Connect sign-in can accept AgentID instead, with what that costs. Choosing `agent_identity` also makes a Sign up that only describes a person handing over a key a gap to fix.

| Flag | Does |
| --- | --- |
| `--ask` | Ask the three onboarding questions in the terminal, even if `agent-ready.yml` has answers. Needs a terminal. |
| `--yes` | Skip the question about running a test next. |
| `--json` | Print `audit-report.json` (`agent-ready/audit-report@1`) to stdout. |
| `--fail-on high\|medium` | Exit 1 when a fix at that severity or above is found. |
| `--no-standards` | Skip the aeo-ready standards catalog. Without it a check spawns `npx` and takes usually 1-3 minutes longer, up to 15 on a large site; still free. |
| `--no-color` | Plain output. `NO_COLOR` is respected too. |

Exit codes: `0` done, `1` fixes at or above `--fail-on`, `2` usage error, a malformed address, or `--ask` without a terminal, `3` the site did not answer (no DNS record, refused, timeout or a 5xx; nothing is written), `130` cancelled at a question, or Ctrl+C during the standards catalog (the fixes and `audit-report.json` are already written, without `standards`).

In CI: `npx @tansohq/agent-ready check $URL --fail-on high --json`, with `agent-ready.yml` committed.

## Test with a real agent

```bash
npx @tansohq/agent-ready test yourproduct.com
```

`test` has a real agent (your local Claude Code) try the task in `agent-ready.yml` on your product. The checker then calls your API with the agent's key, with no key and with a wrong key, using `verify_call` or a call from your OpenAPI document. `check` writes the file.

Named, as above, `test` uses `agent-ready.yml` only when its `url` is that product. When the file is for another product, or there is none, it says so ("Not using ~/agent-ready.yml: it is for tansohq.com."), takes the task and answers from that product's latest check in `.agent-ready/<host>/` (or the defaults), finds the call in the product's OpenAPI document and uses it for that run only: another product's `verify_call` would be sent this product's key, and that file is never changed. With no product named, `test` reads it from `agent-ready.yml` and exits `2` (`config_missing`) when there is none.

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

  Keep it passing: hosted runs, on a schedule with an email when this test
  breaks, are coming. Join the waitlist at tansohq.com.

  Your product, seven steps
  ✓ Discover  · Understand  ✓ Sign up  ✓ Access  ✓ Use  ✓ Pay  · Manage
  A test proved: Sign up, Access.
```

After a `check`, every `test` prints the seven steps with what your tests on this machine proved, the same steps `check` shows and the hosted product will.

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

- `--json` prints one JSON document to stdout: `agent-ready/audit-report@1` for `check` (with `files.prompts`, `files.brief`, `files.config` and `files.standards`, relative to where it ran; `standards` holds the aeo-ready catalog as `{ generator: { name, version }, averageScore, benchmarks: [{ id, name, score, maxScore, grade, passed, total, failed: [check names], error, durationMs }], warnings, error }` and is absent with `--no-standards`; a benchmark that did not run has `score: null` and its reason in `error`; `durationMs` is the benchmark's own wall-clock time, null when aeo-ready is older than 1.8.0), `agent-ready/verify@1` for `test`, `agent-ready/verify-plan@1` for `test --check`, and `agent-ready/error@1` for any error, as `{ error: { code, message, hint } }`. Nothing else goes to stdout.
- The three questions have flags: `--onboarding`, `--abuse-cost`, `--human-before`. Unanswered ones take their defaults. `--human-before never` lets an agent act alone, `outbound` requires a verified person before an agent sends, publishes, charges or invites, and `always` requires a verified person to own the account before any use. The fix prompts carry that rule.
- Exit codes: `0` done, `1` fixes at or above `--fail-on` (`check`) or the test failed (`test`), `2` usage or setup, `3` the site did not answer or the run was inconclusive, `130` cancelled.
- Each fix prompt is written for a coding agent: read `files.prompts[0]`, make the change in the developer's repository, run its acceptance tests, deploy, then run `check` again.

## More

`agent-ready execute --task <id>` runs one of the built-in example tasks against its public product with a real agent. It uses your Claude Code with no spending cap and does not ask first; `--mode signup` creates an account on that product. `agent-ready execute --help` lists the tasks. For your own product, use `agent-ready test`.

### Pay with x402

Two of the built-in tasks have the agent pay a product over x402 from its own wallet: `pay-x402-agentmail` (creates one inbox, $2.00, no API key: the payment is the authentication) and `pay-x402-telnyx` (adds $1 of account credit; needs `TELNYX_API_KEY` and an account with the `X402_PAYMENTS_ENABLED` flag). **Real money moves**: USDC on Base, from the wallet whose private key you put in `AGENT_READY_WALLET_KEY`. Use a wallet made for this with a few dollars on it, never your main one. The agent makes exactly one paid request; the evaluator reads the settlement transaction on Base itself (keyless JSON-RPC at mainnet.base.org) and passes only when USDC left that wallet for no more than `AGENT_READY_PAY_CAP_USD` (default 2.00) and the paid request answered 2xx. The key is handed to the agent under another name and redacted from every file the run writes.

```bash
AGENT_READY_WALLET_KEY=0x… AGENT_READY_PAY_CAP_USD=2 npx @tansohq/agent-ready execute --task pay-x402-agentmail
```

### Pay through Stripe Projects

`pay-stripe-projects-cloudflare` has the agent buy Cloudflare's Workers Paid plan ($5/month) through [Stripe Projects](https://docs.stripe.com/projects), the pattern where a person sets a wallet up once and a program spends from it. The person's part comes first and is not the agent's: `stripe login` from a browser, `stripe projects init` in a folder, `stripe projects billing add` (a card, entered on a Stripe Checkout page), `stripe projects billing update --limit <dollars>` (the default is $100 per provider per month) and `stripe projects link cloudflare` (a Cloudflare sign-in). Put that folder's path in `AGENT_READY_STRIPE_PROJECT_DIR`; the run copies its `.projects/` into the work directory and the agent runs one command, `stripe projects add cloudflare/workers:paid`. **Real money moves**: the card on your Stripe account is charged. The evaluator reads `stripe projects spend` before and after the run and passes only when the charge grew by no more than `AGENT_READY_PAY_CAP_USD` (default 5.00 for this task), `stripe projects status` lists the new resource, and Cloudflare's API shows the subscription on, read with a token of yours that can read the account's billing (`AGENT_READY_CLOUDFLARE_TOKEN`, `AGENT_READY_CLOUDFLARE_ACCOUNT`); without that token the run is never a success. The command's own verdict is not consulted: on the first real run it said "Provisioning failed" after the charge went through and the plan was on. This task runs Bash **outside** the sandbox, unlike every other: Stripe's plugin listens on 127.0.0.1 and the session lives in the macOS Keychain, neither reachable from inside it. The run's `execution.json` records that.

```bash
AGENT_READY_STRIPE_PROJECT_DIR=~/stripe-project AGENT_READY_CLOUDFLARE_TOKEN=… AGENT_READY_CLOUDFLARE_ACCOUNT=… npx @tansohq/agent-ready execute --task pay-stripe-projects-cloudflare
```

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

### Hear from agents that get stuck

Hosted only. A product adds its host once, `POST /v1/feedback/projects` with `{ "host": "yourproduct.com" }` (or the Stuck reports page of the dashboard), and gets one line to put in its 4xx bodies, llms.txt and auth.md. An agent that cannot continue reads the page that line names, `GET /stuck/<id>.md`, and posts one JSON report to `POST /stuck/<id>`: `message` (required), `path`, `status`, `step`, `agent`, `task`. No key, no account, nothing created for the agent. The product reads them with `GET /v1/feedback/projects/:id/reports`, newest first, or on the Stuck reports page grouped by step. A report the product's own server forwards, signed with the project's secret as `Tanso-Signature: t=<unix seconds>,v1=<HMAC-SHA256 hex of t.body>`, is recorded as signed; any other is unverified: what it says about the agent is taken as is. One project hears at most 60 unverified reports an hour (then `429 report_rate_limited`) and keeps its last 500.
