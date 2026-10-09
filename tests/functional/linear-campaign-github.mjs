import assert from "node:assert/strict";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const INDEX_NAME = "github-transport-index.json";

export function campaignTransportPath(runtime, missionId) {
  assert.match(missionId, /^[0-9a-f-]{36}$/i, "Campaign transport requires the discovered mission UUID");
  return resolve(runtime, `github-transport-${missionId}.json`);
}

export function campaignTransportIndexPath(runtime) {
  return resolve(runtime, INDEX_NAME);
}

async function withIndexLock(runtime, action) {
  const lockPath = resolve(runtime, `${INDEX_NAME}.lock`);
  for (let attempt = 0; attempt < 200; attempt++) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      return await action();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise(done => setTimeout(done, 10));
    } finally {
      await handle?.close();
      if (handle) await rm(lockPath, { force: true });
    }
  }
  throw new Error("Campaign GitHub transport index lock timed out");
}

export async function ensureCampaignTransport(runtime, missionId) {
  return withIndexLock(runtime, async () => {
    const indexPath = campaignTransportIndexPath(runtime);
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    let number = index.byMission[missionId];
    if (number === undefined) {
      number = index.nextPullNumber;
      assert([4242, 4243].includes(number), "Campaign fixture permits exactly two pull requests");
      index.byMission[missionId] = number;
      index.nextPullNumber = number + 1;
      await writeFile(indexPath, JSON.stringify(index));
      await writeFile(campaignTransportPath(runtime, missionId), JSON.stringify({
        missionId, number, url: `https://github.com/ty000/paperclip-council/pull/${number}`,
        headSha: "", createCount: 0, updateCount: 0, mergeCount: 0, intents: [],
      }));
    }
    const path = campaignTransportPath(runtime, missionId);
    const remote = JSON.parse(await readFile(path, "utf8"));
    assert.equal(remote.missionId, missionId);
    assert.equal(remote.number, number);
    return { path, remote };
  });
}
