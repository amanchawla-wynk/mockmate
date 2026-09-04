// Marks MockMate's generated graph stale after source changes.
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const GRAPH_PATH = ["graphify-out", "graph.json"];
const NEEDS_UPDATE_PATH = ["graphify-out", ".needs_update"];

function appendOutput(output, line) {
  output.output = output.output ? `${output.output}\n${line}` : line;
}

function extractChangedPaths(patchText) {
  if (typeof patchText !== "string" || patchText.length === 0) {
    return [];
  }

  const changed = new Set();
  for (const line of patchText.split("\n")) {
    for (const prefix of [
      "*** Add File: ",
      "*** Update File: ",
      "*** Delete File: ",
      "*** Move to: ",
    ]) {
      if (line.startsWith(prefix)) {
        changed.add(line.slice(prefix.length).trim());
      }
    }
  }
  return [...changed];
}

function markNeedsUpdate(directory) {
  mkdirSync(join(directory, "graphify-out"), { recursive: true });
  writeFileSync(join(directory, ...NEEDS_UPDATE_PATH), "1");
}

export const GraphifyPlugin = async ({ directory }) => {
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "apply_patch") return;
      if (!existsSync(join(directory, ...GRAPH_PATH))) return;

      const changedPaths = extractChangedPaths(input.args?.patchText);
      if (changedPaths.length === 0) return;

      markNeedsUpdate(directory);
      appendOutput(
        output,
        "[graphify] Changes detected. Marked the graph stale; refresh it once when needed.",
      );
    },
  };
};
