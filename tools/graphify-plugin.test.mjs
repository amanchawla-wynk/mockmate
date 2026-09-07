import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pluginSource = await readFile(
  new URL("../.opencode/plugins/graphify.js", import.meta.url),
  "utf8",
);
const pluginUrl = `data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`;
const { GraphifyPlugin } = await import(pluginUrl);

async function createFixture(exitCode) {
  const directory = await mkdtemp(join(tmpdir(), "mockmate-graphify-plugin-"));
  const binDirectory = join(directory, "bin");
  const sentinelPath = join(directory, "graphify-called");

  await mkdir(join(directory, "graphify-out"));
  await writeFile(join(directory, "graphify-out", "graph.json"), "{}");
  await mkdir(binDirectory);
  await writeFile(
    join(binDirectory, "graphify"),
    `#!/bin/sh\nprintf called > "$GRAPHIFY_TEST_SENTINEL"\nexit ${exitCode}\n`,
  );
  await chmod(join(binDirectory, "graphify"), 0o755);

  return { binDirectory, directory, sentinelPath };
}

async function withFixture(exitCode, run) {
  const fixture = await createFixture(exitCode);
  const previousPath = process.env.PATH;
  const previousSentinel = process.env.GRAPHIFY_TEST_SENTINEL;

  process.env.PATH = fixture.binDirectory;
  process.env.GRAPHIFY_TEST_SENTINEL = fixture.sentinelPath;

  try {
    await run(fixture);
  } finally {
    process.env.PATH = previousPath;
    if (previousSentinel === undefined) delete process.env.GRAPHIFY_TEST_SENTINEL;
    else process.env.GRAPHIFY_TEST_SENTINEL = previousSentinel;
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

test("marks the graph stale after a code update", async () => {
  await withFixture(7, async ({ directory }) => {
    const hooks = await GraphifyPlugin({ directory });
    const output = {};

    await hooks["tool.execute.after"](
      {
        tool: "apply_patch",
        args: { patchText: "*** Update File: src/example.ts" },
      },
      output,
    );

    const marker = await readFile(join(directory, "graphify-out", ".needs_update"), "utf8");
    assert.equal(marker, "1");
    assert.match(output.output, /Marked the graph stale/);
  });
});

test("marks the graph stale for an apply_patch move destination", async () => {
  await withFixture(0, async ({ directory, sentinelPath }) => {
    const hooks = await GraphifyPlugin({ directory });
    const output = {};

    await hooks["tool.execute.after"](
      {
        tool: "apply_patch",
        args: {
          patchText: [
            "*** Update File: docs/example.md",
            "*** Move to: src/example.ts",
          ].join("\n"),
        },
      },
      output,
    );

    assert.equal(await readFile(join(directory, "graphify-out", ".needs_update"), "utf8"), "1");
    await assert.rejects(readFile(sentinelPath, "utf8"), { code: "ENOENT" });
    assert.match(output.output, /Marked the graph stale/);
  });
});
