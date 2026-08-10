import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const APP_PATH = "/src/App.jsx";
let sharedAppModule = null;

async function createSharedAppModule() {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    return {
      vite,
      module: await vite.ssrLoadModule(APP_PATH),
    };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

async function withAppModule(callback) {
  if (!sharedAppModule) sharedAppModule = createSharedAppModule();
  const loaded = await sharedAppModule;
  return callback(loaded.module);
}

after(async () => {
  if (!sharedAppModule) return;
  const { vite } = await sharedAppModule;
  await vite.waitForRequestsIdle();
  await vite.close();
});

const providers = [{
  id: "openai-codex",
  available: true,
  models: ["gpt-5.6", "gpt-5.3-codex-spark"],
}, {
  id: "deepseek",
  available: true,
  models: ["deepseek-v4-flash", "deepseek-v4-pro"],
}];

test("initial project-work loading keeps conversation summaries for every folder", async () => {
  await withAppModule(async ({ listAllProjectConversations }) => {
    const requestedProjectIds = [];
    const conversations = await listAllProjectConversations([
      { id: "project-1" },
      { id: "project-2" },
    ], async ({ projectId }) => {
      requestedProjectIds.push(projectId);
      return [{ id: `${projectId}-conversation`, projectId }];
    });

    assert.deepEqual(requestedProjectIds.sort(), ["project-1", "project-2"]);
    assert.deepEqual(
      conversations.map((conversation) => conversation.id).sort(),
      ["project-1-conversation", "project-2-conversation"],
    );
  });
});

test("fixed quota URL opens only the usage settings surface", async () => {
  await withAppModule(({ parseSettingsEntry }) => {
    assert.equal(parseSettingsEntry("?settings=usage"), "usage");
    assert.equal(parseSettingsEntry("?settings=providers"), null);
    assert.equal(parseSettingsEntry("?settings=usage&settings=usage"), null);
  });
});

test("project-work model preference migrates v1 and remembers a model per provider", async () => {
  await withAppModule(({
    DEFAULT_PROJECT_WORK_EXECUTION_POLICY_MODE,
    normalizeProjectWorkModelPreference,
    rememberProjectWorkModelPreference,
  }) => {
    assert.equal(DEFAULT_PROJECT_WORK_EXECUTION_POLICY_MODE, "auto_review");
    const migrated = normalizeProjectWorkModelPreference({
      providerId: "openai-codex",
      model: "gpt-5.3-codex-spark",
    });
    assert.deepEqual(migrated, {
      providerId: "openai-codex",
      modelsByProvider: {
        "openai-codex": "gpt-5.3-codex-spark",
      },
    });

    const deepseek = rememberProjectWorkModelPreference(
      migrated,
      "deepseek",
      "deepseek-v4-pro",
    );
    assert.deepEqual(deepseek, {
      providerId: "deepseek",
      modelsByProvider: {
        "openai-codex": "gpt-5.3-codex-spark",
        deepseek: "deepseek-v4-pro",
      },
    });
  });
});

test("conversation restore and a transient catalog fallback do not overwrite explicit preference", async () => {
  await withAppModule(({
    normalizeProjectWorkModelPreference,
    resolveProjectWorkModelSelection,
  }) => {
    const preference = normalizeProjectWorkModelPreference({
      providerId: "deepseek",
      modelsByProvider: {
        "openai-codex": "gpt-5.3-codex-spark",
        deepseek: "deepseek-v4-pro",
      },
    });
    const current = resolveProjectWorkModelSelection({
      preference,
      providers,
      defaultProviderId: "openai-codex",
      defaultModelId: "gpt-5.6",
      conversation: {
        providerId: "openai-codex",
        modelId: "gpt-5.6",
      },
    });
    assert.deepEqual(current, {
      providerId: "openai-codex",
      modelId: "gpt-5.6",
    });

    const preferred = resolveProjectWorkModelSelection({
      preference,
      providers,
      defaultProviderId: "openai-codex",
      defaultModelId: "gpt-5.6",
    });
    assert.deepEqual(preferred, {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });

    const temporaryFallback = resolveProjectWorkModelSelection({
      preference,
      providers: providers.slice(0, 1),
      defaultProviderId: "openai-codex",
      defaultModelId: "gpt-5.6",
    });
    assert.deepEqual(temporaryFallback, {
      providerId: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
    });
    assert.deepEqual(preference, {
      providerId: "deepseek",
      modelsByProvider: {
        "openai-codex": "gpt-5.3-codex-spark",
        deepseek: "deepseek-v4-pro",
      },
    });
  });
});

test("notification entry accepts only a bounded project-work conversation id", async () => {
  await withAppModule(({
    parseProjectWorkNotificationEntry,
  }) => {
    assert.deepEqual(
      parseProjectWorkNotificationEntry(
        "?work_type=project_work&conversation_id=project-conversation%3Aabc-123",
      ),
      {
        workType: "project_work",
        conversationId: "project-conversation:abc-123",
      },
    );
    assert.equal(
      parseProjectWorkNotificationEntry(
        "?work_type=worker&conversation_id=project-conversation%3Aabc-123",
      ),
      null,
    );
    assert.equal(
      parseProjectWorkNotificationEntry(
        "?work_type=project_work&conversation_id=https%3A%2F%2Fevil.example",
      ),
      null,
    );
    assert.equal(
      parseProjectWorkNotificationEntry(
        "?work_type=project_work&conversation_id=first&conversation_id=second",
      ),
      null,
    );
    assert.equal(
      parseProjectWorkNotificationEntry(
        `?work_type=project_work&conversation_id=${"a".repeat(201)}`,
      ),
      null,
    );
  });
});

test("notification entry cleanup removes only controlled parameters and preserves the current route", async () => {
  await withAppModule(({
    notificationEntryUrlWithoutControlParameters,
  }) => {
    assert.equal(
      notificationEntryUrlWithoutControlParameters({
        pathname: "/workspace",
        search: "?work_type=project_work&conversation_id=conversation-1&theme=warm",
        hash: "#review",
      }),
      "/workspace?theme=warm#review",
    );
    assert.equal(
      notificationEntryUrlWithoutControlParameters({
        pathname: "/",
        search: "?work_type=project_work&conversation_id=conversation-1",
        hash: "",
      }),
      "/",
    );
  });
});
