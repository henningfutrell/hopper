// The reviewer replies the proposal service accepts (issue #537): validated here, so a level that breaks its
// contract escalates, it never decides. Notes are never empty: a request for changes is what the job is told.
import { z } from 'zod';
import { REVIEW_VERDICTS } from '../domain/types.ts';

export const REVIEW_REPLY = z.object({
  verdict: z.enum(REVIEW_VERDICTS), notes: z.string().trim().min(1), model: z.string().optional(),
  machine: z.object({ id: z.string().min(1), why: z.string().min(1) }).optional(),
});
