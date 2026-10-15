// The one question form (issue #1169): every place a person answers a job's question or a decision — an open question,
// a parked job's question, a correction of an auto-answer, a decider pick's override — is a shadcn Questionnaire. Its
// title names what is asked; its options, when it has them, are the questionnaire's choices (arrow keys move, Space
// picks); a free answer is a text box in the same item. Ctrl/Cmd+Enter submits, as the Questionnaire does. The submit
// button sends; `actions` sit beside it and never submit. `confirm`, when given, wraps the submit button: the form then
// sends only through it. Who answered is `AnsweredBy`, a Marker.
import { Bot, UserRound } from 'lucide-react';
import { Questionnaire as QuestionnairePrimitive } from '@shadcn/react/questionnaire';
import type { ReactNode } from 'react';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import {
  Questionnaire, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireDescription, QuestionnaireItem,
  QuestionnaireSubmit, QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { Textarea } from '@/components/ui/textarea';
import type { AnswerSource } from '@/model/answer-source';
import { cn } from '@/lib/utils';

export interface AnswerChoice { value: string; label: string; description?: ReactNode }

export interface QuestionFormProps {
  /** The form's kind, as `data-question-form`, and its item's name. */
  name: string;
  /** What is asked: the questionnaire's title, and the text box's label. */
  title: string;
  description?: ReactNode;
  /** The options, as radio choices; `picked` is the one checked. */
  choices?: readonly AnswerChoice[];
  picked?: string;
  onPick?: (value: string) => void;
  /** A free answer: the text box, shown when `onText` is given. */
  text?: string;
  onText?: (text: string) => void;
  placeholder?: string;
  rows?: number;
  busy?: boolean;
  /** The submit button's content, and whether it may send. */
  submit: ReactNode;
  canSubmit: boolean;
  onSubmit: () => void;
  /** Wraps the submit button, which then does not submit the form: a Confirm that sends by itself. */
  confirm?: (button: ReactNode) => ReactNode;
  /** Beside the submit button: buttons that never submit. */
  actions?: ReactNode;
  /** Under the item: what came of the last send. */
  result?: ReactNode;
  className?: string;
}

export function QuestionForm(p: QuestionFormProps) {
  const button = (
    <QuestionnaireSubmit size="sm" type={p.confirm ? 'button' : 'submit'} disabled={p.busy || !p.canSubmit} className="col-auto row-auto min-h-0 justify-self-auto">
      {p.submit}
    </QuestionnaireSubmit>
  );
  return (
    <Questionnaire data-question-form={p.name} className={cn('gap-2', p.className)}
      onSubmit={(e) => { e.preventDefault(); if (!p.confirm && !p.busy && p.canSubmit) p.onSubmit(); }}>
      <QuestionnaireItem name={p.name} className="gap-2">
        <QuestionnaireTitle className="mb-0! text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{p.title}</QuestionnaireTitle>
        {p.description && <QuestionnaireDescription className="text-xs">{p.description}</QuestionnaireDescription>}
        {p.choices && p.choices.length > 0 && (
          <QuestionnaireChoices>
            {p.choices.map((c) => (
              <QuestionnaireChoice key={c.value} value={c.value} checked={p.picked === c.value} disabled={p.busy}
                onChange={(e) => { if (e.target.checked) p.onPick?.(c.value); }} className="min-h-0 py-1.5 text-xs">
                {c.label}
                {c.description && <QuestionnaireChoiceDescription>{c.description}</QuestionnaireChoiceDescription>}
              </QuestionnaireChoice>
            ))}
          </QuestionnaireChoices>
        )}
        {p.onText && (
          // The Questionnaire's own answer, so a filled box answers the item; drawn as a text box. Enter is a new line:
          // only Ctrl/Cmd+Enter reaches the Questionnaire, which submits.
          <QuestionnairePrimitive.Input value={p.text ?? ''} disabled={p.busy ?? false} onChange={(e) => p.onText?.(e.target.value)}
            render={<Textarea aria-label={p.title} rows={p.rows ?? 3} placeholder={p.placeholder}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) e.stopPropagation(); }} />} />
        )}
      </QuestionnaireItem>
      {p.result}
      <div className="flex flex-wrap items-center gap-2">
        {p.confirm ? p.confirm(button) : button}
        {p.actions}
      </div>
    </Questionnaire>
  );
}

/** Who answered: a person, or a level or Jev with no person (`answerSource`, `pickSource`). */
export function AnsweredBy({ source, className }: { source: AnswerSource | undefined; className?: string }) {
  if (!source) return null;
  return (
    <Marker data-answer-source={source.kind} className={cn('text-xs', className)}>
      <MarkerIcon>{source.kind === 'person' ? <UserRound className="size-3.5" /> : <Bot className="size-3.5" />}</MarkerIcon>
      <MarkerContent>{source.line}</MarkerContent>
    </Marker>
  );
}
