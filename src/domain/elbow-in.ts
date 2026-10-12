// Specialty jobs and elbow-ins (issue #762, design.md "Specialty jobs elbow in"; docs/glossary.md "Specialty job",
// "Elbow-in"). Only a job designated specialty may start a lane past a machine's lane cap, and only when it fits on no
// machine inside the caps; each machine bounds how many lanes go past its cap at once.
import type { Job, MachineSnapshot } from './types.ts';

/** The label that designates a job specialty: set on its item, read at intake. */
export const SPECIALTY_LABEL = 'hopper:specialty';

/** A machine's elbow-ins when its options name none. */
export const DEFAULT_ELBOW_INS = 1;

export const isSpecialty = (job: Pick<Job, 'spec'>): boolean => job.spec.specialty === true;

/** How many lanes specialty jobs may elbow in past the machine's lane cap at once. */
export const elbowInsOf = (m: Pick<MachineSnapshot, 'elbowIns'>): number => m.elbowIns ?? DEFAULT_ELBOW_INS;
