import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLiveQualification } from "./run-live.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveQualification("n2").catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
