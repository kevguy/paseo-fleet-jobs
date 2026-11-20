import { z } from "zod";
import { monitorSchema } from "./alerts";
import { resourceSnapshotSchema } from "./resources";

export const jobId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
export const stateSchema = z.enum(["running", "waiting", "succeeded", "failed", "unknown"]);
export const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  id: jobId,
  title: z.string().min(1).max(160),
  project: z.string().max(120).optional(),
  owner: z.string().max(160).optional(),
  agentId: z.string().max(160).optional(),
  workspaceId: z.string().max(160).optional(),
  resource: z.string().max(160).optional(),
  status: stateSchema,
  startedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  staleAfterSeconds: z.number().int().min(30).max(604800).default(900),
  message: z.string().max(2000).optional(),
  progress: z.number().min(0).max(100).optional(),
  waitingFor: z.string().max(500).optional(),
  evidence: z.object({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  logPath: z.string().min(1).max(4096).optional(),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;
export const jobSchema = receiptSchema.extend({
  effectiveStatus: z.enum(["running", "waiting", "succeeded", "failed", "stale", "unknown"]),
  reason: z.string(),
  evidenceVerified: z.boolean(),
});
export type Job = z.infer<typeof jobSchema>;

export const snapshotSchema = z.object({
  host: z.string(), observedAt: z.string(), receiptDirectory: z.string(),
  jobs: z.array(jobSchema), warnings: z.array(z.string()), truncated: z.boolean(),
  monitor: monitorSchema.optional(), resources: resourceSnapshotSchema.optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const detailSchema = z.object({ job: jobSchema, evidenceText: z.string().nullable(), logTail: z.string().nullable(), warnings: z.array(z.string()) });
export type Detail = z.infer<typeof detailSchema>;
export const sourceSchema = z.object({ id: jobId, label: z.string().min(1).max(120), sshHost: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}$/), cliPath: z.string().regex(/^\/[a-zA-Z0-9_./ -]+$/).max(4096), knownHostsFile: z.string().regex(/^\/[a-zA-Z0-9_./ -]+$/).max(4096).optional(), nodePath: z.string().regex(/^\/[a-zA-Z0-9_./ -]+$/).max(4096).optional(), dataHome: z.string().regex(/^\/[a-zA-Z0-9_./ -]+$/).max(4096).optional(), serverId: z.string().max(160).optional() }).strict();
export type Source = z.infer<typeof sourceSchema>;
export const fleetHostSchema = z.object({ id: z.string(), label: z.string(), serverId: z.string().optional(), snapshot: snapshotSchema.nullable(), error: z.string().nullable() });
export const fleetSchema = z.object({ hosts: z.array(fleetHostSchema), warnings: z.array(z.string()) });
export type Fleet = z.infer<typeof fleetSchema>;
