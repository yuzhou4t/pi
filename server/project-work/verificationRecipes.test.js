import assert from "node:assert/strict";
import test from "node:test";
import {
  detectVerificationRecipes,
  isSafeResolvedVerificationRecipe,
  listVerificationRecipes,
  resolveVerificationRecipe,
} from "./verificationRecipes.js";

function memoryReader(files) {
  return async (filePath) => {
    if (!Object.hasOwn(files, filePath)) {
      const error = new Error("not found");
      error.code = "ENOENT";
      throw error;
    }
    return files[filePath];
  };
}

test("verification recipe catalog covers the registered development stacks", () => {
  const recipes = listVerificationRecipes();
  assert.deepEqual(
    [...new Set(recipes.map((recipe) => recipe.stack))].sort(),
    ["android", "go", "node", "python", "rust", "swift"],
  );
  assert.equal(
    recipes.every((recipe) => recipe.networkPolicy === "offline"),
    true,
  );
  assert.equal(
    recipes.every((recipe) => ["test", "check", "build"].includes(recipe.action)),
    true,
  );
});

test("node recipes bind a safe package script and package-manager lockfile", async () => {
  const reader = memoryReader({
    "web/package.json": JSON.stringify({
      scripts: {
        test: "node --test",
        typecheck: "tsc --noEmit",
        build: "vite build",
      },
    }),
    "web/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  const [testRecipe, checkRecipe, buildRecipe] = await Promise.all([
    resolveVerificationRecipe({
      recipeId: "node.test",
      cwd: "web",
      readTextFile: reader,
    }),
    resolveVerificationRecipe({
      recipeId: "node.check",
      cwd: "web",
      readTextFile: reader,
    }),
    resolveVerificationRecipe({
      recipeId: "node.build",
      cwd: "web",
      readTextFile: reader,
    }),
  ]);

  assert.deepEqual(testRecipe.command, {
    file: "pnpm",
    args: ["run", "test"],
    cwd: "web",
    environment: {},
  });
  assert.deepEqual(checkRecipe.command.args, ["run", "typecheck"]);
  assert.deepEqual(buildRecipe.command.args, ["run", "build"]);
  assert.equal(testRecipe.resolvedScript, "node --test");
  assert.deepEqual(
    testRecipe.bindings.map((binding) => binding.path),
    ["web/package.json", "web/pnpm-lock.yaml"],
  );
  assert.equal(isSafeResolvedVerificationRecipe(testRecipe), true);
  assert.equal(isSafeResolvedVerificationRecipe(checkRecipe), true);
  assert.equal(isSafeResolvedVerificationRecipe(buildRecipe), true);
});

test("node test falls back to the fixed node test runner without a test script", async () => {
  const recipe = await resolveVerificationRecipe({
    recipeId: "node.test",
    readTextFile: memoryReader({
      "package.json": JSON.stringify({ type: "module" }),
    }),
  });

  assert.deepEqual(recipe.command, {
    file: "node",
    args: ["--test"],
    cwd: "",
    environment: {},
  });
  assert.equal(recipe.resolvedScript, null);
  assert.equal(isSafeResolvedVerificationRecipe(recipe), true);
});

test("node recipes reject install, watch, inline shell, and network scripts", async () => {
  for (const script of [
    "vitest --watch",
    "npm install",
    "node --test && curl https://example.com",
    "node -e console.log(1)",
    "vitest tests/*.test.js",
    "vitest --config=/tmp/outside.js",
    "vitest --config=../outside.js",
  ]) {
    await assert.rejects(
      resolveVerificationRecipe({
        recipeId: "node.test",
        readTextFile: memoryReader({
          "package.json": JSON.stringify({ scripts: { test: script } }),
        }),
      }),
      (error) => {
        assert.equal(
          error.code,
          "PROJECT_WORK_VERIFICATION_RECIPE_SCRIPT_UNSAFE",
        );
        return true;
      },
    );
  }
});

test("node recipes reject implicit pre and post lifecycle scripts", async () => {
  for (const lifecycleName of ["pretest", "posttest"]) {
    await assert.rejects(
      resolveVerificationRecipe({
        recipeId: "node.test",
        readTextFile: memoryReader({
          "package.json": JSON.stringify({
            scripts: {
              test: "vitest",
              [lifecycleName]: "node lifecycle.js",
            },
          }),
        }),
      }),
      (error) => {
        assert.equal(
          error.code,
          "PROJECT_WORK_VERIFICATION_RECIPE_SCRIPT_UNSAFE",
        );
        assert.match(error.message, /生命周期脚本/);
        return true;
      },
    );
  }
});

test("bun recipes invoke the reviewed package script instead of the bun test runner", async () => {
  const recipe = await resolveVerificationRecipe({
    recipeId: "node.test",
    readTextFile: memoryReader({
      "package.json": JSON.stringify({
        scripts: { test: "vitest" },
      }),
      "bun.lock": "lockfile",
    }),
  });
  assert.deepEqual(recipe.command, {
    file: "bun",
    args: ["run", "test"],
    cwd: "",
    environment: {},
  });
});

