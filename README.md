# agent-led-growth

**Score** whether an AI agent can sign up for your product, get a key, and make a real API call. **Track** which agents actually do it on live traffic.

## What it does

An agent tries to become your customer. The tool:

1. **Checks** your public pages and says where an agent would stop.
2. **Gives you a fix prompt** for Claude Code, Cursor, or Codex.
3. **Tests** with a real agent to prove the fix works.

## Quick start

```bash
npx agent-led-growth check yourproduct.com
```

```
$ npx agent-led-growth check resend.com

  alg check · resend.com
  Read 21 public pages. GET only, nothing submitted.

  Not yet. Your pages don't show how an agent signs up, gets a key or pays.
  Your public pages document 3 of 7 steps.
  3 need a fix. 1 needs a test run.

  ✓ Discover      The site is open to agents and has an index   from your files
                  written for them (/llms.txt with 58 links).
  ✓ Understand    Prices are written in the page text, so an    from page text
                  agent can read them, though it has to
                  interpret prose to compare plans.
  ✗ Sign up       The pages read document no way for an agent   from page text
                  to sign up. A person may have to create the
                  account; only a real agent run can confirm.
  ✗ Access        The docs describe API keys, bearer tokens     from your files
                  and OAuth, but the pages read do not show
                  how an agent gets one.
  ✓ Use           83 API operations in a machine-readable API   from your files
                  spec.
  ✗ Pay           Paid plans are published. The pages read      from page text
                  document no way for an agent to buy one, so
                  a person may have to check out.
  · Manage        Changing a plan or a limit can only be        needs a test run
                  proven by a test run.

  3 fixes  one prompt each, for your coding agent
    01  Sign up   Let an agent sign up and a person claim it later
    02  Access    Document how an agent authenticates
    03  Pay       Let an agent buy a plan without a browser checkout
```

Six seconds. No account, no Docker, nothing sent to your product but GET requests. Needs Node 20.9 or later.

When a step says your product needs or requires something (an inbox, a payment, a person at checkout), the sentence it came from is printed under the step with the page it is on. A sentence that says the opposite ("takes no email"), an example ("such as a verification email") or text about your own customers never counts. A step that does not apply is marked `-`: Pay when every plan in /pricing.json is free, Manage when there is one free plan.

Then fix and test:

```bash
npx agent-led-growth test yourproduct.com --check   # free: shows the plan, runs nothing
npx agent-led-growth test yourproduct.com           # creates a real account; asks first
```

```
  alg test · app.tansohq.com
  Task: Sign up as an agent, get an API key, and make one authenticated read call

  ✓ Got a key          the agent got its own key; redacted from every file
  ✓ Key works          GET https://app.tansohq.com/v1/account → 200
  ✓ No key refused     without a key → 401
  ✓ Wrong key refused  with a wrong key → 401

  PASS  A real agent got its own key and the checker confirmed it works.
  11 turns · $0.37 · evidence in .alg/app.tansohq.com/2026-10-05T02-35-22-et9ch3/
```

The agent is your own Claude Code. A separate checker then calls your API with the key it got, with no key, and with a wrong key. A test uses your Claude Code's model time, capped at $5. Runs in October 2026 cost $0.06 to $0.47 and took 27 seconds to 4 minutes.

## Why this is different

Readiness scanners read your pages and grade what is documented. Agent-experience evals run an agent from install to working code. Neither tells you whether an agent can become a customer: sign up on its own, hold a key that works, and pay.

This tool runs a real agent through the whole journey and verifies every claim from outside the agent. A successful HTTP response alone doesn't pass: the checker makes the call with the agent's key, with no key, and with a wrong key, and a call that answers without a key proves nothing. Two of the built-in tasks have the agent pay with real money, USDC over x402 and a card through Stripe Projects, and the evaluator reads the settlement on-chain or from the provider, never from the agent's transcript.

