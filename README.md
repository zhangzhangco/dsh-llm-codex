# dsh-llm-codex

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local **Codex route** for DeepSeek Harness: it registers one LLM provider
(`codex-local` by default) whose requests go to the Codex CLI installed on this
machine, with an opt-in OpenAI-compatible endpoint as a fallback.

This plugin is not part of the published `@deepseek-ai/*` distribution. It lives
in the `web` profile and is mounted through that profile's patch layer, so the
DSH installation itself is untouched.

Quick start — one command, no patch file to edit:

```sh
dsh plugin --profile web add git+ssh://git@github.com/zhangzhangco/dsh-llm-codex.git
```

The package declares `dsh.bundle.patch`, so `dsh plugin` appends it to the
profile's `dsh.profile.bundles` and its `cordis.patch.yml` mounts the
`llm-codex` row on its own. Restart the profile and the route appears in the
model selector. Other install forms (tarball, linked folder) are in
[Sharing with another machine](#sharing-with-another-machine).

> This package is intentionally **not published to npm** and keeps
> `private: true`. The name `dsh-llm-codex` on npm belongs to an unrelated
> implementation by another author; the field is a guard against publishing over
> it. GitHub is the distribution channel — see
> [Why GitHub and not npm](#why-github-and-not-npm).

## What it is (and is not)

`codex exec` is a **complete agent** with its own tools, sandbox, approvals, and
sign-in. This adapter therefore exposes Codex as a **text-generation route**:

- It forwards the conversation (system prompt, history, tool calls and tool
  results rendered as text) and returns the model's answer.
- DSH tool calls are **not** executed by Codex, and Codex's internal tool use is
  **not** reported back as DSH tool calls. A DSH session on this route keeps its
  own tools, but the Codex side answers from the text it was given.
- Codex's own sandbox decides what it may read or run; the adapter passes
  `-s <sandbox> -C <cwd>`, and `sandbox: read-only` is the default.

Choose the MCP path instead if you want DSH tools driven by Codex, or Codex's
tools exposed as DSH tools.

## Authentication

The route uses the **existing sign-in of the Codex CLI on this machine**
(`$CODEX_HOME/auth.json`, ChatGPT OAuth). No API key is required, and nothing is
copied out of `~/.codex`.

## Model catalog

The provider advertises the models from Codex's own cache,
`$CODEX_HOME/models_cache.json`, with their real context window, reasoning
levels, and input modalities. New models appear after Codex refreshes that cache;
no plugin change is needed. `models` may list extra ids, and unlisted ids still
pass through as unknown models.

## Configuration

Mounted from `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: llm-codex
      name: dsh-llm-codex
      config:
        provider: codex-local
        # Codex's own sandbox (not the harness permission mode). See
        # "Sandbox and file writes" below before choosing a value.
        sandbox: read-only
        ephemeral: true
        transport: auto
        reasoningEffort: ''
        fallback:
          baseURL: ''
          apiKeyEnv: CODEX_FALLBACK_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `codex-local` | Route name shown to the model picker |
| `command` | discovered | Codex CLI to run; empty discovers it (`$CODEX_COMMAND`, `PATH`, known installs) |
| `args` | `[]` | Extra argv passed to `codex exec` before the prompt |
| `model` | empty | Pin one model; empty uses the catalog, then `$CODEX_HOME/config.toml` |
| `reasoningEffort` | empty | Default effort; a session selection wins |
| `sandbox` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access` |
| `cwd` | empty | Codex working root; empty uses the session workspace |
| `ephemeral` | `true` | Run without persisting Codex threads under `$CODEX_HOME` |
| `timeoutMs` | `600000` | Wall-clock budget for one `codex exec` |
| `codexHome` | empty | `$CODEX_HOME` for the child; empty inherits the environment |
| `modelsCachePath` | `$CODEX_HOME/models_cache.json` | Catalog cache |
| `models` | `[]` | Extra ids to advertise when the cache is missing |
| `defaultContextWindow` | `272000` | Capacity fallback for unknown ids |
| `transport` | `auto` | `auto` (CLI, then fallback), `cli` only, or `api` only |
| `fallback.baseURL` | empty | OpenAI-compatible base URL; empty disables the fallback |
| `fallback.apiKeyEnv` | `CODEX_FALLBACK_API_KEY` | Variable holding the fallback key |
| `fallback.model` | empty | Model id for the fallback; empty reuses the request id |
| `fallback.headers` | `{}` | Extra request headers |
| `fallback.timeoutMs` | `300000` | Fallback request budget |

### Sandbox and file writes

`sandbox` selects **Codex's own sandbox** for the CLI route. It is a different
boundary from this harness's permission mode, which keeps gating DSH's own tools
independently; changing one does not change the other.

| Value | Effect on Codex's tools |
|---|---|
| `read-only` | Reads and answers; every file write is refused |
| `workspace-write` | Writes inside the session workspace; other targets stay refused |
| `danger-full-access` | No Codex sandbox at all |

The two sandboxed modes need macOS Seatbelt, applied through `sandbox-exec`. A
host that already runs inside a sandbox cannot apply a nested profile — the call
fails with `sandbox_apply: Operation not permitted` — and then **every**
sandboxed mode refuses writes, no matter which roots are allowed:

```sh
# Prints "sandbox_apply: Operation not permitted" when sandboxed modes cannot work.
sandbox-exec -p '(version 1)(allow default)' /bin/echo ok
```

On such a host only `danger-full-access` lets Codex write, and that means Codex
runs with no filesystem boundary of its own. The plugin checks this capability at
load time: when a sandboxed mode is configured on a host that cannot create one,
startup logs a warning naming the fix, and a sandbox refusal during a run adds the
same advice to the failure. A refusal that arrives as ordinary assistant prose
("the filesystem is read-only") rarely carries a machine-checkable signal, so the
capability probe, not that prose, is what drives the advice.

### Enabling the fallback

Set a base URL and put the key in the named environment variable. The Models
settings page and the credential store can supply the variable; the value is
resolved per request.

```yaml
        fallback:
          baseURL: https://api.openai.com/v1
          apiKeyEnv: OPENAI_API_KEY
```

The key resolves per request through the harness credential seam when that
service is mounted — so a value written on the Models page applies to the next
request with no restart — and falls back to the process environment otherwise.
The endpoint is used **without** an `Authorization` header when no value
resolves, which is what keyless servers (for example a local llama.cpp) expect.

A local llama.cpp server works as-is. It streams `reasoning_content`, which maps
to harness reasoning blocks, and ignores both the requested model id and any
`Authorization` header:

```yaml
        transport: api
        fallback:
          baseURL: http://gpudev:8088/v1
          apiKeyEnv: CODEX_FALLBACK_API_KEY
```

Note that the provider still advertises the Codex model catalog, so a model id
such as `gpt-6-astra` may be sent to an endpoint serving a different model. Use
`fallback.model` to pin the id the fallback endpoint expects, or point
`modelsCachePath`/`models` at ids that match it.

### A local endpoint as its own selectable route

Mount the plugin a second time with `transport: api` to get a route that never
touches Codex. It **discovers the models the endpoint serves** from
`/v1/models`, so the picker lists what that endpoint really answers with
(including the capacity a llama.cpp server reports as `meta.n_ctx`) instead of
Codex's catalog:

```yaml
- insert:
    - id: llm-codex
      name: dsh-llm-codex
      config:
        provider: codex-local
        sandbox: read-only
        transport: auto
    - id: llm-gpudev
      name: dsh-llm-codex
      config:
        provider: gpudev
        transport: api
        fallback:
          baseURL: http://gpudev:8088/v1
          apiKeyEnv: GPUDEV_API_KEY
```

That yields two providers: **Codex (local)** with the Codex models, and
**gpudev:8088** with `qwen3.8-27b-q5`. An endpoint-only route takes its display
name from the endpoint host, needs no credential, and declares no image
capability because the fallback path sends text only.

Discovery is advisory and cached for a minute: an unreachable endpoint leaves
the list empty rather than failing model resolution, and a failed refresh keeps
the previous list. Point the same row at any OpenAI-compatible server.

When an endpoint-only route has nothing to discover, it falls back to
`fallback.model`, then `models`. Setting `fallback.model` also pins the id sent
on the wire; when it is empty, the id the caller selected is sent as-is, which
keyless servers such as llama.cpp ignore in favour of the single loaded model.

`transport: auto` tries the CLI first and falls back only when the CLI produced
**nothing** and failed with `AUTH`, `MISSING_CREDENTIAL`, `TRANSPORT`, `TIMEOUT`,
`INVALID_REQUEST`, or `EMPTY_RESPONSE`. A failure after partial output is
returned as-is, so no content is ever duplicated. `transport: api` routes every
request to the endpoint, bypassing Codex.

## Install / update

Every form below is a `dsh plugin` call, which forwards to pnpm in the profile
directory and then reconciles `dsh.profile.bundles` against what is installed.
Because this package declares `dsh.bundle.patch`, the mount row is added for you
— there is no `cordis.patch.yml` edit in any install path.

For local development, install this directory as a **link** dependency so edits
take effect on the next load with no reinstall:

```sh
dsh plugin --profile web add link:~/src/dsh-llm-codex
```

`dsh plugin` anchors a relative `file:`/`link:` spec to your **current
directory**, not the profile, so run it from outside the profile when using a
relative path.

An empty `baseURL` plus `transport: cli` is enough to keep the plugin offline.
A restart of the profile is required for a mount to take effect.

## Why GitHub and not npm

There is no official DSH plugin registry: a plugin is an ordinary package, and
discovery happens through the GitHub `dsh-plugin` topic. This repository is
distributed that way, and `private: true` stays set for one concrete reason —
the name `dsh-llm-codex` on npm is already taken by an unrelated implementation
(`yequ172672/dsh-codex-subscription`). Publishing under the same name would
either fail or collide with a package users already have. Install from the git
repository instead; the `dsh-plugin` topic is what makes it discoverable.

## Sharing with another machine

The plugin is **portable**: it discovers the Codex CLI at load time (the
configured `command`, then `$CODEX_COMMAND`, then `PATH`, then the known install
locations), reads the model catalog from that machine's `$CODEX_HOME`, and
resolves the harness packages from the receiving DSH installation. Nothing here
hard-codes this machine's paths, so the same package works on any Mac with DSH
and a signed-in Codex.

All three options below are a single `dsh plugin --profile web add` call. The
package carries its own `cordis.patch.yml` and declares `dsh.bundle.patch`, so
the `llm-codex` mount row is composed from the bundle layer — do **not** also
hand-write that row, and see
[Upgrading from 0.1.x](#upgrading-from-01x) if you installed before 0.2.0.

### Option A — a tarball (simplest)

Build the package, copy the `.tgz` to the other Mac (AirDrop, `scp`, USB), then
on that machine:

```sh
dsh plugin --profile web add /path/to/dsh-llm-codex-0.2.0.tgz
```

pnpm copies the tarball into its virtual store, so the `.tgz` is only needed for
the install. Re-run the same command with a newer tarball to update. Nothing in
the receiving profile needs editing: the mount row comes from the package.

`npm pack` in this directory produces that tarball, and it works even though
`private: true` is set — the field only blocks publishing to a registry.

### Option B — the git repository

Install straight from this repository. SSH is the reliable form: it uses the
key already configured for GitHub, while the `https` form blocks on credentials
when the machine has none cached.

```sh
dsh plugin --profile web add git+ssh://git@github.com/zhangzhangco/dsh-llm-codex.git
```

The first install resolves and clones (about a minute here). Update later with:

```sh
dsh plugin --profile web update dsh-llm-codex
```

If pnpm prints an `allowBuilds` key — it blocks dependency build scripts by
default — add that key to `~/.dsh/profiles/web/pnpm-workspace.yaml` and re-run.
This package ships no build step, so a plain install normally needs nothing.

### Option C — a folder for development

Copy the directory over and link it, so edits propagate without reinstalling —
the `link:` form in [Install / update](#install--update).

### Upgrading from 0.1.x

Before 0.2.0 the package declared no `dsh.bundle`, so every install was finished
by hand: a profile patch row in `~/.dsh/profiles/<profile>/cordis.patch.yml`
with `id: llm-codex`. From 0.2.0 the bundle supplies that row, and **two entries
with the same id are fatal at boot** — the loader throws
`duplicate loader entry id: llm-codex` and the profile does not start.

So when moving from 0.1.x, delete the `insert` row for `llm-codex` from your own
patch file and keep only the per-machine overrides as an id-targeted patch:

```yaml
- id: llm-codex
  config:
    sandbox: danger-full-access
```

An id-targeted patch replaces the whole `config` value; the Schemastery schema
in `config.js` fills every omitted key with its default, so a partial override
is enough. Check the composed tree without booting anything:

```sh
dsh --profile web --dump-config
```

### What does not transfer

- **The credential.** `apiKeyEnv` names a reference; the value lives in that
  machine's environment or credential store.
- **`$CODEX_HOME`.** The Codex sign-in and model cache are per machine — run
  `codex login` there if Codex is not signed in yet.
- **The profile's `link:` path.** `package.json` records an absolute path for a
  linked dependency; on the new machine install with the tarball or git form
  instead of copying that path.

## Verification

- `dsh --profile web --dump-config` — the `llm-codex` row is composed.
- Boot the profile; startup logs
  `dsh-llm-codex: route codex-local ready (transport=…, command=…)`, which names
  the Codex CLI that discovery picked.
- The model picker lists the Codex models under **Codex (local)**.
- One call: `codex exec --json --ephemeral -s read-only -C "$PWD" "Reply with exactly: pong"`.

## Known limits

- **No incremental streaming.** `codex exec --json` emits completed items, not
  token deltas, so a turn arrives as whole-message deltas. Usage and finish
  reasons are exact.
- **`--ephemeral` by default.** Each call is a fresh Codex thread with the
  conversation replayed as prompt text; no resume, so Codex-side memory does not
  carry across turns.
- **No images.** Image blocks are rendered as `[image attachment …]`
  placeholders; `codex exec` takes images as file arguments, not JSON items.
- **Tool schemas are ignored on the CLI path.** The fallback path does send
  them and maps streamed tool calls back.
- **Codex's tools run outside the harness sandbox.** On the CLI path Codex is a
  separate process with its own sandbox, so the harness workspace boundary does
  not constrain it. Where Codex cannot create its own sandbox, writes require
  `danger-full-access` and the run is unconfined; the fallback path executes no
  tools at all.

## True streaming through App Server

Set `cliBackend: app-server` in the `llm-codex` config to use Codex's stdio
App Server protocol. The default remains `exec` for compatibility. The existing
`transport: auto | cli | api` setting continues to select CLI versus API routing.
`args` applies only to exec; `appServerArgs` applies only to app-server (for
example `-c` overrides). Existing exec-specific flags are never forwarded blindly.

Each request owns an isolated process and ephemeral thread (unless `ephemeral`
is explicitly disabled). Text deltas are forwarded immediately; completion only
adds an unreceived tail. Visible reasoning summaries have separate block indices.
The adapter preserves model, effort, cwd, CODEX_HOME and sandbox settings.
App Server uses `approvalPolicy: never`: sandbox restrictions remain in force,
but it cannot ask for elevated permissions. Unexpected interactive requests fail
closed; this is not an approval bridge. Codex tools still operate outside DSH's
tool-call transcript, exactly as with the exec backend.

Cancellation, timeout, early consumer exit and completion clean up the process.
No automatic retry through exec is made. Existing API fallback is allowed only
before output, when configured. Network/WebSocket retries inside Codex are a
separate source of latency; switching the interface does not eliminate them.

Two failure modes are handled explicitly, both verified against a real turn:

- The protocol has **no top-level fatal error notification**, so a thread the
  server closes without a `turn/completed` would otherwise stall until
  `timeoutMs` (10 minutes by default). A `thread/closed` for the active thread
  now fails the request immediately. A normal ephemeral turn never emits it —
  observed ordering puts `turn/completed` last.
- `error` notifications with `willRetry: true` are the transport retries
  (WebSocket → HTTPS) and are **not** failures; the verdict still arrives through
  `turn/completed`. The first three are echoed to stderr, truncated, so a turn
  whose first token took two minutes is explainable in the log instead of
  looking like a silent stall.

Images retain the old textual attachment placeholder behavior; this change does
not implement native image attachment forwarding.

Protocol reference: https://learn.chatgpt.com/docs/app-server

Verified against Codex CLI 0.154.0 on macOS in two independent ways:

- The generated protocol bundle (`codex app-server generate-json-schema --out DIR
  --experimental`) confirms every method and field this module uses: the client
  requests `initialize` / `initialized` / `thread/start` / `turn/start` /
  `turn/interrupt`, the notifications `item/agentMessage/delta`,
  `item/reasoning/summaryTextDelta`, `item/completed`, `thread/tokenUsage/updated`
  and `turn/completed`, and the exact param names (`clientInfo`, `threadId`,
  `turnId`, `itemId`, `delta`, `summaryIndex`, `input`, `effort`, `sandbox`,
  `approvalPolicy`, `ephemeral`). `AskForApproval` really does accept `never` and
  `SandboxMode` really does accept the three CLI sandbox names.
- A live handshake and streaming turn: `initialize` → `initialized` →
  `thread/start` → `turn/start` were accepted, and one real turn delivered
  **565 incremental text deltas** (612 characters) spread over 23 seconds rather
  than a single blob. The first token, however, arrived at **122s** because Codex
  retried its transport (WebSocket → HTTPS) before generating; that latency is in
  Codex's own network stack and is **not** removed by this backend.

Development: `npm ci --ignore-scripts`, then `npm test`.
Opt-in real request: `node scripts/probe-stream.mjs <model>` (uses CLI sign-in).
Rollback: set `cliBackend: exec` and restart DSH. The profile package.json and
pnpm-lock.yaml are backed up next to themselves as `*.bak-<timestamp>` before the
link install, so a package installation rollback means restoring those two files
and running `pnpm install`.
