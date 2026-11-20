import { z } from "zod";
import { jobId } from "./receipt";

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const absolutePath = z.string().min(1).max(4096).refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value),
  "path must be absolute",
);
const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), successMarker: z.string().min(1).max(500), failureMarker: z.string().min(1).max(500) }).strict()
    .refine((value) => value.successMarker !== value.failureMarker, "success and failure markers must differ"),
  z.object({ kind: z.literal("json"), fieldPath: z.array(z.string().min(1).max(100)).min(1).max(16), successValue: scalar, failureValue: scalar })
    .strict().refine((value) => value.successValue !== value.failureValue, "success and failure values must differ"),
  z.object({ kind: z.literal("unassessed") }).strict(),
]);

export const observerSchema = z.object({
  id: jobId,
  title: z.string().min(1).max(160),
  project: z.string().max(120).optional(),
  owner: z.string().max(160).optional(),
  evidencePath: absolutePath,
  logPath: absolutePath.optional(),
  heartbeatPath: absolutePath.optional(),
  runStartedAt: z.iso.datetime({ offset: true }),
  staleAfterSeconds: z.number().int().min(30).max(604800).default(900),
  outcome: outcomeSchema,
}).strict();
export type Observer = z.infer<typeof observerSchema>;

export const observersSchema = z.array(observerSchema).max(32).superRefine((observers, context) => {
  const ids = new Set<string>();
  observers.forEach((observer, index) => {
    if (ids.has(observer.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "observer IDs must be unique" });
    ids.add(observer.id);
  });
});
