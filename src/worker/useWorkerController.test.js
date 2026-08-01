import assert from "node:assert/strict";
import test from "node:test";
import { createDraftInvalidationCoordinator } from "./useWorkerController.js";

test("draft invalidation is sent once per task and base revision", async () => {
  const coordinator = createDraftInvalidationCoordinator();
  let invalidateCount = 0;
  let refreshCount = 0;
  let releaseInvalidate;
  const pending = new Promise((resolve) => {
    releaseInvalidate = resolve;
  });
  const dependencies = {
    async invalidate() {
      invalidateCount += 1;
      await pending;
    },
    async refresh() {
      refreshCount += 1;
    },
  };
  const input = { taskId: "task-1", draftRevisionId: "draft-3" };
  const first = coordinator.invalidateOnce(input, dependencies);
  const duplicate = coordinator.invalidateOnce(input, dependencies);
  releaseInvalidate();

  assert.equal(await first, true);
  assert.equal(await duplicate, true);
  assert.equal(invalidateCount, 1);
  assert.equal(refreshCount, 1);
});

test("failed draft invalidation refreshes, reports the error, and permits a safe retry", async () => {
  const coordinator = createDraftInvalidationCoordinator();
  let invalidateCount = 0;
  let refreshCount = 0;
  const errors = [];
  const input = { taskId: "task-1", draftRevisionId: "draft-3" };
  const dependencies = {
    async invalidate() {
      invalidateCount += 1;
      if (invalidateCount === 1) throw new Error("草稿版本已经变化");
    },
    async refresh() {
      refreshCount += 1;
    },
    onError(error) {
      errors.push(error.message);
    },
  };

  assert.equal(await coordinator.invalidateOnce(input, dependencies), false);
  assert.deepEqual(errors, ["草稿版本已经变化"]);
  assert.equal(refreshCount, 1);
  assert.equal(await coordinator.invalidateOnce(input, dependencies), true);
  assert.equal(invalidateCount, 2);
  assert.equal(refreshCount, 2);
});