The readiness scanners are still useful, so `--standards` runs five of them (agentic-seo, Cloudflare's isitagentready, Fern's afdocs, Vercel's agent-readability, AgentGrade, through [aeo-ready](https://www.npmjs.com/package/aeo-ready)) after the seven steps. They never change the verdict.

## Then, measure real agents

A passing test says an agent *can* become a customer. [Track](https://alg.katrinalaszlo.com) says which ones *do*: an Express middleware that records each agent's session, the errors that end it, and the outcomes that follow. Same seven steps, on real traffic instead of one test agent:

| Step here | In Track |
| --- | --- |
| Discover, Understand | the first events of a session's path (`llms_txt`, docs routes) |
| Sign up | outcome `signup` |
| Access | outcome `key_created` |
| Use | a session with an authenticated 2xx call; `activation` when you record one |
| Pay | outcome `paid` |
| Manage | not measured yet |

```
Add Track to this API: read https://alg.katrinalaszlo.com/SKILL.md and follow it.
```

If you already have a Track account, you can set up the key yourself instead. Run this in your API's folder:

```bash
npx agent-led-growth connect
```

It prints a code and opens your browser; approve there, and it writes `AGENT_TRAFFIC_KEY` to `.env` (plus `AGENT_TRAFFIC_PROJECT_ID`, which is not a secret and is optional). Nothing to copy: the key is never printed, logged or put on a command line. If `.env` is not in `.gitignore` it says so and offers to add it. In a folder linked to Vercel (`.vercel/project.json`) it asks whether to also save the key in Vercel production, and passes it to `vercel env add` on stdin. Then restart your server and open `https://alg.katrinalaszlo.com/install` to watch the first event.

## Full command reference

### The three steps

**1. Check.** Reads your public pages, marks the seven steps an agent goes through (Discover, Understand, Sign up, Access, Use, Pay, Manage), and writes one fix prompt per gap.

**2. Fix.** Paste the prompt it names into your coding agent (Claude Code, Cursor, Codex), deploy, check again. Each prompt says why, what to build, the security rules, and the acceptance tests to write. It never touches your code itself.

**3. Test.** A real agent, your own Claude Code, signs up for your product and gets a key. A separate checker then calls your API with that key, with no key, and with a wrong key. The agent's word is never the verdict.

### With your coding agent

Paste this into Claude Code, Codex, Cursor or any agent that runs shell commands:

```text
Read https://raw.githubusercontent.com/katrinalaszlo/agent-led-growth-cli/main/skills/alg/SKILL.md and follow it to check yourproduct.com.
```

Or install the two skills. `alg` runs the check; `alg-test` runs a test with a real agent and is written to run only when you ask.

```bash
claude plugin marketplace add katrinalaszlo/agent-led-growth-cli   # Claude Code
claude plugin install agent-led-growth@agent-led-growth

npx skills add katrinalaszlo/agent-led-growth-cli                   # Codex, Cursor, others
```

### In CI

```bash
npx agent-led-growth check $URL --fail-on high --json   # exit 1 on a high-severity gap
npx agent-led-growth test $URL --yes --json             # creates a real account every run
```

Commit `alg.yml` so CI reuses your answers. `test` needs Claude Code installed and signed in, or `ANTHROPIC_API_KEY`.

### Installed

`npm i -g agent-led-growth`, then `alg check …`, `alg test …` and `alg connect`.

### Flags

`check`

| Flag | Does |
| --- | --- |
| `--standards` | Also score five third-party benchmarks. Usually 1-3 minutes, up to 15 on a large site; sends your URL to Cloudflare and AgentGrade. |
| `--ask` | Answer the three onboarding questions in the terminal instead of taking them from your docs. |
| `--onboarding`, `--abuse-cost`, `--human-before` | Answer them with flags. See [Onboarding](#onboarding). |
| `--fail-on high\|medium` | Exit 1 when a fix at that severity or above is found. |
| `--json` | Print the report (`agent-ready/audit-report@1`) to stdout, nothing else. |
| `--yes` | Skip the question about running a test next. |

`test`

| Flag | Does |
| --- | --- |
| `--check` | Show the plan, run nothing. Free. |
| `--yes` | Skip the confirmation; save an inferred `verify_call` to `alg.yml`. |
| `--skip-verify` | Test the signup only. The agent's key is not checked, so no `verify_call` is needed. |
| `--max-budget-usd <n>` | Model-use cap, default 5. Checked after each turn, so a run can end slightly above it. |
| `--max-turns <n>` | Agent turn budget, default 40. |
| `--inbox <address>` | An inbox you relay mail from, for products that email a code. Or set `AGENTMAIL_API_KEY` and each run gets its own. |
| `--json` | `agent-ready/verify@1` (or `verify-plan@1` with `--check`) to stdout. |

`connect`

| Flag | Does |
| --- | --- |
| `--endpoint <url>` | Track server. Default `AGENT_TRAFFIC_ENDPOINT`, else `https://alg.katrinalaszlo.com`. |
| `--env-file <path>` | File to write the key to. Default `.env`. Existing lines for the same names are replaced; the rest of the file is kept. A new file is created readable only by you. |
| `--vercel` | Also save the key in Vercel production. Asked by default when `.vercel/project.json` exists; without a terminal, only this flag does it. |
| `--no-vercel` | Do not offer Vercel. |

`connect` exits `0` when the key is saved and `1` when the sign-in is denied or expires.

Exit codes, both commands: `0` done or passed, `1` fixes found or test failed, `2` usage or setup, `3` the site did not answer or the run was inconclusive, `130` cancelled.

### Cost, accounts and data

| | `check` | `test --check` | `test` |
| --- | --- | --- | --- |
| Costs | nothing | nothing | your Claude Code's model use, capped at $5 |
| Creates | `alg.yml` and a run folder in `.alg/` | nothing | a real account on your product, named with the run id, and a run folder |
| Sends requests to | your product's public pages (GET); with `--standards`, also your URL to isitagentready.com and AgentGrade | your public docs, to pick a call, when `verify_call` is unset | your product, Anthropic (through your Claude Code), AgentMail if `AGENTMAIL_API_KEY` is set |

- **Accounts.** The account the agent creates stays on your product; remove it like any test account. With `AGENTMAIL_API_KEY`, each run gets a fresh [AgentMail](https://agentmail.to) inbox, deleted when the run ends.
- **Your data.** No account, no telemetry, nothing phoned home. Check requests carry the user agent `agent-led-growth/<version>`. The agent runs with its own isolated settings: none of your MCP servers, hooks, plugins or CLAUDE.md files, and only the test identity's email address (a hook refuses any other).
- **Secrets.** The agent's key, keys a product showed, claim codes, connection-string passwords and one-time codes and links are scrubbed from every file in the run folder after the check. `.alg/` stays on your machine; keep it out of version control.

### Limits

- **`check`** reads at most 36 pages per run (well-known paths such as `/llms.txt`, plus at most 14 links it follows), all on your product's own registrable domain. 10-second timeout and 2 MB per page. It does not run JavaScript, so a page that renders only in the browser reads as empty, and it sees nothing behind a login. A step found in page text can be wrong; only a test proves one.
- **`test`** gives the agent 40 turns and $5. A run stops after 30 minutes, or 5 minutes with no output. The agent reaches only your product's domain and its usual subdomains (`www`, `api`, `docs`, `app`, `auth`, `console`, `dashboard`, `developers`), plus hosts in `verify_call`, `verify_exchange`, `verify_cli` and `verify_hosts`. It has Bash, WebFetch and file tools, not a browser, so a signup that works only in a browser (a JavaScript-only form, a CAPTCHA) stops it. One run is one attempt; results can differ between runs.

### Onboarding

Three questions pick the onboarding model the fix prompts build toward. `check` does not ask them: it takes what your docs describe, or the recommended model when they describe none, and prints which one it used. Answers are saved to `alg.yml`; edit it, pass the flags, or run `--ask`.

| Question | Answers |
| --- | --- |
| Who holds the account when an agent first uses it? (`onboarding`) | `try_then_claim` (recommended) · `limited_until_claimed` · `agent_is_customer` · `agent_identity` (the agent signs in as itself, for example with [AgentID](https://www.agentid.com)) · `existing_account` (a person sets access up first) · `pay_per_request` |
| What does one abusive free account cost you? (`abuse_cost`) | `low` · `high` |
| Must a verified person exist before the agent acts? (`human_before`) | `never` · `outbound` · `always` |

The headline and the seven steps are the same whatever the answers; the answers change the findings and the prompts.

### alg.yml

`check` writes it. `test` reads it, and infers a `verify_call` from your OpenAPI document when there is none: a GET that needs a key and no parameters, preferring `/me`, `/account`, `/user`, `/whoami`. With no OpenAPI document, `test` asks you at the prompt for a GET that needs a key (and the header that carries it), saves it to `alg.yml` and goes on; press Enter with nothing to skip the check for that run. Without a terminal, pass `--skip-verify`. A complete file:

```yaml
url: yourproduct.com
task: Sign up as an agent, get an API key, and make one authenticated read call
onboarding: try_then_claim
abuse_cost: low
human_before: never

verify_call: GET https://api.yourproduct.com/v1/me
verify_header: Authorization: Bearer {key}   # default
verify_expect: 200                           # default
verify_assert: id                            # a field that must be present, or field=value
```

For products that need more:

- `verify_fields: PROJECT_ID` asks the agent to save other values next to its key; `{PROJECT_ID}` in the call fills them in.
- `verify_call: POST <url>` with `verify_body` sends a body (JSON if it starts with `{`, otherwise a form).
- `verify_exchange`, `verify_exchange_body`, `verify_exchange_token` make a first call that turns the key into the token the check uses (Neon exchanges an identity assertion for an access token this way).
- `verify_cli: npm` or `pypi` lets the agent install your CLI from that registry. Cloudflare passed through `wrangler deploy --temporary` (24 turns, $0.22), Mem0 and Neon through their CLIs.
- `verify_hosts` lists other hosts the agent may reach.

The checker makes the call three times: with the agent's key (must return `verify_expect` and pass the assertion), with no key, and with a wrong key (both must be refused with 400, 401 or 403). A call that answers without a key proves nothing, so `test` says so instead of passing.

`test yourproduct.com` uses `alg.yml` only when its `url` is that product; for another product it takes the task from that product's latest check and never writes the file. It works on a product running on your machine too (`url: localhost:3000`).

### Paying with real money

Two built-in tasks have the agent pay from its own wallet over [x402](https://www.x402.org): `pay-x402-agentmail` (one inbox, $2.00; the payment is the authentication) and `pay-x402-telnyx` ($1 of credit). USDC on Base, from the wallet whose private key is in `AGENT_READY_WALLET_KEY`. Use a wallet made for this with a few dollars on it. The evaluator reads the settlement transaction on Base itself and passes only when USDC left that wallet for no more than `AGENT_READY_PAY_CAP_USD` (default 2.00) and the paid request answered 2xx.

```bash
AGENT_READY_WALLET_KEY=0x… npx agent-led-growth execute --task pay-x402-agentmail
```

`pay-stripe-projects-cloudflare` buys Cloudflare's Workers Paid plan ($5/month) through [Stripe Projects](https://docs.stripe.com/projects): a person sets the wallet up once (`stripe projects init`, `billing add`, `link cloudflare`), the agent runs one command. The evaluator reads `stripe projects spend` before and after, and confirms the subscription with Cloudflare's own API. The command's own verdict is not consulted: on the first real run it said "Provisioning failed" after the charge went through and the plan was on.

`alg execute --help` lists every built-in task. They run against public products with your Claude Code, with no spending cap, and do not ask first.

### For agents and scripts

Everything works without a terminal. `--json` prints one document to stdout and nothing else; errors arrive as `agent-ready/error@1` with `{ code, message, hint }`.

```bash
npx agent-led-growth check example.com --json --yes
npx agent-led-growth check example.com --json --onboarding existing_account --human-before always
npx agent-led-growth test --check --json
npx agent-led-growth test --json --yes     # creates a real account; ask the developer first
```

Each fix prompt is written for a coding agent: read `files.prompts[0]`, make the change, run its acceptance tests, deploy, run `check` again.

Source and issues: https://github.com/katrinalaszlo/agent-led-growth-cli. MIT.