test("fixed recipes emit only registered offline commands", async () => {
  const fixtures = [
    ["python.test", { "pyproject.toml": "[project]\nname='sample'\n" }, {
      file: "python3",
      args: ["-m", "pytest"],
    }],
    ["swift.build", { "Package.swift": "// swift-tools-version: 6.0\n" }, {
      file: "swift",
      args: ["build", "--disable-automatic-resolution"],
    }],
    ["rust.check", { "Cargo.toml": "[package]\nname='sample'\n" }, {
      file: "cargo",
      args: ["check", "--locked", "--offline"],
    }],
    ["go.test", { "go.mod": "module example.test/sample\n" }, {
      file: "go",
      args: ["test", "./..."],
    }],
    ["android.build", {
      "settings.gradle.kts": "pluginManagement { repositories { google() } }\n",
      "build.gradle.kts": "plugins { id(\"com.android.application\") version \"8.6.0\" apply false }\n",
      "gradlew": "#!/bin/sh\nexec java org.gradle.wrapper.GradleWrapperMain \"$@\"\n",
      "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n",
    }, {
      file: "./gradlew",
      args: ["--offline", "--no-daemon", "--console=plain", "assembleDebug"],
    }],
  ];

  for (const [recipeId, files, expected] of fixtures) {
    const recipe = await resolveVerificationRecipe({
      recipeId,
      readTextFile: memoryReader(files),
    });
    assert.equal(recipe.command.file, expected.file);
    assert.deepEqual(recipe.command.args, expected.args);
    assert.equal(recipe.networkPolicy, "offline");
    assert.equal(isSafeResolvedVerificationRecipe(recipe), true);
  }
});

test("android recipes require an Android marker rather than any Gradle project", async () => {
  await assert.rejects(
    resolveVerificationRecipe({
      recipeId: "android.test",
      readTextFile: memoryReader({
        "settings.gradle.kts": "rootProject.name = \"plain-gradle\"\n",
        "build.gradle.kts": "plugins { java }\n",
      }),
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_VERIFICATION_RECIPE_UNAVAILABLE");
      return true;
    },
  );
});

test("android recipes require and bind the project Gradle wrapper", async () => {
  await assert.rejects(
    resolveVerificationRecipe({
      recipeId: "android.test",
      readTextFile: memoryReader({
        "settings.gradle.kts": "rootProject.name = \"android\"\n",
        "build.gradle.kts": "plugins { id(\"com.android.application\") }\n",
      }),
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_VERIFICATION_RECIPE_UNAVAILABLE");
      return true;
    },
  );

  const recipe = await resolveVerificationRecipe({
    recipeId: "android.test",
    readTextFile: memoryReader({
      "settings.gradle.kts": "rootProject.name = \"android\"\n",
      "build.gradle.kts": "plugins { id(\"com.android.application\") }\n",
      "gradlew": "#!/bin/sh\n",
      "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=gradle.zip\n",
    }),
  });
  assert.equal(recipe.command.file, "./gradlew");
  assert.deepEqual(
    recipe.bindings.slice(-2).map((binding) => binding.path),
    ["gradlew", "gradle/wrapper/gradle-wrapper.properties"],
  );
});

test("recipe bindings change when a manifest changes and reject command tampering", async () => {
  const first = await resolveVerificationRecipe({
    recipeId: "go.build",
    readTextFile: memoryReader({
      "go.mod": "module example.test/first\n",
    }),
  });
  const second = await resolveVerificationRecipe({
    recipeId: "go.build",
    readTextFile: memoryReader({
      "go.mod": "module example.test/second\n",
    }),
  });
  assert.notEqual(first.bindingHash, second.bindingHash);

  const tampered = structuredClone(first);
  tampered.command.args = ["build", "./...", "-exec", "curl"];
  assert.equal(isSafeResolvedVerificationRecipe(tampered), false);
});

test("recipe lookup rejects unknown ids, missing manifests, and escaping cwd", async () => {
  const reader = memoryReader({});
  await assert.rejects(
    resolveVerificationRecipe({
      recipeId: "shell.anything",
      readTextFile: reader,
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_VERIFICATION_RECIPE_UNKNOWN");
      return true;
    },
  );
  await assert.rejects(
    resolveVerificationRecipe({
      recipeId: "rust.test",
      readTextFile: reader,
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_VERIFICATION_RECIPE_UNAVAILABLE");
      return true;
    },
  );
  await assert.rejects(
    resolveVerificationRecipe({
      recipeId: "go.test",
      cwd: "../outside",
      readTextFile: reader,
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_PATH_OUT_OF_SCOPE");
      return true;
    },
  );
});

test("recipe detection reports only compatible registered recipes", async () => {
  const recipes = await detectVerificationRecipes({
    readTextFile: memoryReader({
      "Cargo.toml": "[package]\nname='sample'\n",
      "go.mod": "module example.test/sample\n",
    }),
  });
  assert.deepEqual(
    recipes.map((recipe) => recipe.id),
    [
      "rust.test",
      "rust.check",
      "rust.build",
      "go.test",
      "go.check",
      "go.build",
    ],
  );
});
