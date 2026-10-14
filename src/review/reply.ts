// The reviewer replies the review service accepts (issues #537, #543): validated here, so a level that breaks its
// contract escalates, it never decides. Notes are never empty: a request for changes is what the job is told. A level
// may amend a proposal's paths (issue #651), within bounds.
import { z } from 'zod';
import { PATH_TRADEOFFS, REVIEW_VERDICTS } from '../domain/types.ts';

const TEXT = z.string().trim().min(1).max(4000);

/** A reviewer level's changes to a proposal's paths (issue #651): paths it adds, and paths it finds not viable. */
export const PATH_AMENDMENTS = z.object({
  add: z.array(z.object({
    title: z.string().trim().min(1).max(200), summary: TEXT,
    tradeoffs: z.partialRecord(z.enum(PATH_TRADEOFFS), TEXT).optional(), creates: TEXT.optional(),
  })).max(5).optional(),
  notViable: z.array(z.object({ id: z.string().trim().min(1).max(8), why: TEXT })).max(20).optional(),
});

export const REVIEW_REPLY = z.object({
  verdict: z.enum(REVIEW_VERDICTS), notes: z.string().trim().min(1), model: z.string().optional(),
  machine: z.object({ id: z.string().min(1), why: z.string().min(1) }).optional(),
  paths: PATH_AMENDMENTS.optional(),
});
