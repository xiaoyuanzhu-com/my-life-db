import { useState } from 'react'
import { cn } from '~/lib/utils'
import { Check } from 'lucide-react'
import type { ToolCall } from '~/types/claude'
import { MessageDot } from '../message-dot'

interface AskUserQuestionInput {
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}

interface AskUserQuestionResult {
  answers: Record<string, string | string[]>
  questions: Array<{ header: string; question: string }>
}

/**
 * Renders an AskUserQuestion tool block in the message list.
 * Shows questions and answers in a read-only disabled state.
 * No collapsible header - directly renders all questions.
 */
export function AskUserQuestionToolView({ toolCall }: { toolCall: ToolCall }) {
  const [activeTab, setActiveTab] = useState(0)

  const input = toolCall.parameters as unknown as AskUserQuestionInput
  const questions = input?.questions || []

  // Parse result to get answers
  let answers: Record<string, string | string[]> = {}
  if (toolCall.result) {
    try {
      // Result is a JSON string
      const parsed =
        typeof toolCall.result === 'string'
          ? (JSON.parse(toolCall.result) as AskUserQuestionResult)
          : (toolCall.result as AskUserQuestionResult)
      answers = parsed.answers || {}
    } catch {
      // Ignore parse errors
    }
  }

  const hasAnswers = Object.keys(answers).length > 0
  const currentQuestion = questions[activeTab]
  const currentKey = `q${activeTab}`
  const currentAnswer = answers[currentKey]

  if (!questions.length) {
    return null
  }

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header with status dot */}
      <div className="flex items-start gap-2 mb-2">
        <MessageDot status={toolCall.status} />
        <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
          Ask User Question
        </span>
        {/* Only show "(no response)" for terminal states (completed/failed) without answers */}
        {!hasAnswers && (toolCall.status === 'completed' || toolCall.status === 'failed') && (
          <span className="text-[11px] text-muted-foreground">(no response)</span>
        )}
      </div>

      {/* Question tabs and content */}
      <div className="ml-5">
        {/* Tabs */}
        <div className="flex items-center gap-2 mb-3 overflow-x-auto">
          {questions.map((q, index) => {
            const key = `q${index}`
            const hasAnswer = answers[key] !== undefined
            return (
              <button
                key={index}
                type="button"
                onClick={() => setActiveTab(index)}
                className={cn(
                  'text-[12px] font-medium px-2 py-1 rounded transition-colors whitespace-nowrap',
                  activeTab === index
                    ? 'text-primary-foreground bg-primary'
                    : hasAnswer
                      ? 'text-muted-foreground bg-muted/50'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                {q.header}
              </button>
            )
          })}
        </div>

        {/* Current Question Content */}
        {currentQuestion && (
          <div className="space-y-2">
            {/* Question text */}
            <p className="text-[13px] font-medium text-foreground">
              {currentQuestion.question}
            </p>

            {/* Options - compact table list (disabled/readonly) */}
            <div className="border border-border rounded-lg overflow-hidden opacity-80">
              {currentQuestion.options.map((option, oIndex) => {
                const isSelected = currentQuestion.multiSelect
                  ? Array.isArray(currentAnswer) && currentAnswer.includes(option.label)
                  : currentAnswer === option.label

                return (
                  <div
                    key={oIndex}
                    className={cn(
                      'w-full text-left px-3 py-2 flex items-center gap-3',
                      oIndex > 0 && 'border-t border-border',
                      isSelected ? 'bg-primary/10' : ''
                    )}
                  >
                    {/* Checkbox indicator */}
                    <div
                      className={cn(
                        'h-4 w-4 border-2 flex items-center justify-center flex-shrink-0',
                        currentQuestion.multiSelect ? 'rounded' : 'rounded-full',
                        isSelected
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground/30'
                      )}
                    >
                      {isSelected && (
                        <Check className="h-2.5 w-2.5 text-primary-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[12px] font-medium">{option.label}</span>
                      {option.description && (
                        <span className="text-[11px] text-muted-foreground ml-2">
                          {option.description}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}

              {/* Show "Other" answer if it exists and doesn't match any option */}
              {currentAnswer &&
                typeof currentAnswer === 'string' &&
                !currentQuestion.options.some((o) => o.label === currentAnswer) && (
                  <div className="w-full text-left px-3 py-2 flex items-center gap-3 border-t border-border bg-primary/10">
                    <div className="h-4 w-4 border-2 border-primary bg-primary flex items-center justify-center flex-shrink-0 rounded-full">
                      <Check className="h-2.5 w-2.5 text-primary-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[12px] font-medium">Other: </span>
                      <span className="text-[12px] text-muted-foreground">{currentAnswer}</span>
                    </div>
                  </div>
                )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
