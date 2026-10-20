import assert from "node:assert/strict";
import test from "node:test";

import { R4CoderPlugin, _internal } from "./index.mjs";

const BASE = "https://api.r4.codes";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function mockFetch(t, routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const u = new URL(url);
    calls.push({ url, path: u.pathname, search: u.search, init });
    const route = routes[u.pathname] ?? routes[`${u.pathname}${u.search}`];
    if (!route) {
      return jsonResponse({ error: { message: `no route for ${u.pathname}` } }, { status: 404 });
    }
    return typeof route === "function" ? route({ url, init, u }) : route;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test("shape: r4coder API-key provider", async () => {
  const plugin = await R4CoderPlugin();
  assert.equal(plugin.auth.provider, "r4coder");
  assert.equal(plugin.provider.id, "r4coder");
  assert.equal(plugin.auth.methods.length, 1);
  assert.equal(plugin.auth.methods[0].type, "api");
  assert.match(plugin.auth.methods[0].placeholder, /coder_/);
});

test("config: registers r4coder defaults and keeps user config", async () => {
  const plugin = await R4CoderPlugin();

  const empty = {};
  await plugin.config(empty);
  assert.equal(empty.provider.r4coder.name, "R4 Coder");
  assert.equal(empty.provider.r4coder.npm, "@ai-sdk/openai-compatible");
  assert.equal(empty.provider.r4coder.api, `${BASE}/v1`);

  const mine = {
    provider: {
      r4coder: {
        name: "Mine",
        models: { "glm-5.3": { name: "GLM" } },
      },
    },
  };
  await plugin.config(mine);
  assert.equal(mine.provider.r4coder.name, "Mine");
  assert.equal(mine.provider.r4coder.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(mine.provider.r4coder.models, { "glm-5.3": { name: "GLM" } });
});

test("loader: returns the R4 base URL, key and client header", async () => {
  const plugin = await R4CoderPlugin();
  const opts = await plugin.auth.loader(async () => ({ type: "api", key: "coder_test" }));
  assert.equal(opts.baseURL, `${BASE}/v1`);
  assert.equal(opts.apiKey, "coder_test");
  assert.equal(opts.headers["x-r4-client"], _internal.CLIENT);
  assert.deepEqual(await plugin.auth.loader(async () => null), {});
});

test("models: maps the live catalog, pricing and effort tiers", async (t) => {
  const calls = mockFetch(t, {
    "/v1/models": jsonResponse({
      object: "list",
      data: [
        {
          id: "glm-5.3",
          display_name: "GLM 5.3",
          context_window: 131072,
          effort: { tiers: ["low", "high"], default: "high" },
          pricing: {
            input_per_m_tokens: "1.2",
            output_per_m_tokens: "6",
            cache_read_per_m_tokens: "0.12",
            cache_creation_per_m_tokens: "1.5",
          },
        },
      ],
    }),
    "/v1/models/info": jsonResponse({
      models: [
        {
          slug: "glm-5.3",
          display_name: "GLM 5.3",
          context_window: 131072,
          max_output_tokens: 78832,
          input_modalities: ["text", "image"],
          pricing: {
            input_per_m_tokens: "1.2",
            output_per_m_tokens: "6",
            cache_read_per_m_tokens: "0.12",
            cache_creation_per_m_tokens: "1.5",
          },
          pricing_effective: {
            input_per_m_tokens: "0.6",
            output_per_m_tokens: "3",
            cache_read_per_m_tokens: "0.06",
            cache_creation_per_m_tokens: "0.75",
          },
        },
      ],
    }),
  });

  const plugin = await R4CoderPlugin();
  const models = await plugin.provider.models(
    { models: {} },
    { auth: { type: "api", key: "coder_test" } },
  );
  const m = models["glm-5.3"];
  assert.equal(m.name, "GLM 5.3");
  assert.equal(m.api.url, `${BASE}/v1`);
  assert.equal(m.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(m.limit.context, 131072);
  assert.equal(m.limit.output, 78832);
  assert.equal(m.cost.input, 0.6);
  assert.equal(m.cost.output, 3);
  assert.equal(m.cost.cache.read, 0.06);
  assert.equal(m.cost.cache.write, 0.75);
  assert.equal(m.capabilities.reasoning, true);
  assert.deepEqual(m.variants, {
    low: { reasoningEffort: "low" },
    high: { reasoningEffort: "high" },
  });
  assert.equal(m.capabilities.input.image, true);
  assert.equal(m.capabilities.attachment, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.authorization, "Bearer coder_test");
  assert.equal(calls[0].init.headers["x-r4-client"], _internal.CLIENT);
});

test("models: falls back to /v1/models when /v1/models/info is missing", async (t) => {
  mockFetch(t, {
    "/v1/models": jsonResponse({
      data: [{ id: "m", display_name: "M", context_window: 1000, effort: { tiers: ["low"] } }],
    }),
    "/v1/models/info": jsonResponse({ error: { message: "not found" } }, { status: 404 }),
  });
  const plugin = await R4CoderPlugin();
  const models = await plugin.provider.models(
    { models: {} },
    { auth: { type: "api", key: "coder_test" } },
  );
  assert.equal(models.m.limit.context, 1000);
  assert.equal(models.m.limit.output, 0);
  // no curated modalities: unknown, not "text only"
  assert.equal(models.m.capabilities.input.image, undefined);
  assert.equal(models.m.capabilities.attachment, undefined);
});

test("models: a rejected key carries signIn=expired", async (t) => {
  mockFetch(t, {
    "/v1/models": jsonResponse({ error: { message: "Invalid API key" } }, { status: 401 }),
    "/v1/models/info": jsonResponse({ error: { message: "Invalid API key" } }, { status: 401 }),
  });
  const plugin = await R4CoderPlugin();
  await assert.rejects(
    () => plugin.provider.models({ models: {} }, { auth: { type: "api", key: "coder_dead" } }),
    (e) => e.status === 401 && e.signIn === "expired" && /Invalid API key/.test(e.message),
  );
});

test("models: no key returns the list it was given", async () => {
  const plugin = await R4CoderPlugin();
  const given = { models: { m: { id: "m" } } };
  assert.equal(await plugin.provider.models(given, { auth: null }), given.models);
});

test("usage: maps package windows, wallet and this key's limit", async (t) => {
  const resetsAt = "2026-10-20T06:00:00.000Z";
  mockFetch(t, {
    "/v1/cli/meta": jsonResponse({
      key: { name: "default", start: "coder_ab" },
      plan: {
        package_name: "Pro",
        remaining_usd: "8.5",
        expires_at: "2026-12-01T00:00:00.000Z",
        limit_windows: [
          {
            duration_seconds: 18000,
            ceiling_usd: "5",
            consumed_usd: "1.5",
            remaining_usd: "3.5",
            resets_at: resetsAt,
          },
        ],
        grants: [
          {
            limit_windows: [
              {
                duration_seconds: 18000,
                ceiling_usd: "5",
                consumed_usd: "1.5",
                remaining_usd: "3.5",
                resets_at: resetsAt,
              },
            ],
          },
        ],
      },
      wallet: { balance_usd: "12.34" },
    }),
    "/v1/cli/key": jsonResponse({
      key: { name: "default", start: "coder_ab" },
      limit_usd: "10",
      spent_usd: "2.5",
      held_usd: "0.1",
      remaining_usd: "7.4",
      today: { request_count: 3, charged_usd_total: "0.5" },
    }),
  });

  const plugin = await R4CoderPlugin();
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "coder_test" }));
  assert.equal(u.plan, "Pro");
  assert.equal(u.user, "default (coder_ab)");
  assert.equal(u.until, "2026-12-01T00:00:00.000Z");
  assert.equal(u.balance, "$12.34");
  assert.equal(u.signIn, "kept");
  assert.equal(u.error, undefined);

  const five = u.windows.find((w) => w.name === "5 hours");
  assert.equal(five.used, 30);
  assert.equal(five.amount, 1.5);
  assert.equal(five.limit, 5);
  assert.equal(five.unit, "USD");
  assert.equal(five.span, 18000);
  assert.equal(five.resetsAt, resetsAt);

  const key = u.windows.find((w) => w.name === "Key limit");
  assert.ok(Math.abs(key.used - 26) < 1e-9);
  assert.equal(key.amount, 2.6);
  assert.equal(key.limit, 10);
  assert.equal(key.span, 0);
});

