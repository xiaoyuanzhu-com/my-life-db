import { useState, useEffect, useCallback } from 'react'
import { cn } from '~/lib/utils'
import { Input } from '~/components/ui/input'
import { Check, X } from 'lucide-react'
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
  const [activeTab, setActiveTab] = useState(0)

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

  // Get current question based on active tab
  const currentQuestion = question.questions[activeTab]
  const currentKey = `q${activeTab}`

  return (
    <div
      className={cn(
        'p-3',
        isDismissing ? 'animate-slide-down-fade' : 'animate-slide-up-fade',
        !isFirst && 'border-t border-border'
      )}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Tab Header */}
      <div className="flex items-center justify-between mb-3">
        {/* Tabs - scrollable horizontally */}
        <div className="flex items-center gap-2 overflow-x-auto min-w-0">
          {question.questions.map((q, index) => (
            <button
              key={index}
              type="button"
              onClick={() => setActiveTab(index)}
              disabled={isDismissing}
              className={cn(
                'text-[13px] font-medium px-2 py-1 rounded transition-colors whitespace-nowrap',
                activeTab === index
                  ? 'text-primary-foreground bg-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                isDismissing && 'opacity-50 cursor-not-allowed'
              )}
            >
              {q.header}
            </button>
          ))}
        </div>

        {/* Close button */}
        <button
          type="button"
          onClick={handleSkip}
          disabled={isDismissing}
          className="flex-shrink-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Current Question Content */}
      <div className="space-y-3">
        {/* Question text */}
        <p className="text-[14px] font-medium text-foreground">
          {currentQuestion.question}
        </p>

        {/* Options - compact table list */}
        <div className="border border-border rounded-lg overflow-hidden">
          {currentQuestion.options.map((option, oIndex) => {
            const isSelected = currentQuestion.multiSelect
              ? ((answers[currentKey] as string[]) || []).includes(option.label)
              : answers[currentKey] === option.label

            return (
              <button
                key={oIndex}
                type="button"
                onClick={() =>
                  handleOptionSelect(activeTab, option.label, currentQuestion.multiSelect)
                }
                disabled={isDismissing}
                className={cn(
                  'w-full text-left px-3 py-2 transition-colors flex items-center gap-3',
                  oIndex > 0 && 'border-t border-border',
                  isSelected ? 'bg-primary/10' : 'hover:bg-muted/50',
                  isDismissing && 'opacity-50 cursor-not-allowed'
                )}
              >
                {/* Checkbox indicator */}
                <div
                  className={cn(
                    'h-4 w-4 border-2 flex items-center justify-center flex-shrink-0',
                    currentQuestion.multiSelect ? 'rounded' : 'rounded-full',
                    isSelected
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground/40'
                  )}
                >
                  {isSelected && (
                    <Check className="h-2.5 w-2.5 text-primary-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium">{option.label}</span>
                  {option.description && (
                    <span className="text-[12px] text-muted-foreground ml-2">
                      {option.description}
                    </span>
                  )}
                </div>
              </button>
            )
          })}

          {/* Other option */}
          <button
            type="button"
            onClick={() => {
              const input = document.getElementById(`other-input-${activeTab}`)
              if (input) input.focus()
            }}
            disabled={isDismissing}
            className={cn(
              'w-full text-left px-3 py-2 transition-colors border-t border-border',
              otherInputs[currentKey]?.trim() ? 'bg-primary/10' : 'hover:bg-muted/50',
              isDismissing && 'opacity-50 cursor-not-allowed'
            )}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'h-4 w-4 border-2 flex items-center justify-center flex-shrink-0',
                  currentQuestion.multiSelect ? 'rounded' : 'rounded-full',
                  otherInputs[currentKey]?.trim()
                    ? 'border-primary bg-primary'
                    : 'border-muted-foreground/40'
                )}
              >
                {otherInputs[currentKey]?.trim() && (
                  <Check className="h-2.5 w-2.5 text-primary-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className="text-[13px] font-medium flex-shrink-0">Other</span>
                <Input
                  id={`other-input-${activeTab}`}
                  placeholder="Type your answer..."
                  value={otherInputs[currentKey] || ''}
                  onChange={(e) => handleOtherInput(activeTab, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  disabled={isDismissing}
                  className="h-6 text-[12px] flex-1"
                />
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end mt-4">
        <button
          onClick={handleSubmit}
          disabled={isDismissing || !isValid}
          className="px-3 py-1.5 rounded-md bg-primary text-[13px] text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
        >
          Submit answers
        </button>
      </div>
    </div>
  )
}
