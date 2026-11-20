import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { jobId, snapshotSchema, detailSchema, fleetSchema } from "./receipt";
export * from "./receipt";
export const snapshotRpc = defineRpc({ name: "jobs.snapshot", input: z.object({}), output: snapshotSchema });
export const fleetRpc = defineRpc({ name: "jobs.fleet", input: z.object({}), output: fleetSchema });
export const detailRpc = defineRpc({ name: "jobs.detail", input: z.object({ id: jobId, sourceId: jobId.default("local") }), output: detailSchema });
