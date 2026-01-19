interface RecordingTimerProps {
  seconds: number;
  className?: string;
}

export function RecordingTimer({ seconds, className = '' }: RecordingTimerProps) {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  return (
    <span className={`text-xs font-mono text-muted-foreground tabular-nums ${className}`}>
      {minutes.toString().padStart(2, '0')}:{secs.toString().padStart(2, '0')}
    </span>
  );
}
