import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPluginCopy } from "./lib/verify-plugin.ts";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

process.stdout.write(JSON.stringify(verifyPluginCopy(pluginRoot)) + "\n");
