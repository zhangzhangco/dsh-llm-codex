# dsh-llm-codex

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local **Codex route** for DeepSeek Harness: it registers one LLM provider
(`codex-local` by default) whose requests go to the Codex CLI installed on this
machine, with an opt-in OpenAI-compatible endpoint as a fallback.

This plugin is not part of the published `@deepseek-ai/*` distribution. It lives
in the `web` profile and is mounted through that profile's patch layer, so the
DSH installation itself is untouched.

Quick start: install the package with
`dsh plugin --profile web add <path-or-url>`, then add the mount row to the
profile patch file. Both forms are in
[Sharing with another machine](#sharing-with-another-machine).

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

`transport: auto` tries the CLI first and falls back only when the CLI produced
**nothing** and failed with `AUTH`, `MISSING_CREDENTIAL`, `TRANSPORT`, `TIMEOUT`,
`INVALID_REQUEST`, or `EMPTY_RESPONSE`. A failure after partial output is
returned as-is, so no content is ever duplicated. `transport: api` routes every
request to the endpoint, bypassing Codex.

## Install / update

Local development installs this directory as a **link** dependency, so edits here
take effect on the next load with no reinstall:

```sh
dsh plugin --profile web add link:~/.dsh/profiles/web/plugins/dsh-llm-codex
```

An empty `baseURL` plus `transport: cli` is enough to keep the plugin offline.

## Sharing with another machine

The plugin is **portable**: it discovers the Codex CLI at load time (the
configured `command`, then `$CODEX_COMMAND`, then `PATH`, then the known install
locations), reads the model catalog from that machine's `$CODEX_HOME`, and
resolves the harness packages from the receiving DSH installation. Nothing here
hard-codes this machine's paths, so the same package works on any Mac with DSH
and a signed-in Codex.

### Option A — a tarball (simplest)

Build the package, copy the `.tgz` to the other Mac (AirDrop, `scp`, USB), then
on that machine:

```sh
dsh plugin --profile web add /path/to/dsh-llm-codex-0.1.1.tgz
```

Then add the mount row to that machine's
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: llm-codex
      name: dsh-llm-codex
      config:
        provider: codex-local
        sandbox: read-only
        transport: auto
        fallback:
          baseURL: ''
          apiKeyEnv: CODEX_FALLBACK_API_KEY
```

pnpm copies the tarball into its virtual store, so the `.tgz` is only needed for
the install. Re-run the same command with a newer tarball to update.

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

Copy the directory over and link it, so edits propagate without reinstalling:

```sh
dsh plugin --profile web add link:~/src/dsh-llm-codex
```

`dsh plugin` anchors a relative `file:`/`link:` spec to your **current
directory**, not the profile, so run it from outside the profile when using a
relative path.

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
