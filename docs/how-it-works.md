# How it works

[Back to the overview](../README.md)

## The race in one minute

Three approvers sit at desks in a hall. Each has the **same queue of applicants** and decides, one paper at a time, whether to **approve or reject**.
The approver backed by the faster model clears its queue first.

The page never talks to a model directly. It asks the small server on your machine, and the server calls the model with the keys from `.env`:

```
browser (the game)  ->  local server (127.0.0.1)  ->  KodeKey / Azure AI Foundry
        ^                       |                         (JEV, Decision 1, GPT, Grok ...)
        '------ decision + measured latency, tokens ------'
```

In demo mode the server fakes the model calls instead; see [Setup](setup.md#1-try-it-without-keys).

## How to read the race

- **Every desk gets identical applications in the same order** (seeded, see [Queue seed](#queue-seed)).
- Each applicant has a hidden ground truth. Accuracy is checked against it, including *wrongly approved* cases, the costly kind.
- **Cleared in** is wall-clock time and includes a small fixed animation cost per applicant, the same for every desk
  (Standard pace: 230 ms; `Benchmark` pace removes it), plus the browser-to-server round trip of every decision (negligible when the server runs on your own machine,
  noticeable when it is hosted far from you, for example on Azure). **Avg decision / P95** are pure model latency.
- Latency is measured on the server around each model call. Retries and their backoff are included, because the approver
  really waited for them. One-off connection warm-up and call-mode detection are not counted.
- A desk whose key is wrong or whose model keeps failing **stops and is never ranked**. Failing fast cannot win the race.
- After the race, the report shows the speed-up, a bar chart, accuracy, tokens and cost (per 1,000 decisions too), and can be exported as JSON.
  Where the tokens and costs come from is in [How cost and tokens are measured](setup.md#how-cost-and-tokens-are-measured).
- Keep the game tab visible while racing: browsers slow timers in background tabs, which inflates *Cleared in* (the per-decision numbers are unaffected).

## How each model is asked

The rulebook has six atomic rules. Reject if **any** rule is violated. The *Rulebook* tab in the game shows the exact requests.

| # | Rule | What it checks |
| --- | --- | --- |
| 1 | Forged documents | The passport or entry permit shows signs of forgery, alteration, or tampering. |
| 2 | Expired documents | The passport or entry permit is expired. |
| 3 | Prohibited goods | The applicant declares weapons, explosives, narcotics, or other prohibited goods. |
| 4 | Watchlist match | The security check reports a match with the watchlist. |
| 5 | No sponsor for work | The applicant intends to work in Novaria and has no sponsor letter. |
| 6 | Contradictory story | The applicant statement contradicts the stated purpose of visit. |

- **LLM desks** (Chat Completions or Responses API) get all rules in one prompt and must answer `APPROVE` or `REJECT`. Nothing else
  is requested (no JSON, no reasoning text), which is the fastest sensible way to use an LLM for this.
- **System One desks** (JEV, Decision 1) get the application plus **one Noul (yes/no) question per rule**, all answered in parallel
  in a single request. The game combines the probabilities in code (reject when any rule is likely violated), which is how TypeSafe recommends using System One.

The applications are semantic on purpose (no date maths, counting or arithmetic). Those are documented weak spots of `jev-1.13`
and would turn the race into a test of something else. About 40% of applications include a harmless-but-suspicious *decoy*
(for example "name similar to a watchlist entry, cleared") so keyword spotting is not enough.

This is a demonstration on one small, synthetic task, not a general benchmark of the models.

## Queue seed

The queue of applicants is generated from a number called the **seed**. The same seed with the same *Applicants per desk* gives exactly the same applicants in the same order,
so you can replay a queue and compare runs fairly. A different seed, or a different queue size, gives a different queue.

- **Where it is set:** Setup tab, *Queue seed*. **New seed** picks a random one, and so does *Run again with a new queue* in the report. A random seed is chosen every time the page loads;
  it is not saved between visits. It is shown on the stage wall and saved in the exported JSON, so a run can be reproduced.
- **What the code does with it:** `generatePapers(seed, count)` in [`shared/rulebook.js`](../shared/rulebook.js) starts a small seeded random number generator
  (`makeRng(seed)`, the mulberry32 algorithm) and draws every choice from it: exactly `round(count x 0.45)` applicants are rejections spread across the six rules
  (each has roughly a 15% chance of breaking a second rule), the rest are approvals, and about 40% of applicants also carry a decoy. Names, origins and statements come from the same generator.
- **What it does not do:** the seed never reaches the server or the models, and it does not control the models. Latency and answers still vary from run to run.

## Under the hood

### Project layout

```
server.js            entry point (static files + /api)
server/              config, HTTP helpers, runtime and providers (llm, jev, mock), usage control (usage.js, usage-store.js)
shared/rulebook.js   rules, applications generator, prompts; used by the server and the browser
public/              the game: canvas renderer, race engine, UI, audio
scripts/check.js     npm run check
test/                node --test (rulebook, config, providers, line-up, HTTP app, race engine, usage control)
docs/                this documentation
```

`npm test` runs the suite. It uses throwaway local servers, never your keys or the real services.

### Security notes

- Keys stay in `.env` on the server; the browser never receives them, and keys echoed back by an upstream error are redacted.
- The line-up picker works by name only: the server accepts just the model names defined in `.env` and ignores any URL, key or header a page sends.
- The server listens on `127.0.0.1`, answers only same-origin API calls and loopback `Host` headers, requires JSON bodies and caps their size.
- Ground truth is never sent to a model. Only the application fields are forwarded.
- Do not commit `.env`. It is listed in `.gitignore`.
- The API spends your credits and has no login. By default, keep `HOST=127.0.0.1` so it is reachable only from your own machine.
  It can also be hosted publicly without a login by enabling **usage control**, which adds server-enforced per-visitor and
  app-wide daily race caps backed by Azure Table Storage; see [Setup: protected hosted mode](setup.md#3-run-it-as-a-protected-public-demo).
  Never make the server reachable from a network with usage control disabled.