test("usage: sums the same window across grants and keeps the soonest reset", async (t) => {
  mockFetch(t, {
    "/v1/cli/meta": jsonResponse({
      plan: {
        package_name: "Mini +1",
        grants: [
          {
            limit_windows: [
              {
                duration_seconds: 18000,
                ceiling_usd: "5",
                consumed_usd: "1",
                resets_at: "2026-10-20T08:00:00.000Z",
              },
            ],
          },
          {
            limit_windows: [
              {
                duration_seconds: 18000,
                ceiling_usd: "10",
                consumed_usd: "2",
                resets_at: "2026-10-20T06:00:00.000Z",
              },
            ],
          },
        ],
      },
    }),
    "/v1/cli/key": jsonResponse({ limit_usd: null, spent_usd: "3", held_usd: "0" }),
  });
  const plugin = await R4CoderPlugin();
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "coder_test" }));
  const five = u.windows.find((w) => w.name === "5 hours");
  assert.equal(five.amount, 3);
  assert.equal(five.limit, 15);
  assert.equal(five.used, 20);
  assert.equal(five.resetsAt, "2026-10-20T06:00:00.000Z");
  assert.equal(
    u.windows.find((w) => w.name === "Key limit"),
    undefined,
  );
});

test("usage: falls back to the head grant's limit_windows when grants carry none", async (t) => {
  mockFetch(t, {
    "/v1/cli/meta": jsonResponse({
      plan: {
        package_name: "Pro",
        grants: [{ limit_windows: [] }],
        limit_windows: [
          {
            duration_seconds: 604800,
            ceiling_usd: "20",
            consumed_usd: "5",
            resets_at: "2026-10-27T00:00:00.000Z",
          },
        ],
      },
    }),
    "/v1/cli/key": jsonResponse({ limit_usd: null, spent_usd: "5", held_usd: "0" }),
  });
  const plugin = await R4CoderPlugin();
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "coder_test" }));
  const week = u.windows.find((w) => w.name === "7 days");
  assert.equal(week.amount, 5);
  assert.equal(week.limit, 20);
  assert.equal(week.used, 25);
});

