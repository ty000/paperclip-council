import { z } from "@paperclipai/plugin-sdk";
import { MissionError } from "./mission-primitives.js";
import type { ProjectMandateContent } from "./project-mandate-state.js";
import { linearCampaignReadinessSchema, linearCampaignSourceSchema } from "./linear-campaign-contract.js";

export const LINEAR_ORIGIN = "plugin:ty000.linear-intake";
export const LINEAR_READINESS_KEY = "linear-intake-readiness-v1";
export const LINEAR_SOURCE_KEY = "linear-source-v1";
const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const intakeId = z.string().regex(/^linear-intake-[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const workSchema = z.object({ assigneeAgentId: uuid, ownedPaths: z.array(z.string().min(1).max(512)).min(1).max(64) }).strict();
const policySchema = z.object({ protocol: z.literal("linear-intake-receiver-v1"), originKind: z.literal(LINEAR_ORIGIN),
  organizationId: uuid, teamId: uuid, projectId: uuid, todoStateId: uuid,
  work: z.record(uuid, workSchema),
}).strict();
export type LinearIntakePolicy = z.infer<typeof policySchema>;

export function requireLinear(condition: unknown, code: string, message = "Original Linear intake proof must be complete and unchanged"): asserts condition {
  if (!condition) throw new MissionError(409, code, message);
}
function validPath(path: string, allowed: string[]) {
  const normalized = path.replace(/\/$/, "");
  requireLinear(!normalized.startsWith("/") && !normalized.includes("\\"), "linear_work_paths");
  requireLinear(!normalized.split("/").some(segment => ["", ".", "..", ".git"].includes(segment)), "linear_work_paths");
  requireLinear(allowed.some(prefix => prefix === "." || normalized === prefix || normalized.startsWith(`${prefix}/`)), "linear_work_scope");
}
export function parseLinearIntakePolicy(value: unknown, policy: Pick<ProjectMandateContent, "allowedPaths" | "hierarchy" | "criteriaSource">, contributors: string[]): LinearIntakePolicy | undefined {
  if (value === undefined) return undefined;
  const parsed = policySchema.safeParse(value);
  requireLinear(parsed.success, "linear_policy_invalid", "Explicit source scope and source UUID to contributor/ownedPaths mapping required");
  requireLinear(policy.hierarchy?.adoptExistingChildren, "linear_hierarchy_required");
  requireLinear(policy.criteriaSource === "project-defaults", "linear_project_criteria_required");
  const entries = Object.values(parsed.data.work);
  requireLinear(entries.length >= 1 && entries.length <= 32, "linear_work_bound");
  for (const work of entries) {
    requireLinear(contributors.includes(work.assigneeAgentId), "linear_work_actor");
    work.ownedPaths.forEach(path => validPath(path, policy.allowedPaths));
    requireLinear(new Set(work.ownedPaths).size === work.ownedPaths.length, "linear_work_duplicate");
  }
  return parsed.data;
}

const correspondenceSchema = z.object({ sourceId: uuid, nativeId: uuid, originId: z.string().min(1), sourceRevision: timestamp,
  status: z.enum(["blocked", "done", "cancelled"]) }).strict();
const resultSchema = z.object({ nativeId: uuid, contentSha256: digest, revisionId: uuid.optional(),
  revisionNumber: z.number().int().positive().optional(), blockerIds: z.array(uuid).optional() }).strict();
const effectSchema = z.object({ effectKey: z.string().min(1).max(300), intentSha256: digest, result: resultSchema, resultSha256: digest }).strict();
const readinessSchema = z.object({ schema: z.literal("linear-native-readiness.v1"), companyId: uuid, intakeId,
  activationId: uuid, configurationFingerprint: digest, requestVersion: z.number().int().positive(), planSha256: digest, sourceSha256: digest,
  targetProjectId: uuid, originKind: z.literal(LINEAR_ORIGIN), nativeRootId: uuid, sourceRootId: uuid,
  correspondence: z.array(correspondenceSchema).min(1).max(33), effects: z.array(effectSchema).min(3).max(99),
  externalBlockers: z.array(z.unknown()).max(10000), importStatus: z.literal("prepared"), admissionAllowed: z.literal(false),
  implementationStarted: z.literal(false), receivingContract: z.literal("unqualified"), requiresCurrentSourceAndMandateRevalidation: z.literal(true),
  campaign: linearCampaignReadinessSchema.optional(),
}).strict();
export type LinearReadiness = z.infer<typeof readinessSchema>;
const referenceSchema = z.object({ id: z.string().min(1) }).passthrough();
const stateSchema = z.object({ id: uuid, name: z.string(), type: z.string() }).passthrough();
const sourceSchema = z.object({ id: z.string().min(1), uuid, parentId: z.string().nullable(), teamId: uuid, projectId: uuid,
  title: z.string(), description: z.string().nullable(), updatedAt: timestamp, createdAt: timestamp,
  completedAt: timestamp.nullable(), canceledAt: timestamp.nullable(), archivedAt: timestamp.nullable(),
  status: z.string(), statusType: z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"]), currentStateId: uuid,
  relations: z.object({ blockedBy: z.array(referenceSchema), blocks: z.array(referenceSchema), relatedTo: z.array(referenceSchema), duplicateOf: referenceSchema.nullable() }).passthrough(),
  stateHistory: z.array(z.object({ state: stateSchema, startedAt: timestamp, endedAt: timestamp.nullable() }).passthrough()),
}).passthrough();
const sourceDocumentSchema = z.object({ schema: z.literal("linear-native-source.v1"), organizationId: uuid, sourceSha256: digest,
  campaign: linearCampaignSourceSchema.optional(),
  source: sourceSchema, provenance: z.object({ originKind: z.literal(LINEAR_ORIGIN), intakeId, activationId: uuid,
    rootSourceId: uuid, catalogSha256: digest }).strict() }).strict();
export type LinearSourceDocument = z.infer<typeof sourceDocumentSchema>;
export type LinearSourceSubject = Pick<LinearReadiness, "companyId" | "intakeId" | "activationId" | "configurationFingerprint" | "requestVersion" | "nativeRootId" | "targetProjectId" | "sourceSha256" | "planSha256"> & {
  readinessDocumentId: string; readinessRevisionId: string; readinessSha256: string;
};
export type LinearNode = { nativeId: string; sourceId: string; parentId: string | null; originId: string;
  title: string; description: string; status: "blocked" | "done" | "cancelled"; blockerIds: string[];
  sourceDocumentId: string; sourceRevisionId: string; sourceBodySha256: string;
  role: "root" | "aggregate" | "contribution" | "historical"; assigneeAgentId: string | null; ownedPaths: string[];
};
export type LinearReadinessSnapshot = { body: LinearReadiness; subject: LinearSourceSubject; bodySha256: string; nodes: LinearNode[] };
export type LinearPreparationEffect = { state: "claimed" | "confirmed"; intentSha256: string; revisionId?: string };
export type LinearPreparation = { snapshot: LinearReadinessSnapshot; effects: Record<string, LinearPreparationEffect>;
  preparationReceipt?: { challengeId: string; stage: "preparation" | "admission"; observedAt: string; validUntil: string; requestSha256: string };
  admissionReceipt?: LinearPreparation["preparationReceipt"];
};
export function parseLinearReadiness(body: string): LinearReadiness { return parseDocument(body, readinessSchema); }
export function parseLinearSource(body: string): LinearSourceDocument { return parseDocument(body, sourceDocumentSchema); }
function parseDocument<T>(body: string, schema: z.ZodType<T>): T {
  requireLinear(Buffer.byteLength(body) <= 8 * 1024 * 1024, "linear_document_bound");
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new MissionError(409, "linear_document_invalid", "Valid complete revision-bound JSON document required"); }
  const parsed = schema.safeParse(raw);
  requireLinear(parsed.success, "linear_document_invalid");
  return parsed.data;
}
