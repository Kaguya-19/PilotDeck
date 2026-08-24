import assert from "node:assert/strict";
import test from "node:test";

import { parseToolsConfig } from "../../../src/pilot/config/parseToolsConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("web search can be explicitly disabled without discarding provider config", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig({
    webSearch: {
      enabled: false,
      provider: "tavily",
      apiKey: "test-key",
      endpoint: "https://example.test/search",
    },
  }, diagnostics);

  assert.deepEqual(config, {
    webSearch: {
      enabled: false,
      provider: "tavily",
      apiKey: "test-key",
      endpoint: "https://example.test/search",
    },
  });
  assert.deepEqual(diagnostics, []);
});

test("web search enabled remains optional for backwards compatibility", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig({
    webSearch: { provider: "glm" },
  }, diagnostics);

  assert.deepEqual(config, { webSearch: { provider: "glm" } });
  assert.deepEqual(diagnostics, []);
});

test("web search enabled must be a boolean", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  parseToolsConfig({
    webSearch: { enabled: "false" },
  }, diagnostics);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "TOOLS_WEB_SEARCH_ENABLED_INVALID");
  assert.equal(diagnostics[0]?.severity, "fatal");
});

test("tools parser reports invalid sections and preserves an explicit unknown-field warning", () => {
  const invalidTools: PilotConfigDiagnostic[] = [];
  assert.equal(parseToolsConfig("invalid", invalidTools), undefined);
  assert.equal(invalidTools[0]?.code, "TOOLS_CONFIG_INVALID");

  const invalidSearch: PilotConfigDiagnostic[] = [];
  assert.equal(parseToolsConfig({ webSearch: "invalid" }, invalidSearch), undefined);
  assert.equal(invalidSearch[0]?.code, "TOOLS_WEB_SEARCH_INVALID");

  const unknownOnly: PilotConfigDiagnostic[] = [];
  assert.equal(parseToolsConfig({ futureField: true }, unknownOnly), undefined);
  assert.equal(unknownOnly[0]?.code, "TOOLS_UNKNOWN_FIELD");
});

test("web search parser covers custom provider fields, trimming and migration diagnostics", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseToolsConfig({
    webSearch: {
      enabled: true,
      provider: "custom",
      apiKey: "  test-key  ",
      endpoint: "  https://search.test  ",
      region: "legacy",
      tavilyApiKey: "legacy-key",
      unknownSearchField: true,
      customProvider: {
        auth: "queryApiKey",
        method: "POST",
        name: "  Search  ",
        queryParam: " q ",
        apiKeyParam: " key ",
        resultsPath: " results ",
        titleField: " title ",
        urlField: " url ",
        snippetField: " snippet ",
        sourceField: " source ",
        publishedAtField: " published ",
        unknownCustomField: 1,
      },
    },
  }, diagnostics);

  assert.deepEqual(config, {
    webSearch: {
      enabled: true,
      provider: "custom",
      apiKey: "test-key",
      endpoint: "https://search.test",
      customProvider: {
        auth: "queryApiKey",
        method: "POST",
        name: "Search",
        queryParam: "q",
        apiKeyParam: "key",
        resultsPath: "results",
        titleField: "title",
        urlField: "url",
        snippetField: "snippet",
        sourceField: "source",
        publishedAtField: "published",
      },
    },
  });
  assert.deepEqual(new Set(diagnostics.map((item) => item.code)), new Set([
    "TOOLS_WEB_SEARCH_REGION_DEPRECATED",
    "TOOLS_WEB_SEARCH_TAVILY_KEY_DEPRECATED",
    "TOOLS_WEB_SEARCH_UNKNOWN_FIELD",
    "TOOLS_WEB_SEARCH_CUSTOM_PROVIDER_UNKNOWN_FIELD",
  ]));
});

test("web search parser emits fatal diagnostics for invalid provider, credentials and custom fields", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseToolsConfig({
    webSearch: {
      enabled: "yes",
      provider: "other",
      apiKey: "  ",
      endpoint: "",
      customProvider: {
        auth: "other",
        method: "PATCH",
        name: "",
      },
    },
  }, diagnostics);

  assert.equal(config, undefined);
  assert.deepEqual(new Set(diagnostics.map((item) => item.code)), new Set([
    "TOOLS_WEB_SEARCH_ENABLED_INVALID",
    "TOOLS_WEB_SEARCH_PROVIDER_INVALID",
    "TOOLS_WEB_SEARCH_API_KEY_INVALID",
    "TOOLS_WEB_SEARCH_ENDPOINT_INVALID",
    "TOOLS_WEB_SEARCH_CUSTOM_AUTH_INVALID",
    "TOOLS_WEB_SEARCH_CUSTOM_METHOD_INVALID",
    "TOOLS_WEB_SEARCH_CUSTOM_STRING_INVALID",
  ]));
});
