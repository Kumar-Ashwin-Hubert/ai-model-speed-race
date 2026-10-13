# Setup and configuration

[Back to the overview](../README.md)

How to run the game with simulated models (no keys) or with real ones, and how to configure it.

## Requirements

- **Node.js 20.12 or newer.** Check with `node --version`; download it from <https://nodejs.org>. There is nothing else to install:
  the game has no dependencies, so there is no `npm install` step.
- For real models: a **KodeKey** token (for JEV) and/or a key for an **Azure AI Foundry** resource (for Microsoft Decision 1, GPT, Grok and others).

## 1. Try it without keys

```bash
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
| `MODEL_<NAME>_PRICE_IN`, `_PRICE_OUT` | USD per 1M tokens, enables the cost columns. JEV defaults to its list price ($0.042 in, output free) |

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
| `REQUEST_TIMEOUT_MS`, `MAX_RETRIES` | Per-request timeout (60 s) and retries for 429 / 5xx / network errors (2) |
| `PORT`, `HOST`, `MOCK_MODE` | Server options. `HOST` defaults to `127.0.0.1`; keep it that way, the API spends your credits |

### How JEV is reached through KodeKey

`https://api.ai.kodekloud.com` is a LiteLLM gateway, which speaks the OpenAI format. It serves JEV as a chat model whose typed
questions travel in `response_format`:

- `POST /v1/chat/completions` with the application as the user message and `response_format: { "type": "questions", "questions": { ... } }`
  (the *Rulebook* tab in the game shows the exact body).
- The reply content is a JSON map of answers, one probability per question. The usage block carries the token counts used for the cost estimate.
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

Something not working? See [Troubleshooting](troubleshooting.md).
