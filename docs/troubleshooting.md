# Troubleshooting

[Back to the overview](../README.md)

Start with `npm run check`: it calls every desk with a clean and a bad sample application and prints what went wrong.

| Symptom | Likely fix |
| --- | --- |
| The terminal says it cannot read `.env`, or a desk shows "NOT READY, set ..." although you pasted the value | Your Node.js is too old (it needs 20.12 or newer): run `node --version` and update from <https://nodejs.org>. Also check the value sits right after the `=` with no quotes or spaces, and that comments are on their own lines |
| "Port 3000 is busy, trying 3001..." | Not an error. Open the URL the terminal prints |
| `npm run check` says "SKIPPED: set FOUNDRY_API_KEY in .env" | That key line in `.env` is empty. Paste the key and run it again |
| `npm run check` notes "could not list deployments (HTTP 404)" | Harmless. Some resources do not offer that route. The sample calls that follow tell you whether the deployment names are right |
| KodeKey `HTTP 403` saying the key "can only access models=[...]" | Use a model id from the list `npm run check` prints, for example `typesafe/jev-1.13.0` |
| KodeKey `HTTP 400` mentioning `response_format` | JEV needs the typed questions; leave `MODE` unset (or `questions`) |
| Foundry `HTTP 401` | The key must belong to the same resource as the URL or `FOUNDRY_ENDPOINT`. The game already retries once with the other header style |
| Foundry `HTTP 404` / "DeploymentNotFound" | `MODEL_*_MODEL` must be the **deployment name**, not the model name. `npm run check` lists the real ones when the resource allows it |
| A chat error ending "If this deployment only supports the Responses API ..." | Paste the `/openai/v1/responses` URL of that model (or set `MODEL_*_API=responses`) |
| `empty reply (finish_reason=length)` | A reasoning model spent its token budget thinking. Raise `MODEL_*_MAX_TOKENS` or lower `MODEL_*_REASONING_EFFORT` |
| The report mentions retries | Quota or rate limit (429). Raise the deployment's tokens-per-minute or shorten the queue |
| A desk shows *OFFLINE* or *STOPPED* | The reason is printed in the lane, the Case file tab and the report |
| Very slow reasoning model | Use fewer applicants per desk (Setup tab) or a lower reasoning effort |
| Setup says "This server is older than the page" | Restart the server (`npm start`) so it serves the model list |
| "Cleared in" looks far too slow while the average decision is fast | Usually the game tab was in the background; browsers slow timers there. Keep the tab visible during a race |

More on configuration: [Setup and configuration](setup.md).
