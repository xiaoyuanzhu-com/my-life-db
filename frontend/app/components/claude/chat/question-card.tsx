import { useState, useEffect, useCallback } from 'react'
import { cn } from '~/lib/utils'
import { Input } from '~/components/ui/input'
import { Check } from 'lucide-react'
import type { UserQuestion } from '~/types/claude'

interface QuestionCardProps {
  question: UserQuestion
  onAnswer: (answers: Record<string, string | string[]>) => void
  onSkip: () => void
  /** Whether this is the first (topmost) question - receives keyboard shortcuts */
  isFirst?: boolean
}

export function QuestionCard({ question, onAnswer, onSkip, isFirst = true }: QuestionCardProps) {
  const [isDismissing, setIsDismissing] = useState(false)
  const [pendingAction, setPendingAction] = useState<'submit' | 'skip' | null>(null)

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

  // Check if all questions have valid answers
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

  // Handle submit - start exit animation
  const handleSubmit = useCallback(() => {
    if (isDismissing || !isValid) return
    setIsDismissing(true)
    setPendingAction('submit')
  }, [isDismissing, isValid])

  // Handle skip - start exit animation
  const handleSkip = useCallback(() => {
    if (isDismissing) return
    setIsDismissing(true)
    setPendingAction('skip')
  }, [isDismissing])

  // After animation ends, call the actual handler
  const handleAnimationEnd = () => {
    if (!isDismissing || !pendingAction) return

    if (pendingAction === 'submit') {
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
    } else {
      onSkip()
    }
  }

  // Handle keyboard shortcuts - only for the first (topmost) question
  useEffect(() => {
    if (!isFirst) return

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (isDismissing) return

      if (e.key === 'Escape') {
        e.preventDefault()
        handleSkip()
      } else if (e.key === 'Enter' && isValid) {
        e.preventDefault()
        handleSubmit()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFirst, isDismissing, isValid, handleSkip, handleSubmit])

  return (
    <div
      className={cn(
        'p-3',
        isDismissing ? 'animate-slide-down-fade' : 'animate-slide-up-fade',
        !isFirst && 'border-t border-border'
      )}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Header */}
      <div className="text-[14px] leading-relaxed text-foreground mb-3">
        Claude needs your input
      </div>

      {/* Questions */}
      <div className="space-y-4">
        {question.questions.map((q, qIndex) => (
          <div key={qIndex} className="space-y-2">
            {/* Question header chip */}
            <span
              className="inline-block text-xs font-medium text-muted-foreground px-2 py-0.5 rounded"
              style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
            >
              {q.header}
            </span>

            {/* Question text */}
            <p className="text-[14px] font-medium text-foreground">
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
                    disabled={isDismissing}
                    className={cn(
                      'w-full text-left rounded-lg border p-3 transition-colors',
                      isSelected
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:border-muted-foreground/50',
                      isDismissing && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={cn(
                          'mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                          isSelected
                            ? 'border-primary bg-primary'
                            : 'border-muted-foreground/50'
                        )}
                      >
                        {isSelected && (
                          <Check className="h-2.5 w-2.5 text-primary-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium">{option.label}</div>
                        {option.description && (
                          <div className="text-[12px] text-muted-foreground mt-0.5">
                            {option.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}

              {/* Other option */}
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[12px] text-muted-foreground">Other:</span>
                <Input
                  placeholder="Type your answer..."
                  value={otherInputs[`q${qIndex}`] || ''}
                  onChange={(e) => handleOtherInput(qIndex, e.target.value)}
                  disabled={isDismissing}
                  className="flex-1 h-7 text-[12px]"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 mt-3">
        {/* Skip */}
        <button
          onClick={handleSkip}
          disabled={isDismissing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-[12px] text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50"
        >
          Skip
          {isFirst && (
            <kbd className="hidden md:inline px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono">
              Esc
            </kbd>
          )}
        </button>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={isDismissing || !isValid}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-[12px] text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
        >
          Submit
          {isFirst && (
            <kbd className="hidden md:inline px-1 py-0.5 rounded bg-primary-foreground/20 text-primary-foreground text-[10px] font-mono">
              ⏎
            </kbd>
          )}
        </button>
      </div>
    </div>
  )
}
