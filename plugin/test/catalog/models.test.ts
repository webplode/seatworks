import assert from "node:assert/strict";
import { test } from "node:test";
import { applyModels, fetchModels, readModels } from "../../server/catalog/paseo/models.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";

const opus = {
  id: "opus",
  label: "Opus",
  isDefault: true,
  thinkingOptions: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
  defaultThinkingOptionId: "high",
};

test("the models are what Paseo lists for each agent, not what the plugin marked as default, and an agent Paseo cannot list keeps its last list and says why", async () => {
  const kit = makeKit();
  const state = tempDir("sw3-state-");
  const asked: string[] = [];
  const first = await fetchModels(
    kit,
    async (provider) => {
      asked.push(provider);
      return provider === "claude"
        ? { models: [opus, { id: "old", label: "Old", isSelectable: false }] }
        : { models: [{ id: "glm-5", label: "GLM 5" }] };
    },
    state,
    Date.parse("2026-09-01T00:00:00Z"),
  );
  assert.deepEqual(asked, ["claude", "omp"], "each agent is asked through its built-in provider, once");
  assert.equal(first.changed, true);
  assert.deepEqual(
    first.cache.claude!.models,
    [
      {
        id: "opus",
        label: "Opus",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ],
    "an unselectable model is dropped, and a model's own default is only the plugin's choice read back",
  );
  assert.deepEqual(readModels(state), first.cache);
  applyModels(kit, first.cache);
  assert.deepEqual(kit.harnesses.omp!.models, [{ id: "glm-5", label: "GLM 5" }]);

  const failed = await fetchModels(
    kit,
    async (provider) => {
      if (provider === "omp") throw new Error("omp is not on PATH");
      return { models: [opus, { id: "old", label: "Old", isSelectable: false }] };
    },
    state,
  );
  assert.equal(failed.changed, false);
  assert.deepEqual(
    failed.cache.omp,
    { at: "2026-09-01T00:00:00.000Z", models: [{ id: "glm-5", label: "GLM 5" }], error: "omp is not on PATH" },
    "the last list and its time are kept, with why the new one failed",
  );
  const before = kit.harnesses.omp!.models;
  applyModels(kit, { omp: { at: "", error: "none", models: [] } });
  assert.equal(kit.harnesses.omp!.models, before, "an empty answer is not a list");
});
