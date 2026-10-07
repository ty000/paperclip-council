import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const roleNames = { getWorkspace: "get-workspace", getProject: "get-project", getTeam: "get-team",
  listStatuses: "list-issue-statuses", listIssues: "list-issues", getIssue: "get-issue" };

export async function startLinearSource() {
  const ids = Object.fromEntries(["organization", "team", "project", "todo", "backlog", "cancelled", "root", "alpha", "beta", "history", "actor", "webhook"]
    .map(name => [name, randomUUID()])) as Record<string, string>;
  const token = randomBytes(24).toString("hex"), webhookSecret = randomBytes(24).toString("hex");
  const states = [{ id: ids.todo, name: "Todo", type: "unstarted" }, { id: ids.backlog, name: "Backlog", type: "backlog" },
    { id: ids.cancelled, name: "Canceled", type: "canceled" }];
  const tools = Object.entries(roleNames).map(([role, name]) => ({ role, name: `fixture:${name}`, inputSchema: { type: "object", properties: {} } }));
  const pins = Object.fromEntries(tools.map(tool => [tool.role, { name: tool.name,
    inputSchemaSha256: createHash("sha256").update(JSON.stringify(tool.inputSchema)).digest("hex") }]));
  const now = new Date().toISOString();
  const makeIssue = (name: string, index: number, state: typeof states[number]) => ({
    uuid: ids[name], id: `L4-${index}`, parentId: name === "root" ? null : "L4-1", teamId: ids.team, projectId: ids.project,
    title: name, description: name === "root" ? "Complete retained Linear source. ".repeat(1_100) : `Preserved ${name} result.`,
    status: state.name, statusType: state.type, createdAt: now, updatedAt: now,
    completedAt: null, canceledAt: name === "history" ? now : null, archivedAt: null,
    relations: { blocks: [] as { id: string }[], blockedBy: [] as { id: string }[], relatedTo: [], duplicateOf: null },
    stateHistory: [{ state, startedAt: now, endedAt: null }],
  });
  const issues = new Map([
    [ids.root!, makeIssue("root", 1, states[0]!)], [ids.alpha!, makeIssue("alpha", 2, states[1]!)],
    [ids.beta!, makeIssue("beta", 3, states[1]!)], [ids.history!, makeIssue("history", 4, states[2]!)],
  ]);
  issues.get(ids.beta!)!.relations.blockedBy.push({ id: "L4-2" });
  issues.get(ids.alpha!)!.relations.blocks.push({ id: "L4-3" });
  const calls: { role: string; id: string | null }[] = [];
  const controls = { withdrawn: false, unavailable: false, hold: undefined as Promise<void> | undefined };

  function issueDetail(args: any) {
    const original = issues.get(args.id);
    assert(original, "Source read must remain in the four enrolled identities");
    const value = structuredClone(original);
    if (controls.withdrawn && value.uuid === ids.root) {
      value.status = states[1]!.name; value.statusType = states[1]!.type;
      value.stateHistory = [{ state: states[1]!, startedAt: value.updatedAt, endedAt: null }];
    }
    return args.fields.includes("description") ? value : Object.fromEntries(args.fields.map((field: string) => [field, (value as any)[field]]));
  }

  function issuePage(args: any) {
    const children = [...issues.values()].filter(issue => issue.parentId === args.parentId);
    const offset = Number(args.cursor ?? 0), selected = children.slice(offset, offset + args.limit);
    const hasNextPage = offset + selected.length < children.length;
    return { issues: selected.map(({ uuid, id, parentId, teamId, projectId, updatedAt }) => ({ uuid, id, parentId, teamId, projectId, updatedAt })),
      hasNextPage, ...(hasNextPage ? { cursor: String(offset + selected.length) } : {}) };
  }
  const handlers: Record<string, (args: any) => unknown> = {
    getWorkspace: () => ({ id: ids.organization, name: "Synthetic Linear workspace" }),
    getProject: () => ({ uuid: ids.project, id: "L4P", name: "Synthetic Linear project" }),
    getTeam: () => ({ id: ids.team, key: "L4" }), listStatuses: () => states,
    listIssues: issuePage, getIssue: issueDetail,
  };

  async function toolReply(rpc: any) {
    const tool = tools.find(entry => entry.name === rpc.params.name);
    assert(tool, "Only pinned read tools are supported");
    calls.push({ role: tool.role, id: rpc.params.arguments.id ?? rpc.params.arguments.parentId ?? null });
    await controls.hold;
    const payload = handlers[tool.role]!(rpc.params.arguments);
    return { isError: false, structuredContent: { isError: false, structuredContent: null,
      content: [{ type: "text", text: JSON.stringify(payload) }] } };
  }
  const replies: Record<string, (rpc: any) => unknown> = {
    initialize: () => ({ protocolVersion: "2025-03-26", capabilities: { tools: {} } }),
    "tools/list": () => ({ tools: tools.map(({ role: _role, ...tool }) => tool) }), "tools/call": toolReply,
  };
  async function gatewayRequest(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.url, "/mcp/gateways/linear-fixture");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (controls.unavailable) { response.writeHead(503).end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (rpc.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    assert(replies[rpc.method], "Unsupported deterministic gateway method");
    const result = await replies[rpc.method]!(rpc);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  }
  const server = createServer(async (request, response) => {
    try { await gatewayRequest(request, response); }
    catch { response.writeHead(400).end(JSON.stringify({ error: "synthetic_source_request_invalid" })); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address !== "string");

  return { ids, issues, calls, controls, token, webhookSecret,
    gatewayUrl: `http://127.0.0.1:${address.port}/mcp/gateways/linear-fixture`,
    reader: { organizationId: ids.organization, teamId: ids.team, projectId: ids.project, todoStateId: ids.todo,
      tools: pins, qualificationRootIssueIds: [], maxIssues: 10, maxPagesPerParent: 10, pageSize: 1, maxRequests: 100, deadlineMs: 60_000 },
    enterTodo() {
      const at = new Date().toISOString(), root = issues.get(ids.root!)!;
      root.updatedAt = at; root.stateHistory = [{ state: states[0]!, startedAt: at, endedAt: null }];
    },
    webhook() {
      const body = { action: "update", type: "Issue", organizationId: ids.organization, webhookId: ids.webhook,
        actor: { id: ids.actor, type: "user" }, createdAt: new Date().toISOString(), webhookTimestamp: Date.now(),
        data: { id: ids.root, teamId: ids.team, projectId: ids.project, stateId: ids.todo, updatedAt: issues.get(ids.root!)!.updatedAt,
          archivedAt: null, title: "Synthetic source root" }, updatedFrom: { stateId: ids.backlog } };
      const rawBody = JSON.stringify(body);
      return { rawBody, headers: { "content-type": "application/json", "linear-event": "Issue", "linear-delivery": randomUUID(),
        "linear-timestamp": String(body.webhookTimestamp), "linear-signature": createHmac("sha256", webhookSecret).update(rawBody).digest("hex") } };
    },
    close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())),
  };
}

export type LinearSource = Awaited<ReturnType<typeof startLinearSource>>;
