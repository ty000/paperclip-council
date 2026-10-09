import assert from "node:assert/strict";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type CampaignTransportIndex = { nextPullNumber: number; byMission: Record<string, number> };
type CampaignProof = { githubTransportCalls?: Array<Record<string, unknown>> };

const campaignTransportIndexPath = (runtime: string) => resolve(runtime, "github-transport-index.json");
export function campaignTransportPath(runtime: string, missionId: string) {
  assert.match(missionId, /^[0-9a-f-]{36}$/i, "Campaign transport requires the discovered mission UUID");
  return resolve(runtime, `github-transport-${missionId}.json`);
}

async function withIndexLock<T>(runtime: string, action: () => Promise<T>) {
  const lockPath = resolve(runtime, "github-transport-index.json.lock");
  // Product promises serial publishers. Overlap or a retained unknown fixture
  // allocation is a test failure, never permission to retry under another key.
  const handle = await open(lockPath, "wx", 0o600);
  try { return await action(); }
  finally { await handle.close(); await rm(lockPath); }
}

export async function ensureCampaignTransport(runtime: string, missionId: string) {
  return withIndexLock(runtime, async () => {
    const indexPath = campaignTransportIndexPath(runtime);
    const index: CampaignTransportIndex = JSON.parse(await readFile(indexPath, "utf8"));
    let number = index.byMission[missionId];
    if (number === undefined) {
      number = index.nextPullNumber;
      assert([4242, 4243].includes(number), "Campaign fixture permits exactly two pull requests");
      index.byMission[missionId] = number;
      index.nextPullNumber = number + 1;
      await writeFile(indexPath, JSON.stringify(index));
      await writeFile(campaignTransportPath(runtime, missionId), JSON.stringify({ missionId, number,
        url: `https://github.com/ty000/paperclip-council/pull/${number}`, headSha: "",
        createCount: 0, updateCount: 0, mergeCount: 0, intents: [] }));
    }
    const path = campaignTransportPath(runtime, missionId);
    const remote = JSON.parse(await readFile(path, "utf8"));
    assert.equal(remote.missionId, missionId); assert.equal(remote.number, number);
    return { path, remote };
  });
}

async function readCampaignPull(runtime: string, proof: CampaignProof, url: string) {
  const match = /^https:\/\/api\.github\.com\/repos\/ty000\/paperclip-council\/pulls\/(4242|4243)$/.exec(url);
  assert(match, "Only the two allocated campaign pull readbacks are simulated");
  const number = Number(match[1]);
  const current: CampaignTransportIndex = JSON.parse(await readFile(campaignTransportIndexPath(runtime), "utf8"));
  const missionId = Object.entries(current.byMission).find(([, assigned]) => assigned === number)?.[0];
  assert(missionId, "Campaign pull must be allocated by an authenticated publisher run before readback");
  const remote = JSON.parse(await readFile(campaignTransportPath(runtime, missionId), "utf8"));
  assert.equal(remote.number, number);
  proof.githubTransportCalls!.push({ missionId, url, headSha: remote.headSha, at: new Date().toISOString() });
  return Response.json(pullSnapshot(number, remote));
}

function pullSnapshot(number: number, remote: any) {
  return { number, state: remote.merged ? "closed" : "open", merged: remote.merged === true,
    merge_commit_sha: remote.integratedCommit ?? null, draft: remote.draft === true, title: "Simulated campaign delivery",
    head: { sha: remote.headSha, ref: remote.headRef }, base: { ref: "main", sha: remote.baseCommit }, updated_at: new Date().toISOString() };
}

function fetchIdentity(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const request = new Request(input instanceof Request ? input.clone() : input, init);
  return { url: request.url, method: request.method.toUpperCase() };
}

export async function installCampaignGitHubTransport(runtime: string, proof: CampaignProof) {
  const index: CampaignTransportIndex = { nextPullNumber: 4242, byMission: {} };
  await writeFile(campaignTransportIndexPath(runtime), JSON.stringify(index), { flag: "wx" });
  const original = globalThis.fetch;
  proof.githubTransportCalls = [];
  globalThis.fetch = async (input, init) => {
    const { url, method } = fetchIdentity(input, init);
    if (url.startsWith("https://api.github.com/")) {
      assert.equal(method, "GET");
      return readCampaignPull(runtime, proof, url);
    }
    assert(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Qualification forbids unsimulated outbound fetch");
    return original(input, init);
  };
  return () => { globalThis.fetch = original; };
}
