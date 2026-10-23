---
name: agent-ready-test
description: "Have a real agent sign up for the developer's product and check the key it got, using agent-ready test. Creates a real account on the product and spends model money through the developer's Claude Code. Run only when the developer explicitly asks for a test run."
disable-model-invocation: true
---

# agent-ready test

`npx agent-led-growth test` starts a separate Claude Code agent that tries the task in `agent-ready.yml` on the product. The checker then calls the product's API with the agent's key (must succeed), with no key and with a wrong key (both must be refused with 400, 401 or 403), using `verify_call` or a call from the OpenAPI document. Name the product (`test <url>`): `agent-ready.yml` is then used only when its `url` is that product, so a file left for another product is never used or changed. This skill is `/agent-ready-test`.

A run creates a real account on the product and uses the developer's Claude Code. Model use is capped at $5 by default (`--max-budget-usd`). Runs in October 2026 cost $0.06 to $0.47; cost depends on the model the developer's Claude Code uses and on how many turns the agent takes. Never start a real run without the developer's explicit yes in this conversation.

## 1. The config

`test` reads `agent-ready.yml` in the current directory. If it is missing, run `npx agent-led-growth check <url> --json --yes` first, which writes it.

With no `verify_call`, `test` infers one from the product's OpenAPI document: a GET that needs a key (bearer, or an API key header) and has no required parameters, preferring `/me`, `/account`, `/user` or `/whoami`, on the document's first server. An API key in the `Authorization` header gets the prefix the document gives (`Authorization: Token {key}` when it says "Prefix your key with 'Token '"); with no documented prefix that call is skipped. The plan shows the call's API host (`checker.apiHost`) and, when it is on a different site than the product (`checker.apiHostOffSite`), says the key the agent gets is sent there. Tell the developer which host the key goes to. When the product's own OpenAPI document has none, it tries the OpenAPI documents its `llms.txt`, `auth.md` and other agent files link to on the same registrable domain (such as `app.` or `api.` hosts). It reuses the latest `.agent-ready/<host>/*/interface.json` from `check`, or reads the public pages again. `--yes` accepts the call and saves it to `agent-ready.yml`; without `--yes` and without a terminal it is used for that run and not saved. With `--json`, the plan and the result carry `checker.inferred: true` and `checker.inferredFrom`, and `checker.inferredVia` (the page that linked the document) when it came from a link. Show the developer the inferred call before a real run. When nothing fits, `test` exits `2` with `verify_call_invalid`; then add the call yourself.

To choose the call, add it. Pick an authenticated read from the product's own API docs that refuses a request without a key:

```yaml
verify_call: GET https://api.example.com/v1/me
verify_header: Authorization: Bearer {key}   # default
verify_expect: 200                           # default
verify_assert: id                            # optional: a field that must be present, or field=value
```

Optional lines, only when the product needs them:

- `verify_fields: PROJECT_ID`: values the agent saves next to its key, filled into `{PROJECT_ID}` in the call.
- `verify_body`: a request body; use `POST` in `verify_call`. A body starting with `{` is sent as JSON, anything else as a form.
- `verify_exchange: POST <url>`, `verify_exchange_body` (use `{key}`) and `verify_exchange_token` (where the token is in the reply): trade the key for a token before the call.
- `verify_cli: npm` (or `pypi`): lets the agent install the product's CLI from that registry. Use it when the product's docs tell agents to start with a CLI, and still check the key with an HTTP call.
- `verify_hosts: a.example.com, b.example.com`: more hosts the agent may reach. By default it may reach only the product's own domain, its usual subdomains the hosts in `verify_call` and `verify_exchange`, and the registries in `verify_cli`.

Do not tell the agent where to save its key in `task`; the run asks it to write `AGENT_READY_KEY` (and each `verify_fields` name) to `work/CREDENTIAL.env`. When the product hands back several secrets, do say in `task` which one the check uses, such as "the identity assertion is the key".

## 2. Check the plan (free)

```bash
npx agent-led-growth test <url> --check --json
```

This starts no agent and sends no request to the product, except the public GETs that infer a missing `verify_call`. It prints `agent-ready/verify-plan@1`: whether Claude Code is installed and signed in (`claudeCode`), the hosts the agent may reach, the inbox, the turn and spending limits, what the agent saves and the calls the checker makes. It exits `0` when ready and `2` when not: no product named and no agent-ready.yml (`config_missing`), no usable call (`verify_call_invalid`), or Claude Code missing or signed out (the fix is in `claudeCode.hint`).

## 3. Ask, then run

Show the developer the plan and ask for a yes, naming: the real account it creates on the product, that it uses their Claude Code, and the spending cap. Only after a yes:

```bash
npx agent-led-growth test <url> --yes --json
```

- Runs in October 2026 took 27 seconds to 4 minutes. A run is stopped after 30 minutes, or after 5 minutes with no output. Run it in the background or with a long timeout.
- `--max-budget-usd <usd>` changes the cap (default 5). Claude Code checks it after each turn, so a run can end slightly above it. `--max-turns <n>` changes the turn budget (default 40).
- If the product emails a code or link, the developer can set `AGENTMAIL_API_KEY` so each run gets its own inbox, deleted afterwards. Without it, the agent stops and says so where the product requires email.

## 4. Report it

The JSON is `agent-ready/verify@1`. Report `outcome`, `reason`, each entry in `checks`, `turns`, `costUsd` and `folder`.

| Exit | `outcome` | Means |
| --- | --- | --- |
| `0` | `passed` or `handoff` | The key works and no key and a wrong key were refused; or the agent correctly stopped where the onboarding model says a person sets access up first. |
| `1` | `failed` | The agent got no key, or the checker's calls did not pass. `prompt` names a fix prompt in the run folder. |
| `2` | | Usage or setup: no `verify_call` and none could be inferred, or Claude Code missing or signed out. |
| `3` | `inconclusive` | Not a result about the product: server errors, a call that answers without a key, the agent could not connect, the spending cap, or a run that did not finish. Say why and suggest what to change. |
| `130` | | Cancelled. |

The run folder holds the agent's trace and notes. Keys (the agent's, and any a product showed or a CLI saved), claim codes, connection-string passwords, the sandbox proxy's credential and one-time codes and links are scrubbed from every file. The agent may use only its test identity's email address; a hook refuses commands, requests and files that carry any other.
