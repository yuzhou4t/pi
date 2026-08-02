import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultExecutionPolicy,
  normalizeExecutionPolicy,
  reviewAutoChangeSet,
  reviewAutoPreview,
  reviewAutoVerification,
} from "./autoReviewPolicy.js";
import { resolveVerificationRecipe } from "./verificationRecipes.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

test("execution policy defaults safely and normalizes persisted revisions", () => {
  assert.deepEqual(defaultExecutionPolicy(), {
    mode: "manual_review",
    revision: 1,
    policyVersion: 1,
  });
  assert.deepEqual(normalizeExecutionPolicy({
    mode: "auto_review",
    revision: 4,
    policyVersion: 1,
  }), {
    mode: "auto_review",
    revision: 4,
    policyVersion: 1,
  });
  assert.deepEqual(normalizeExecutionPolicy({
    mode: "auto_review",
    revision: 5,
    policyVersion: 999,
  }), {
    mode: "manual_review",
    revision: 5,
    policyVersion: 1,
  });
  assert.deepEqual(normalizeExecutionPolicy({
    mode: "full_access",
    revision: 0,
  }), defaultExecutionPolicy());
});

test("auto review allows bounded hash-bound edits but denies deletes and read-only workflows", () => {
  const safe = {
    status: "ready",
    stats: { additions: 3, deletions: 1 },
    files: [{
      path: "src/app.js",
      operation: "modify",
      baseHash: HASH_A,
      afterHash: HASH_B,
    }],
  };
  assert.equal(reviewAutoChangeSet(safe).decision, "allow");
  assert.deepEqual(
    reviewAutoChangeSet({
      ...safe,
      files: [{
        ...safe.files[0],
        operation: "delete",
        afterHash: null,
      }],
    }),
    {
      decision: "deny",
      reasonCode: "change_set_unsafe_file",
      policyVersion: 1,
    },
  );
  assert.equal(
    reviewAutoChangeSet(safe, { workflowId: "code_review" }).reasonCode,
    "read_only_workflow",
  );
});

test("auto verification stays blocked without isolation and keeps a strict command whitelist", () => {
  const safe = {
    status: "requested",
    turnId: "turn-1",
    command: {
      file: "node",
      args: ["--test"],
    },
    resolvedScript: null,
  };
  assert.equal(
    reviewAutoVerification(safe, { turnId: "turn-1" }).reasonCode,
    "verification_isolation_unavailable",
  );
  assert.equal(
    reviewAutoVerification(safe, { turnId: "turn-2" }).reasonCode,
    "verification_not_current_turn",
  );
  assert.equal(
    reviewAutoVerification({
      ...safe,
      command: {
        file: "npm",
        args: ["run", "dev"],
      },
      resolvedScript: "vite --host 127.0.0.1",
    }, { turnId: "turn-1" }).reasonCode,
    "verification_command_not_auto_safe",
  );
  assert.equal(
    reviewAutoVerification({
      ...safe,
      command: {
        file: "npm",
        args: ["run", "test:unit"],
      },
      resolvedScript: "node --test server/*.test.js",
    }, {
      turnId: "turn-1",
      isolated: true,
    }).decision,
    "allow",
  );
});

test("auto verification accepts an intact server-owned recipe and rejects tampering", async () => {
  const recipe = await resolveVerificationRecipe({
    recipeId: "go.test",
    readTextFile: async (filePath) => {
      if (filePath === "go.mod") return "module example.test/sample\n";
      throw new Error("not found");
    },
  });
  const verification = {
    status: "requested",
    turnId: "turn-recipe",
    recipeId: recipe.id,
    recipe,
    command: recipe.command,
    resolvedScript: recipe.resolvedScript,
  };
  assert.equal(
    reviewAutoVerification(verification, {
      turnId: "turn-recipe",
      isolated: true,
    }).decision,
    "allow",
  );
  assert.equal(
    reviewAutoVerification({
      ...verification,
      command: {
        ...verification.command,
        args: ["test", "./...", "-exec", "curl"],
      },
    }, {
      turnId: "turn-recipe",
      isolated: true,
    }).reasonCode,
    "verification_command_not_auto_safe",
  );
});

test("auto preview allows only a current bound-project loopback recipe after changes settle", () => {
  const preview = {
    status: "requested",
    turnId: "turn-1",
    executionPolicyMode: "auto_review",
    executionPolicyRevision: 2,
    runtime: "python_uvicorn",
    cwd: "backend",
    app: "app.main:app",
    route: "/reader/",
    title: "读者端",
  };
  const context = {
    turnId: "turn-1",
    workspaceKind: "bound_project",
    executionPolicyRevision: 2,
    changeApplied: true,
  };
  assert.deepEqual(reviewAutoPreview(preview, context), {
    decision: "allow",
    reasonCode: "safe_loopback_preview",
    policyVersion: 1,
  });
  assert.equal(
    reviewAutoPreview({
      ...preview,
      runtime: "vite",
      cwd: ".",
      app: null,
    }, context).decision,
    "allow",
  );
  assert.equal(
    reviewAutoPreview({
      ...preview,
      runtime: "static",
      cwd: "dist",
      app: null,
    }, context).decision,
    "allow",
  );
  assert.equal(
    reviewAutoPreview(preview, {
      ...context,
      workspaceKind: "scratch",
    }).reasonCode,
    "preview_project_required",
  );
  assert.equal(
    reviewAutoPreview(preview, {
      ...context,
      executionPolicyRevision: 3,
    }).reasonCode,
    "preview_policy_revision_mismatch",
  );
  assert.equal(
    reviewAutoPreview(preview, {
      ...context,
      changeApplied: false,
    }).reasonCode,
    "change_set_not_auto_applied",
  );
  assert.equal(
    reviewAutoPreview({
      ...preview,
      route: "https://example.com/",
    }, context).reasonCode,
    "preview_profile_not_safe",
  );
  assert.equal(
    reviewAutoPreview({
      ...preview,
      runtime: "vite",
      app: "app.main:app",
    }, context).reasonCode,
    "preview_profile_not_safe",
  );
  assert.equal(
    reviewAutoPreview({
      ...preview,
      runtime: "static",
      app: null,
      command: "npm run dev",
    }, context).reasonCode,
    "preview_profile_not_safe",
  );
});
