'use client';

import { Fragment } from 'react';
import { AlertCircle, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

type DigestStageStatus = 'to-do' | 'in-progress' | 'success' | 'failed';

interface DigestProgressStage {
  key: string;
  label: string;
  status: DigestStageStatus;
}

interface DigestProgressProps {
  stages: DigestProgressStage[];
  action?: React.ReactNode;
  message?: string | null;
}

function statusLabel(status: DigestStageStatus): string {
  switch (status) {
    case 'success':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'in-progress':
      return 'In Progress';
    default:
      return 'Waiting';
  }
}

function statusClasses(status: DigestStageStatus): { dot: string; icon: JSX.Element } {
  switch (status) {
    case 'success':
      return {
        dot: 'bg-emerald-500 text-emerald-50 border-emerald-500',
        icon: <CheckCircle2 className="h-4 w-4" />,
      };
    case 'failed':
      return {
        dot: 'bg-red-500 text-red-50 border-red-500',
        icon: <XCircle className="h-4 w-4" />,
      };
    case 'in-progress':
      return {
        dot: 'bg-primary/10 text-primary border-primary/80',
        icon: <Loader2 className="h-4 w-4 animate-spin" />,
      };
    default:
      return {
        dot: 'bg-muted text-muted-foreground border-border',
        icon: <Circle className="h-4 w-4" />,
      };
  }
}

function connectorClass(prevStatus: DigestStageStatus): string {
  if (prevStatus === 'success') {
    return 'bg-emerald-500';
  }
  if (prevStatus === 'failed') {
    return 'bg-red-400';
  }
  if (prevStatus === 'in-progress') {
    return 'bg-primary/60';
  }
  return 'bg-border';
}

export function DigestProgress({ stages, action, message }: DigestProgressProps) {
  return (
    <section className="bg-card rounded-lg border">
      <div className="border-b border-border px-6 py-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Digest Progress</h2>
            <p className="text-xs text-muted-foreground">Track progress across crawl, summary, and tagging</p>
          </div>
          {action}
        </div>
        {message && (
          <p className="text-xs text-amber-600 flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {message}
          </p>
        )}
      </div>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          {stages.map((stage, index) => {
            const classes = statusClasses(stage.status);
            return (
              <Fragment key={stage.key}>
                {index > 0 && (
                  <div className={cn('h-[2px] flex-1 rounded-full', connectorClass(stages[index - 1].status))} />
                )}
                <div className="flex flex-col items-center gap-2">
                  <div className={cn('flex h-9 w-9 items-center justify-center rounded-full border', classes.dot)}>
                    {classes.icon}
                  </div>
                  <span className="text-xs font-medium text-foreground">{stage.label}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {statusLabel(stage.status)}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}
