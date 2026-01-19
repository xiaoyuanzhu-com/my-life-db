import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { HelpCircle, Check } from 'lucide-react'
import { cn } from '~/lib/utils'
import type { UserQuestion } from '~/types/claude'

interface AskUserQuestionProps {
  question: UserQuestion
  onAnswer: (answers: Record<string, string | string[]>) => void
  onSkip: () => void
}

export function AskUserQuestion({ question, onAnswer, onSkip }: AskUserQuestionProps) {
  // State for each question's selected answer(s)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({})

  const handleOptionSelect = (
    questionIndex: number,
    optionLabel: string,
    multiSelect: boolean
  ) => {
    const key = `q${questionIndex}`

    if (multiSelect) {
      // Multi-select: toggle option in array
      const current = (answers[key] as string[]) || []
      if (current.includes(optionLabel)) {
        setAnswers({
          ...answers,
          [key]: current.filter((o) => o !== optionLabel),
        })
      } else {
        setAnswers({
          ...answers,
          [key]: [...current, optionLabel],
        })
      }
    } else {
      // Single select: replace
      setAnswers({
        ...answers,
        [key]: optionLabel,
      })
    }
  }

  const handleOtherInput = (questionIndex: number, value: string) => {
    const key = `q${questionIndex}`
    setOtherInputs({
      ...otherInputs,
      [key]: value,
    })
  }

  const handleSubmit = () => {
    // Merge answers with "other" inputs
    const finalAnswers: Record<string, string | string[]> = {}

    question.questions.forEach((q, index) => {
      const key = `q${index}`
      const otherValue = otherInputs[key]

      if (otherValue && otherValue.trim()) {
        // Use "other" input if provided
        finalAnswers[key] = otherValue.trim()
      } else if (answers[key]) {
        finalAnswers[key] = answers[key]
      }
    })

    onAnswer(finalAnswers)
  }

  const isValid = question.questions.every((q, index) => {
    const key = `q${index}`
    const answer = answers[key]
    const other = otherInputs[key]

    // Valid if has answer or has other input
    if (other && other.trim()) return true
    if (q.multiSelect) {
      return Array.isArray(answer) && answer.length > 0
    }
    return !!answer
  })

  return (
    <Dialog open onOpenChange={() => onSkip()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 text-primary" />
            Claude needs your input
          </DialogTitle>
          <DialogDescription>
            Please answer the following to continue
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {question.questions.map((q, qIndex) => (
            <div key={qIndex} className="space-y-3">
              {/* Question header */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded">
                  {q.header}
                </span>
              </div>

              {/* Question text */}
              <p className="text-sm font-medium text-foreground">
                {q.question}
              </p>

              {/* Options */}
              <div className="space-y-2">
                {q.options.map((option, oIndex) => {
                  const key = `q${qIndex}`
                  const isSelected = q.multiSelect
                    ? ((answers[key] as string[]) || []).includes(option.label)
                    : answers[key] === option.label

                  return (
                    <button
                      key={oIndex}
                      type="button"
                      onClick={() =>
                        handleOptionSelect(qIndex, option.label, q.multiSelect)
                      }
                      className={cn(
                        'w-full text-left rounded-lg border p-3 transition-colors',
                        isSelected
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:border-muted-foreground/50'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center',
                            isSelected
                              ? 'border-primary bg-primary'
                              : 'border-muted-foreground/50'
                          )}
                        >
                          {isSelected && (
                            <Check className="h-2.5 w-2.5 text-primary-foreground" />
                          )}
                        </div>
                        <div className="flex-1">
                          <div className="text-sm font-medium">{option.label}</div>
                          {option.description && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {option.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}

                {/* Other option */}
                <div className="flex items-center gap-2 pt-2">
                  <span className="text-sm text-muted-foreground">Other:</span>
                  <Input
                    placeholder="Type your answer..."
                    value={otherInputs[`q${qIndex}`] || ''}
                    onChange={(e) => handleOtherInput(qIndex, e.target.value)}
                    className="flex-1 h-8 text-sm"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onSkip}>
            Skip
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid}>
            Submit Answer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
