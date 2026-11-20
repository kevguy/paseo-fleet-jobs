import { z } from "zod";

const absolutePath = z.string().min(1).max(2048).refine(value => value.startsWith("/"), "must be an absolute path");

export const resourceConfigSchema = z.object({
  volumes: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    label: z.string().min(1).max(100),
    path: absolutePath,
  }).strict()).max(8).default([]),
  gpuEnabled: z.boolean().default(false),
  heavySlotDirectory: absolutePath.optional(),
}).strict().superRefine((value, context) => {
  const ids = value.volumes.map(volume => volume.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "volume IDs must be unique", path: ["volumes"] });
});
export type ResourceConfig = z.infer<typeof resourceConfigSchema>;

export const observationSchema = z.object({
  status: z.enum(["available", "unavailable", "unknown"]),
  observedAt: z.iso.datetime({ offset: true }),
  ageSeconds: z.number().int().nonnegative(),
  error: z.string().max(200).nullable(),
}).strict();

export const diskResourceSchema = observationSchema.extend({
  id: z.string(),
  label: z.string(),
  totalBytes: z.number().nonnegative().nullable(),
  availableBytes: z.number().nonnegative().nullable(),
  usedPercent: z.number().min(0).max(100).nullable(),
}).strict();

export const gpuDeviceSchema = z.object({
  name: z.string().min(1).max(120),
  utilizationPercent: z.number().min(0).max(100),
  memoryUsedBytes: z.number().nonnegative(),
  memoryTotalBytes: z.number().nonnegative(),
}).strict();

export const gpuResourceSchema = observationSchema.extend({
  reservationAvailability: z.literal("unknown"),
  devices: z.array(gpuDeviceSchema).max(16),
}).strict();

export const heavyClaimsSchema = observationSchema.extend({
  unexpiredCount: z.number().int().nonnegative(),
  expiredCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
  unexpiredWeight: z.number().nonnegative(),
  expiredWeight: z.number().nonnegative(),
  unknownWeight: z.number().nonnegative(),
}).strict();

export const resourceSnapshotSchema = z.object({
  configured: z.boolean(),
  observedAt: z.iso.datetime({ offset: true }),
  freshnessSeconds: z.number().int().positive(),
  configurationError: z.string().max(200).nullable(),
  disks: z.array(diskResourceSchema).max(8),
  gpu: gpuResourceSchema,
  heavyClaims: heavyClaimsSchema,
}).strict();

export type ResourceObservation = z.infer<typeof observationSchema>;
export type DiskResource = z.infer<typeof diskResourceSchema>;
export type GpuResource = z.infer<typeof gpuResourceSchema>;
export type HeavyClaims = z.infer<typeof heavyClaimsSchema>;
export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>;
