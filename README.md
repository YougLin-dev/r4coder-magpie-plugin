# @r4coder/magpie-plugin

R4 Coder's provider plugin for [magpie](https://usemagpie.ai). It signs in
with an R4 Coder API key, lists the live R4 model catalog, routes requests to
`https://api.r4.codes/v1`, and shows the account's package windows and the
key's spend limit on magpie's Usage page.

Provider id: `r4coder`.

magpie's provider hook is OpenCode-compatible; this plugin follows that hook
shape so magpie can load it, but it runs inside magpie's plugin host and needs
no OpenCode installation. The same package also works in OpenCode if you use
both.

## Install

From the public plugin repository (before the npm release):

```sh
magpie plugin add github:YougLin-dev/magpie-plugin
magpie plugin login r4coder
```

Once published to npm:

```sh
magpie plugin add @r4coder/magpie-plugin
magpie plugin login r4coder
```

From a clone of this repository (the package is dependency-free):

```sh
magpie plugin add .
magpie plugin login r4coder
```

This repository is listed under magpie's **Plugins → Discover → Unofficial**
through the `magpie-plugin` GitHub topic.

OpenCode (optional; the same plugin):

```json
{ "plugin": ["@r4coder/magpie-plugin"] }
```

then `opencode auth login` and pick **R4 Coder API key**.

The plugin has no runtime dependencies and runs in magpie's plugin host (and
in OpenCode, which shares the hook shape).

## Signing in

Create a key at <https://r4.codes/dashboard/api-keys>. R4 Coder keys start
with `coder_`. The key is sent to R4 Coder as `Authorization: Bearer …`
(magpie's OpenAI-compatible client does this from the value the plugin's
loader returns).

## Where the sign-in is kept

The key is stored by the host, not written into a provider config:

- magpie: `~/.config/magpie/plugin-auth.json` (mode 600), as
  `{ "type": "api", "key": "coder_…" }` under `r4coder`.
- OpenCode: its own `auth.json`, in the same `{ "type": "api", … }` shape.

Uninstalling the plugin or running `magpie plugin logout r4coder` removes
the sign-in.

### Migrating from `r4 opencode`

`r4 opencode` writes the key inline as
`provider.r4coder.options.apiKey` in `opencode.json`. Once the plugin is
installed, remove that inline `apiKey` and sign in through the plugin
instead; the plugin's loader supplies the key from auth storage. Keeping
both can make OpenCode use the stale inline key.

## How requests are routed

Requests go to `https://api.r4.codes/v1` using OpenAI Chat Completions
(`@ai-sdk/openai-compatible`). Streaming, tool calls, images and reasoning
are passed through the gateway's usual translation, so Claude Code, Codex,
OpenCode and other agents can all use the same provider.

The model list is live:

- `GET /v1/models` supplies the slug, display name, context window, effort
  tiers and base pricing.
- `GET /v1/models/info` supplies the curated output cap, input modalities
  and effective (time-of-day) pricing.

Both endpoints are already filtered by the key's plan and paid access, so
each account sees exactly the models it can call.

## The usage card

magpie's `magpie quota` / Usage page reads:

- `GET /v1/cli/meta` for the package name and expiry, package limit windows
  (`5 hours`, `7 days`, …), and wallet balance.
- `GET /v1/cli/key` for this key's spend limit, spend, in-flight hold and
  remaining amount.

A key limit is shown as a lifetime `Key limit` window; package windows show
their own reset time. A revoked key is marked as an expired sign-in; a
monitoring key's 403 is reported as an error without marking the sign-in.

## Models and pricing

Model entries use R4's catalog metadata: context window, maximum output,
input modalities (`text`, `image`), effort tiers (`low`, `high`, … as
reasoning variants), and per-million-token prices for input, output, cache
read and cache write. Prices come from `pricing_effective` when the server
provides it, otherwise from the base `pricing` block.

There is no hardcoded model list: the catalog is authoritative. If R4 is
unreachable, magpie keeps the last list it fetched and says why.

## Self-hosted R4 Coder

Set `R4_CODER_BASE_URL` before starting magpie/OpenCode to point the plugin
at another deployment:

```sh
export R4_CODER_BASE_URL=https://r4.example.com
```

The value is the service root; a trailing `/v1` is accepted and normalized.

## Not included

- OAuth or account-password sign-in. R4 Coder's API surface is key-based;
  create a key in the dashboard.
- A static fallback model list. Inventing context or output numbers would
  be worse than showing the live catalog.

## Development

```sh
node --test index.test.mjs
```

The tests mock `fetch` and cover the config merge, loader, catalog mapping,
old-server fallbacks, usage-card mapping and 401/403 handling.