test("usage: no plan and no wallet but a key limit still shows the key window", async (t) => {
  mockFetch(t, {
    "/v1/cli/meta": jsonResponse({ key: { name: "ci", start: "coder_ci" } }),
    "/v1/cli/key": jsonResponse({ limit_usd: "2", spent_usd: "0.5", held_usd: "0" }),
  });
  const plugin = await R4CoderPlugin();
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "coder_test" }));
  assert.equal(u.plan, "R4 Coder");
  assert.equal(u.balance, undefined);
  assert.equal(u.windows.length, 1);
  assert.equal(u.windows[0].name, "Key limit");
  assert.equal(u.windows[0].used, 25);
});

test("usage: a rejected key is marked expired", async (t) => {
  mockFetch(t, {
    "/v1/cli/meta": jsonResponse({ error: { message: "Invalid API key" } }, { status: 401 }),
    "/v1/cli/key": jsonResponse({ error: { message: "Invalid API key" } }, { status: 401 }),
  });
  const plugin = await R4CoderPlugin();
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "coder_dead" }));
  assert.equal(u.signIn, "expired");
  assert.match(u.error, /rejected this API key/);
});

test("usage: a monitoring key's 403 is an error, not an expired sign-in", async (t) => {
  mockFetch(t, {
    "/v1/cli/meta": jsonResponse({ error: { message: "monitoring key" } }, { status: 403 }),
    "/v1/cli/key": jsonResponse({ error: { message: "monitoring key" } }, { status: 403 }),
  });
  const plugin = await R4CoderPlugin();
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "coder_monitor" }));
  assert.equal(u.signIn, "kept");
  assert.match(u.error, /can't show this key's usage/);
});

test("usage: one endpoint missing still shows the other", async (t) => {
  mockFetch(t, {
    "/v1/cli/meta": jsonResponse({ error: { message: "not found" } }, { status: 404 }),
    "/v1/cli/key": jsonResponse({ limit_usd: "4", spent_usd: "1", held_usd: "0" }),
  });
  const plugin = await R4CoderPlugin();
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "coder_test" }));
  assert.equal(u.windows.length, 1);
  assert.equal(u.windows[0].name, "Key limit");
  assert.equal(u.windows[0].used, 25);
});

test("helpers: USD, window names and base URL override", () => {
  assert.equal(_internal.usd(12.34), "$12.34");
  assert.equal(_internal.usd(0.1234), "$0.1234");
  assert.equal(_internal.usd(-0.5), "-$0.5000");
  assert.equal(_internal.windowName(18000), "5 hours");
  assert.equal(_internal.windowName(86400), "1 day");
  assert.equal(_internal.windowName(5400), "90 minutes");

  const previous = process.env.R4_CODER_BASE_URL;
  try {
    process.env.R4_CODER_BASE_URL = "https://r4.example/v1/";
    assert.equal(_internal.baseURL(), "https://r4.example");
    assert.equal(_internal.apiBase(), "https://r4.example/v1");
    process.env.R4_CODER_BASE_URL = "https://r4.example/proxy";
    assert.equal(_internal.apiBase(), "https://r4.example/proxy/v1");
  } finally {
    if (previous === undefined) delete process.env.R4_CODER_BASE_URL;
    else process.env.R4_CODER_BASE_URL = previous;
  }
});
