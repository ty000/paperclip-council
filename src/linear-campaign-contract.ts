import { z } from "@paperclipai/plugin-sdk";
import { FIXED_CAMPAIGN_MODE } from "./linear-continuity-contract.js";

const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({
  url: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  }),
  version: z.string().trim().min(1).max(64), sha256: digest,
}).strict();
const marker = z.object({ schema: z.literal("linear-milestone-campaign.v1"), milestoneId: uuid,
  prd: reference, tad: reference }).strict();
const referenceContent = reference.extend({ content: z.string().min(1).max(1_000_000) }).strict();

/** Optional extension to the existing receiver; legacy Todo documents stay unchanged. */
export const linearCampaignReadinessSchema = z.object({
  schema: z.literal("linear-milestone-campaign-readiness.v1"), mode: z.literal(FIXED_CAMPAIGN_MODE),
  projectId: uuid, ticketSourceId: uuid, milestoneId: uuid,
  references: z.object({ prd: reference, tad: reference }).strict(),
  materialSourceSha256: digest,
  stateCompatibility: z.object({ status: z.literal("compatible"), observationSha256: digest }).strict(),
  nativeMapping: z.array(z.object({ sourceId: uuid, sourceParentId: z.string().min(1).max(256).nullable(),
    nativeParentSourceId: uuid.nullable(), role: z.enum(["campaign-root", "milestone-root", "milestone-node"]) }).strict()).min(2).max(33),
}).strict();

export const linearCampaignSourceSchema = linearCampaignReadinessSchema.extend({
  marker,
  milestone: z.object({ id: uuid, name: z.string().min(1), description: z.string().nullable() }).strict(),
  referenceContents: z.object({ prd: referenceContent, tad: referenceContent }).strict(),
}).strict();
