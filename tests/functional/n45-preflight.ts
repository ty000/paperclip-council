import assert from "node:assert/strict";
import { resolve } from "node:path";

/** No thread/start or turn/start: inspect local account and execute the native projected sandbox directly. */
export async function n45ProjectedPreflight(input: any, campaign: any, profile: any) {
  const { prepareGitHubExecutionEnvironment } = await input.hostImport("packages/adapter-utils/src/execution-target.ts");
  const { buildNativeProviderEnvironment } = await input.hostImport("server/src/services/native-runtime/native-session-executor.ts");
  const native = await input.hostImport("packages/paperclip-runner/src/live/runnerd-codex-transport.ts");
  const { prepareIsolatedCodexHome } = await input.hostImport("packages/paperclip-runner/src/drivers/runtime-context-materializer.ts");
  const { ProcessCodexAppServerTransport } = await input.hostImport("packages/paperclip-runner/src/drivers/codex/app-server-transport.ts");
  const projection = await prepareGitHubExecutionEnvironment({ target: null, cwd: campaign.repository, env: {}, hostCredentials: true, networkAccess: true });
  const env = buildNativeProviderEnvironment(projection, process.env, campaign.repository);
  const codexHome = resolve(input.runtime, "preflight-codex-home");
  await prepareIsolatedCodexHome({ context: null, codexHome, sourceCodexHome: native.resolveSourceCodexHome(env), apiKey: env.CODEX_API_KEY ?? env.OPENAI_API_KEY });
  const providerEnvironment = native.createCapabilityRunnerdProviderEnvironment({ provider: "codex", options: { environment: env },
    identity: { runnerInstanceId: "provider-free-probe", runId: "no-model-run", normalizedSessionId: "no-model-session" },
    codexHome, runtimeContextPath: "", hasRuntimeContext: false });
  const transport = new ProcessCodexAppServerTransport({ command: "codex", workingDirectory: campaign.repository,
    args: native.createRunnerdCodexAppServerArgs({ environment: env, codexHome }),
    environment: providerEnvironment, processGroup: true });
  try {
    const initialized = await transport.request("initialize", { clientInfo: { name: "council-provider-free-preflight", version: "1" }, capabilities: { experimentalApi: true } });
    await transport.notify("initialized", {});
    const account = await transport.request("account/read", { refreshToken: false });
    const probe = async (command: string[]) => {
      const response = await transport.request("command/exec", { command, cwd: campaign.repository, timeoutMs: 35_000, outputBytesCap: 8192 });
      return { ok: response.exitCode === 0, exitCode: response.exitCode, output: response.stdout.trim(), error: response.stderr.trim().slice(0, 1000) };
    };
    const observed = {
      workspace: await probe(["/bin/sh", "-c", "pwd && test -d .git && (set -C; printf probe > .git/council-preflight-write) && rm .git/council-preflight-write"]),
      git: await probe(["git", "--version"]), gh: await probe(["gh", "--version"]),
      head: await probe(["git", "rev-parse", "HEAD"]), branch: await probe(["git", "branch", "--show-current"]),
      repo: await probe(["gh", "api", `repos/${profile.repository}`, "--jq", "{full_name,permissions,default_branch}"]),
      base: await probe(["gh", "api", `repos/${profile.repository}/git/ref/heads/${profile.baseRef}`, "--jq", ".object.sha"]),
      remoteHead: await probe(["gh", "api", `repos/${profile.repository}/git/ref/heads/${profile.headRef}`, "--jq", ".object.sha"]),
    };
    if (observed.head.ok) assert.equal(observed.head.output, profile.candidateSha);
    return { homePreparation: "native prepareIsolatedCodexHome + createCapabilityRunnerdProviderEnvironment + createRunnerdCodexAppServerArgs; disposable home, no manual credential copy", isolatedCodexHome: codexHome, profile: "local standard trust; native GitHub host fallback", initialized: Boolean(initialized),
      localProviderAccountPresent: Boolean(account.account), localProviderAccountType: account.account?.type ?? null,
      providerCompletionObserved: false, modelAvailabilityObserved: false, requestedModel: profile.model, requestedEffort: profile.effort,
      command: observed, launchCapabilitiesObserved: Boolean(account.account && observed.git.ok && observed.gh.ok && observed.workspace.ok && observed.repo.ok && observed.base.ok),
      limitations: ["No provider completion, model turn, native runner session or CLI agent execution occurred", "This direct command/exec exercises the host sandbox projection; actual future run/thread config must be read back", "GitHub repo read and reported permissions do not prove a future push or PR write", "Contributor configuration copies no GitHub credential; standard native host trust can still project host GitHub access"] };
  } finally { await transport.close(); }
}
