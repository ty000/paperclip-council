import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type CampaignTransportIndex = { nextPullNumber: number; byMission: Record<string, number> };
type CampaignProof = { githubTransportCalls?: Array<Record<string, unknown>> };

export const campaignTransportIndexPath = (runtime: string) => resolve(runtime, "github-transport-index.json");
export function campaignTransportPath(runtime: string, missionId: string) {
  assert.match(missionId, /^[0-9a-f-]{36}$/i, "Campaign transport requires the discovered mission UUID");
  return resolve(runtime, `github-transport-${missionId}.json`);
}

export async function installCampaignGitHubTransport(runtime: string, proof: CampaignProof) {
  const index: CampaignTransportIndex = { nextPullNumber: 4242, byMission: {} };
  await writeFile(campaignTransportIndexPath(runtime), JSON.stringify(index), { flag: "wx" });
  const original = globalThis.fetch;
  proof.githubTransportCalls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = String(request ? request.url : input);
    if (url.startsWith("https://api.github.com/")) {
      assert.equal((init?.method ?? request?.method ?? "GET").toUpperCase(), "GET");
      const match = /^https:\/\/api\.github\.com\/repos\/ty000\/paperclip-council\/pulls\/(4242|4243)$/.exec(url);
      assert(match, "Only the two allocated campaign pull readbacks are simulated");
      const number = Number(match[1]);
      const current: CampaignTransportIndex = JSON.parse(await readFile(campaignTransportIndexPath(runtime), "utf8"));
      const missionId = Object.entries(current.byMission).find(([, assigned]) => assigned === number)?.[0];
      assert(missionId, "Campaign pull must be allocated by an authenticated publisher run before readback");
      const remote = JSON.parse(await readFile(campaignTransportPath(runtime, missionId), "utf8"));
      assert.equal(remote.number, number);
      proof.githubTransportCalls!.push({ missionId, url, headSha: remote.headSha, at: new Date().toISOString() });
      return new Response(JSON.stringify({ number, state: remote.merged ? "closed" : "open", merged: remote.merged === true,
        merge_commit_sha: remote.integratedCommit ?? null, draft: remote.draft === true, title: "Simulated campaign delivery",
        head: { sha: remote.headSha, ref: remote.headRef }, base: { ref: "main", sha: remote.baseCommit }, updated_at: new Date().toISOString() }),
      { status: 200, headers: { "content-type": "application/json" } });
    }
    assert(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Qualification forbids unsimulated outbound fetch");
    return original(input, init);
  };
  return () => { globalThis.fetch = original; };
}
