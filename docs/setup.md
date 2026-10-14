# Setup and configuration

[Back to the overview](../README.md)

How to run the game with simulated models (no keys) or with real ones, and how to configure it.

## Requirements

- **Node.js 20.12 or newer.** Check with `node --version`; download it from <https://nodejs.org>.
- **`npm install`**, once, after cloning or pulling. This installs the Azure Tables and Azure Identity SDKs that the
  server imports at startup (used only when [usage control](#3-run-it-as-a-protected-public-demo) is enabled; local
  and mock modes still need the packages present, but never call Azure).
- For real models: a **KodeKey** token (for JEV) and/or a key for an **Azure AI Foundry** resource (for Microsoft Decision 1, GPT, Grok and others).

## 1. Try it without keys

```bash
npm install
npm run demo
```

Open the URL it prints (<http://127.0.0.1:3000>) and press **Start shift**. The models are **simulated**: JEV, Decision 1 and a fast LLM by default, with a large LLM and a
reasoning LLM available in **Setup**. Their delays and token counts are modelled on our live runs (see [About the models](about-the-models.md)), and every simulated model has the same 99% accuracy
so you can see how mistakes are reported. A *SIMULATED* badge is shown on the page and on the stage, and the report says so. Nothing in demo mode is a measurement of a real model.
As with the real thing, a race against the reasoning LLM takes a couple of minutes.

## 2. Race the real models

1. **Create your settings file.** Copy [`.env.example`](../.env.example) to `.env`:
   - macOS / Linux: `cp .env.example .env`
   - Windows (PowerShell): `Copy-Item .env.example .env`

   `.env` is git-ignored and is read only by the server on your machine. The browser never receives it.
2. **Paste your keys and endpoints** into `.env`:
   - `KODEKEY_API_KEY`: your KodeKey token. `KODEKEY_BASE_URL` is pre-filled.
   - `FOUNDRY_ENDPOINT`: your Foundry **resource** endpoint, `https://<resource>.services.ai.azure.com`.
   - `FOUNDRY_API_KEY`: the key of that resource (one key covers every deployment on it). Find it in the Foundry portal on a deployment's page,
     or in the Azure portal under your Foundry resource, *Keys and Endpoint*.
   - `MODEL_*_URL` and `MODEL_*_MODEL`: replace `<resource-name>` in the URLs, and set each `MODEL` to the **deployment name** shown in the portal.
3. **Check the connections** with real calls: `npm run check`. It sends a clean and a bad sample application through each desk and says what to fix.
4. **Play:** `npm start`, open the URL it prints, and press **Start shift**.

If port 3000 is busy, the server says so and uses the next free one; open the URL it prints.

Controls: `Space` start, `R` reset, `1` `2` `3` inspect a desk, `F` focus view (hides the side panel). Click a lane to inspect that desk.

## 3. Run it as a protected public demo

The game has three modes:

| Mode | How to run it | Azure needed | Live connection test |
| --- | --- | --- | --- |
| **Local, unprotected** (default) | `npm start` with `HOST=127.0.0.1` (the default) and `USAGE_CONTROL_ENABLED` unset or `false` | No | Yes (`npm run check` and the Setup tab's *Test connections*) |
| **Mock / demo** | `npm run demo` (or `MOCK_MODE=true`) | No | Yes, always, even if usage control is also enabled |
| **Protected hosted** | `USAGE_CONTROL_ENABLED=true` with the usage settings below, served publicly | Yes (Azure Table Storage) | No, in the live UI (`/api/test` is removed); `npm run check` still works for operators |

A local unprotected server spends your credits with no login and no limits, so only run it that way where you control who can reach it
(keep `HOST=127.0.0.1`). To host the game for anyone to use without a login, enable **usage control**: the server itself enforces a daily
race allowance per anonymous visitor and an app-wide daily ceiling, backed by a shared Azure Table so the limits hold across restarts and
multiple instances. Visitors are recognized by a signed, `HttpOnly` cookie, not an account; a race that starts receives a short-lived,
opaque permit that authorizes only that race's preparation and decisions, never the general API.

### Usage control settings (`.env`)

| Variable | Meaning | Default / range |
| --- | --- | --- |
| `USAGE_CONTROL_ENABLED` | Turns on every check below. Leave it unset or `false` for local/default use | `false` |
| `USAGE_DAILY_GLOBAL_RACES` | App-wide race starts allowed per `Asia/Kolkata` day. **Required** (non-negative integer) once enabled; `0` refuses every race, an emergency stop | none; no upper bound |
| `USAGE_VISITOR_DAILY_LIMIT` | Race starts allowed per anonymous visitor (browser) per `Asia/Kolkata` day. Optional; a change applies from the next race start after the app restarts, up or down | `10`; whole number `1`-`1000` |
| `USAGE_TABLE_ENDPOINT` | The Azure Table service endpoint, `https://<account>.table.core.windows.net`. **Required** on App Service (authenticated with its managed identity) | none |
| `USAGE_TABLE_NAME` | The table the daily ledger lives in. Must start with a letter and be 3-63 letters/digits | `RaceUsage` |
| `USAGE_STORAGE_CONNECTION_STRING` | Local-development-only alternative to `USAGE_TABLE_ENDPOINT` (for example an Azurite connection string). Startup refuses it when App Service environment variables are present. Give local runs their own `USAGE_TABLE_NAME`: every process that shares a table shares its daily counters and its lowest daily cap | none |
| `USAGE_SIGNING_SECRET` | **Required** stable secret that signs the visitor cookie and the day-scoped hashes stored in the table | none |
| `USAGE_PERMIT_MINUTES` | How long a race permit stays valid (capped at the next India midnight, whichever is sooner) | `45`; `1`-`180` |
| `USAGE_STARTS_PER_MINUTE` | Best-effort per-IP race-start burst limiter; a secondary speed bump, never the authority | `6`; `1`-`1000` |

Each anonymous visitor gets `USAGE_VISITOR_DAILY_LIMIT` races (default **10**) per `Asia/Kolkata` calendar day. All counters and permits
reset at India midnight (`Asia/Kolkata`, no daylight saving), never the server's own timezone.

**The global cap can only be lowered mid-day, never raised.** Each day's table row remembers the *lowest* `USAGE_DAILY_GLOBAL_RACES` any
running instance has used that day. Restarting or redeploying with a lower cap — including `0`, an emergency stop — takes effect immediately.
Restarting with a higher cap does not widen the ceiling until the next India day, so a rolling or partial deployment can never accidentally
raise exposure mid-day. `USAGE_VISITOR_DAILY_LIMIT` is different: it is compared with each visitor's running count on every start, so raising or
lowering it applies from the next race start after the app restarts (the global cap still bounds everyone combined).

**Sizing the global cap:** the ceiling counts races, not currency. The largest possible race is 50 applicants across 3 desks, 150 logical
decisions. Each decision retries transient failures up to `MAX_RETRIES` times (capped at 5), so one decision can make up to 6 provider
attempts, up to **900 provider attempts in the worst case**, plus up to 3 unretried preparation probes (one per distinct model). Multiply
your cap by this worst case and by the configured models' per-decision price (see [how cost and tokens are measured](#how-cost-and-tokens-are-measured))
to estimate worst-case daily spend, and keep provider-side quotas and an Azure Cost Management budget alert as backstops, not as the enforcement
mechanism itself.

### Azure prerequisites (App Service)

These steps use the project's current deployment, the Basic Linux App Service `ai-model-speed-race` in Central India, as the example;
substitute your own names and region.

1. **Create or reuse a Standard LRS storage account** and the usage table:

   ```bash
   az storage account create -n <storage-account> -g <resource-group> -l centralindia --sku Standard_LRS --https-only true --min-tls-version TLS1_2
   az storage table create -n RaceUsage --account-name <storage-account> --auth-mode login
   ```

2. **Enable the App Service's system-assigned managed identity:**

   ```bash
   az webapp identity assign -n ai-model-speed-race -g <resource-group>
   ```

3. **Grant that identity `Storage Table Data Contributor`, scoped to the table only** (not the whole storage account):

   ```bash
   principalId=$(az webapp identity show -n ai-model-speed-race -g <resource-group> --query principalId -o tsv)
   scope="/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Storage/storageAccounts/<storage-account>/tableServices/default/tables/RaceUsage"
   az role assignment create --assignee "$principalId" --role "Storage Table Data Contributor" --scope "$scope"
   ```

   RBAC can take a few minutes to propagate; see [Troubleshooting](troubleshooting.md) if the app reports it cannot reach the table right after this step.

4. **Set the app settings** (no storage key or connection string; the managed identity authenticates):

   ```bash
   az webapp config appsettings set -n ai-model-speed-race -g <resource-group> --settings \
     USAGE_CONTROL_ENABLED=true \
     USAGE_DAILY_GLOBAL_RACES=<your-chosen-cap> \
     USAGE_TABLE_ENDPOINT=https://<storage-account>.table.core.windows.net \
     USAGE_TABLE_NAME=RaceUsage \
     USAGE_SIGNING_SECRET=<a-long-random-secret>
   ```

### Rollout order

1. Deploy the new code privately (a non-public slot, IP-restricted access, or before DNS/traffic points at it) with `USAGE_CONTROL_ENABLED`
   still `false`. The server behaves exactly as before.
2. Provision the storage account, table, managed identity and table-scoped RBAC (above), and confirm the app can reach the table
   (its startup log; it refuses to start if it cannot).
3. Set `USAGE_SIGNING_SECRET` and the daily caps, then set `USAGE_CONTROL_ENABLED=true` and restart the app (or swap the slot).
4. Smoke-test before opening public traffic: a race starts and completes, a repeated start from the same browser is still counted,
   a direct `POST /api/prepare` or `/api/decide` without a permit is refused, and `GET /api/config` shows `usage.testAvailable: false`.
5. Only then point public traffic at it.

### Rollback

Usage control is never switched off while the app still answers public, provider-backed routes. If something is wrong, in order:

1. **Lower the effective cap to `0`** (an immediate emergency stop; see "lowered mid-day" above) **or** remove public/provider access
   (take the app offline, restrict access, or rotate out the provider keys).
2. Let in-flight races finish naturally or let their permits expire; do not force-disable usage control while they could still reach a provider.
3. Only then roll back the application version or configuration.

Rotating `USAGE_SIGNING_SECRET` mid-day has the same effect as a partial outage: existing visitor cookies and active permits stop verifying,
so do that only at India midnight or in a planned maintenance window; the global cap remains the backstop either way.

### Retention and manual cleanup

Each `Asia/Kolkata` day gets its own table partition (`PartitionKey` `YYYYMMDD`) holding the global counter, one row per visitor hash seen that
day, and one row per race. Visitor hashes are day-scoped (not linkable across days) and no raw IP address, cookie value or permit is ever
stored, but partitions are not deleted automatically yet. Until automated retention is added, periodically delete old partitions yourself,
for example with a short script using `@azure/data-tables` (`listEntities({ queryOptions: { filter: "PartitionKey lt 'YYYYMMDD'" } })` then
`deleteEntity`) or the Azure Storage Explorer, keeping only the window you need for support and auditing (for example 30-90 days).

### Cost Management alert

Set an [Azure Cost Management budget alert](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
on the resource group as a final alarm for spend outside this app's control (for example a provider price change, or a cap set too high) --
not as the primary enforcement mechanism, which is the daily race cap above.

## Choosing the models at the desks

Open the **Setup** tab and use the *Desk lineup* dropdowns. Every model defined in `.env` is on offer, whether or not it is in the default line-up, and the same model may sit
at several desks. The choice is remembered in the browser; **Use the .env lineup** returns to the default. Models that are not configured (for example a missing key) are shown
but cannot be newly chosen.

The page only ever names a model. It never supplies a URL, key or header, so those stay in `.env`. To add a model, define a profile (below) and restart the server.

## Configuration reference (`.env`)

### Line-up and profiles

`LINEUP=JEV,DECISION1,GPT41MINI` sets the **default line-up**: up to three **profiles** for desks 1, 2 and 3. A profile is a group of `MODEL_<NAME>_*` variables:

| Variable | Meaning |
| --- | --- |
| `MODEL_<NAME>_LABEL` | Friendly name shown in the game |
| `MODEL_<NAME>_MODEL` | KodeKey model id, or the Foundry **deployment name** (not the model name) |
| `MODEL_<NAME>_URL` | The URL exactly as the Foundry portal shows it. Its ending selects the API (table below) and an Azure host selects the Foundry provider |
| `MODEL_<NAME>_PROVIDER` | `kodekey` or `foundry`. Only needed when there is no URL |
| `MODEL_<NAME>_API` | `chat` (default), `responses` or `auto` (tries chat, then responses, once before the race). Only when there is no URL |
| `MODEL_<NAME>_MODE` | System One models only: `questions` (KodeKey default), `systemone` (Foundry default) or `auto` |
| `MODEL_<NAME>_KIND` | `llm` or `systemone`. Normally inferred from the model name (`jev`, `decision-1`) or the URL |
| `MODEL_<NAME>_REASONING_EFFORT`, `_TEMPERATURE`, `_MAX_TOKENS` | Optional model tuning. Values a model rejects are dropped automatically. Grok 4.7 reasons at `high` by default; `low` is much faster |
| `MODEL_<NAME>_PRICE_IN`, `_PRICE_OUT`, `_PRICE_CACHED_IN` | USD per 1M tokens, for the cost columns. Optional: the models below have [built-in prices](#how-cost-and-tokens-are-measured). Set these to override them or to price another model. A cached rate is optional; without one, cached input tokens cost the normal input rate |

The older `DESK1_*`, `DESK2_*`, `DESK3_*` variables (same suffixes) are still read for any desk `LINEUP` does not name. The hall always has three desks.

| URL ending shown in the Foundry portal | The game speaks |
| --- | --- |
| `.../openai/v1/responses` | Responses API (GPT-4.1, GPT-5, ...) |
| `.../openai/v1/chat/completions` | Chat Completions (Grok, DeepSeek, Llama, ...) |
| `.../providers/microsoft/v1/systemone` | System One with typed questions (Microsoft Decision 1) |

### Keys and server

| Variable | Meaning |
| --- | --- |
| `KODEKEY_BASE_URL`, `KODEKEY_API_KEY` | KodeKey gateway (an OpenAI-format LiteLLM proxy) and your token |
| `KODEKEY_JEV_PATH` | Only for `MODE=systemone` on KodeKey: the native route (default `/systemone`) |
| `FOUNDRY_ENDPOINT`, `FOUNDRY_API_KEY` | Foundry **resource** endpoint (`https://<resource>.services.ai.azure.com`) and its key |
| `REQUEST_TIMEOUT_MS`, `MAX_RETRIES` | Per-request timeout (60 s) and retries for 429 / 5xx / network errors (2, up to 5) |
| `PORT`, `HOST`, `MOCK_MODE` | Server options. `HOST` defaults to `127.0.0.1`; keep it that way unless [usage control](#3-run-it-as-a-protected-public-demo) is enabled, since the API otherwise spends your credits with no login |
| `USAGE_*` | Anonymous-visitor and app-wide daily race limits for a public deployment; see [Run it as a protected public demo](#3-run-it-as-a-protected-public-demo) |

### How JEV is reached through KodeKey

`https://api.ai.kodekloud.com` is a LiteLLM gateway, which speaks the OpenAI format. It serves JEV as a chat model whose typed
questions travel in `response_format`:

- `POST /v1/chat/completions` with the application as the user message and `response_format: { "type": "questions", "questions": { ... } }`
  (the *Rulebook* tab in the game shows the exact body).
- The reply content is a JSON map of answers, one probability per question. The usage block carries the token counts, and `usage.cost` (also sent as the
  `x-litellm-response-cost` header) is the gateway's own price for the call, which the game shows as the cost.
- **The model id matters.** A token can only call the models its group allows. The free group exposes `typesafe/jev-1.13.0`; the alias
  `jev-latest` answers 403. `npm run check` lists the JEV ids your key can use.
- `MODE=systemone` (with `KODEKEY_JEV_PATH`) is there for a gateway that exposes TypeSafe's native route; `MODE=auto` tries both once, before the race clock starts.

### How Foundry is reached

- **Use the resource endpoint, not the project endpoint.** API keys are scoped to the Foundry resource. The project endpoint
  (`https://<resource>.services.ai.azure.com/api/projects/<project>`) is meant for Microsoft Entra ID sign-in and the agent SDKs.
  If you paste a project-scoped URL, the game calls the same route on the resource instead.
- One key and one endpoint serve every deployment on the resource: GPT-4.1, Grok 4.7, Decision 1, and so on. Only `model` (the deployment name) changes.
- Routes: `<endpoint>/openai/v1/responses`, `<endpoint>/openai/v1/chat/completions` and `<endpoint>/providers/microsoft/v1/systemone`.
- Auth: the key is sent as an `api-key` header. If a route rejects that style with a 401, the game retries once with a bearer token and keeps what works.
  Before the clock starts it validates the key once, so a wrong key stops that desk instead of making it look fast.
- Keys only. Microsoft Entra ID sign-in is not implemented, so the resource must allow key authentication.
- `npm run check` lists the deployments on the resource (when the resource allows it) and suggests the closest name when yours is not one of them.

### How cost and tokens are measured

Tokens and cost come from each model's own response, not from assumptions. (Demo mode simulates both and says so.)

| Model | Tokens come from | Cost comes from |
| --- | --- | --- |
| JEV (KodeKey) | `usage.prompt_tokens`, `completion_tokens` | the gateway's own figure for the call, `usage.cost`: $0.042 per 1M input tokens, output free |
| Decision 1 | `usage.input_tokens`, `output_tokens` | input tokens times $0.042 per 1M, output free. Azure lists one $0.042 "tokens" meter, the same rate as JEV's input price, and TypeSafe charges nothing for System One output. Microsoft does not spell this out: if your invoice bills output tokens, set `MODEL_DECISION1_PRICE_OUT=0.042` |
| GPT-4.1 mini | `usage.input_tokens`, `output_tokens` | tokens times $0.40 in, $0.10 cached in, $1.60 out per 1M |
| GPT-4.1 | `usage.input_tokens`, `output_tokens` | tokens times $2.00 in, $0.50 cached in, $8.00 out per 1M |
| Grok 4.7 | `usage.prompt_tokens`, `completion_tokens` plus `reasoning_tokens` | tokens times $2.00 in, $0.50 cached in, $6.00 out per 1M |

- **A cost the provider reports wins.** KodeKey sends one with each JEV call (`usage.cost`). Azure sends none, so for Azure models the cost is the response's tokens times a price:
  yours from `.env`, otherwise the built-in list price. The built-in prices are Azure's Global Standard pay-as-you-go prices from the
  [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) and TypeSafe's list price for JEV, checked on 14 October 2026 (see `shared/pricing.js`).
  Your invoice can differ: Data Zone and Regional deployments cost more, and discounts or committed use cost less.
- A deployment with its own name is still priced when its response names a known model (for example `gpt-4.1-mini`). Otherwise its cost shows **n/a** together with the two variables to set.
- **Reasoning tokens are output.** Grok reports them next to `completion_tokens`, so the game adds them, and never double counts providers that already include them.
- **Cached input** is part of the input that the provider served from its prompt cache, and costs the cached rate. Grok 4.7 caches the repeated prompt, so on later calls most of the input is cached.
- **An unusable reply still counts.** A reasoning model that runs out of tokens before it answers returns nothing usable, but those tokens were billed, so they are in the totals.
- **Not counted:** calls that never got an answer (timeouts, HTTP errors) report no usage, and neither do the one-off calls of `npm run check`, the connection test and call-mode detection.
- A response with no usage block at all is shown as missing tokens, never as zero, and the report says so.

#### Why JEV and Decision 1 report different token counts

For the same application and the same six questions, JEV (through KodeKey) reports about twice the input tokens that Decision 1 does, and far more output tokens.
Each service reports what it counts, and the game shows exactly that, so the numbers are accurate but not comparable one-to-one. The report marks JEV's token and cost cells with an asterisk and explains it in a note under the table.
Measured on 14 October 2026 by sending both services the same requests with one piece changed at a time (tokens in / out):

| Request | JEV via KodeKey | Decision 1 on Azure |
| --- | --- | --- |
| The game's request: the application and 6 questions | 459 / 108 | 219 / 6 |
| The same with 3 questions | 400 / 54 | 149 / 3 |
| The same with 1 question | 363 / 21 | 105 / 1 |
| The application replaced by "x", 6 questions | 381 / 108 | 149 / 6 |
| The application replaced by "x", 1 question | 285 / 21 | 35 / 1 |
| The application plus about 150 tokens of extra text, 6 questions | 610 / 108 | 373 / 6 |

- **Decision 1 counts what you send.** Its input is the tokens of the application plus the questions as JSON (a local tokenizer gives 70 for this application and 143 for the questions; Decision 1 reports 219),
  and each extra token of text adds one. Its output is one token per answer.
- **KodeKey adds a fixed overhead of about 250 input tokens to every request.** Text and questions are counted about as Decision 1 counts them (the extra 150 tokens of text add 151), but even an almost empty
  request, the letter "x" and one tiny question, reports 270. It also counts the JSON text of the answers as output, about 18 tokens each. KodeKey has no native System One route (it answers 404), so JEV can only be reached through its chat route.
- **Costs follow from the counts.** KodeKey prices the tokens it reports (its reported cost is the input tokens times $0.042 per 1M), and Decision 1 is priced the same way from its own count. So although both list $0.042 per 1M input tokens
  with free output, JEV through KodeKey costs about twice as much per decision here (about $0.020 against $0.0095 per 1,000 decisions). That is the overhead. It weighs less as applications get longer, and it says nothing about
  JEV reached some other way, which we could not test.

Something not working? See [Troubleshooting](troubleshooting.md).
