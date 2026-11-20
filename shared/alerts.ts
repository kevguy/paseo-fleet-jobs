import { z } from "zod";

export const alertSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: z.string().max(80), title: z.string().max(160),
  status: z.enum(["waiting", "succeeded", "failed", "stale", "unknown"]),
  observedAt: z.iso.datetime({ offset: true }), reason: z.string().max(2000),
}).strict();
export type JobAlert = z.infer<typeof alertSchema>;
export const monitorSchema = z.object({
  lastCollectedAt: z.iso.datetime({ offset: true }).nullable(),
  alerts: z.array(alertSchema).max(100), warnings: z.array(z.string().max(500)).max(100),
  error: z.string().nullable(),
});
export type MonitorSnapshot = z.infer<typeof monitorSchema>;
