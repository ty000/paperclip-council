import assert from "node:assert/strict";

/** No thread/start or turn/start: inspect local account and execute the native projected sandbox directly. */
export async function n45ProjectedPreflight(input: any, campaign: any, profile: any) {
  const { prepareGitHubExecutionEnvironment } = await input.hostImport("packages/adapter-utils/src/execution-target.ts");
  const { buildNativeProviderEnvironment } = await input.hostImport("server/src/services/native-runtime/native-session-executor.ts");
  const security = await input.hostImport("packages/paperclip-runner/src/drivers/codex/codex-security-config.ts");
  const { ProcessCodexAppServerTransport, createSanitizedCodexEnvironment } = await input.hostImport("packages/paperclip-runner/src/drivers/codex/app-server-transport.ts");
  const projection = await prepareGitHubExecutionEnvironment({ target: null, cwd: campaign.repository, env: {}, hostCredentials: true, networkAccess: true });
  const env = buildNativeProviderEnvironment(projection, process.env, campaign.repository);
  const transport = new ProcessCodexAppServerTransport({ command: "codex", workingDirectory: campaign.repository,
    args: security.createIsolatedCodexAppServerArgs(env, security.codexExecutableReadOnlyRoots(env)),
    environment: createSanitizedCodexEnvironment(env), processGroup: true });
  try {
    const initialized = await transport.request("initialize", { clientInfo: { name: "council-provider-free-preflight", version: "1" }, capabilities: { experimentalApi: true } });
    await transport.notify("initialized", {});
    const account = await transport.request("account/read", { refreshToken: false });
    const script = `const fs=require('node:fs'),cp=require('node:child_process');
const probe=(command,args)=>{try{return {ok:true,output:cp.execFileSync(command,args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','ignore']}).trim()}}catch{return {ok:false}}};
const result={cwd:process.cwd(),git:probe('git',['--version']),gh:probe('gh',['--version']),head:probe('git',['rev-parse','HEAD']),branch:probe('git',['branch','--show-current'])};
try{fs.writeFileSync('.git/council-preflight-write','probe',{flag:'wx'});fs.unlinkSync('.git/council-preflight-write');result.gitMetadataWritable=true}catch{result.gitMetadataWritable=false}
result.repo=probe('gh',['api','repos/${profile.repository}','--jq','{full_name,permissions,default_branch}']);
result.base=probe('gh',['api','repos/${profile.repository}/git/ref/heads/${profile.baseRef}','--jq','.object.sha']);
result.remoteHead=probe('gh',['api','repos/${profile.repository}/git/ref/heads/${profile.headRef}','--jq','.object.sha']);
console.log(JSON.stringify(result));`;
    const command = await transport.request("command/exec", { command: [process.execPath, "-e", script], cwd: campaign.repository, timeoutMs: 100_000, outputBytesCap: 8192 });
    assert.equal(command.exitCode, 0, "native projected command must execute without a model");
    const observed = JSON.parse(command.stdout.trim());
    assert.equal(observed.cwd, campaign.repository); assert.equal(observed.head.output, profile.candidateSha);
    return { profile: "local standard trust; native GitHub host fallback", initialized: Boolean(initialized),
      localProviderAccountPresent: Boolean(account.account), localProviderAccountType: account.account?.type ?? null,
      providerCompletionObserved: false, modelAvailabilityObserved: false, requestedModel: profile.model, requestedEffort: profile.effort,
      command: observed, launchCapabilitiesObserved: Boolean(account.account && observed.git.ok && observed.gh.ok && observed.gitMetadataWritable && observed.repo.ok && observed.base.ok),
      limitations: ["No provider completion, model turn, native runner session or CLI agent execution occurred", "This direct command/exec exercises the host sandbox projection; actual future run/thread config must be read back", "GitHub repo read and reported permissions do not prove a future push or PR write", "Contributor configuration copies no GitHub credential; standard native host trust can still project host GitHub access"] };
  } finally { await transport.close(); }
}
