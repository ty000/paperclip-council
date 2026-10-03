import { chmodSync, lstatSync, readdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const runtimePrefix = "paperclip-council-package-";

function assertOwnedRuntime(runtime) {
  const absolute = resolve(runtime);
  if (dirname(absolute) !== realpathSync(tmpdir()) || !basename(absolute).startsWith(runtimePrefix)) {
    throw new Error(`Qualification runtime is outside the owned temporary boundary: ${absolute}`);
  }
  return absolute;
}

export function createOwnedRuntime() {
  return assertOwnedRuntime(mkdtempSync(resolve(realpathSync(tmpdir()), runtimePrefix)));
}

export function cleanupOwnedRuntime(runtime) {
  const absolute = assertOwnedRuntime(runtime);
  if (existsSync(absolute)) {
    // Native runner instruction bundles are immutable directories. Restore only
    // owned directory permissions and never follow symlinks before removal.
    const makeRemovable = (path) => {
      const entry = lstatSync(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) makeRemovable(resolve(path, name));
    };
    makeRemovable(absolute);
    rmSync(absolute, { recursive: true, force: true });
  }
}
