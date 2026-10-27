// The grade settings (issue #2845, design.md "Grades"), apart from settings.ts for its size: a user's key-value setting,
// read merged on the defaults (grade routing off), and the grading part of the settings the grade pass last graded with,
// so a change of the weights, the revert window or a scale grades the kept grades again.
import { gradeSettingsOf, type GradeSettingsPatch } from '../domain/grade-routing.ts';
import type { GradeSettings } from '../domain/grades.ts';

export function gradeSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getGradeSettings(): GradeSettings;
  setGradeSettings(s: GradeSettings): void;
  getGradedWith(): string | undefined;
  setGradedWith(part: string): void;
} {
  return {
    getGradeSettings: () => {
      const text = read('gradeSettings');
      return gradeSettingsOf(text === undefined ? undefined : JSON.parse(text) as GradeSettingsPatch);
    },
    setGradeSettings: (s) => write('gradeSettings', JSON.stringify(gradeSettingsOf(s))),
    getGradedWith: () => read('gradePassSettings'),
    setGradedWith: (part) => write('gradePassSettings', part),
  };
}
