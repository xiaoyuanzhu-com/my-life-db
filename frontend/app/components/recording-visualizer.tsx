import { useEffect, useRef } from 'react';

interface RecordingVisualizerProps {
  audioLevel: number; // 0-100 scale
  duration: number; // seconds elapsed
  className?: string;
}

export function RecordingVisualizer({ audioLevel, duration, className = '' }: RecordingVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Format duration as MM:SS
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Draw waveform on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to match display size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Clear canvas
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Draw waveform bars
    const barCount = 40;
    const barWidth = rect.width / barCount;
    const maxBarHeight = rect.height * 0.8;
    const minBarHeight = 3;

    // Create bars with varying heights based on audio level
    for (let i = 0; i < barCount; i++) {
      // Create wave effect: recent bars are taller, older bars fade
      const age = (barCount - i) / barCount; // 1 (oldest) to 0 (newest)
      const heightMultiplier = 1 - (age * 0.7); // Recent bars are 100%, old bars are 30%

      // Add some randomness for organic look
      const randomVariation = 0.7 + (Math.random() * 0.3); // 0.7-1.0

      // Calculate bar height based on audio level
      const targetHeight = minBarHeight + ((audioLevel / 100) * maxBarHeight * heightMultiplier * randomVariation);

      // Center bars vertically
      const barHeight = Math.min(targetHeight, maxBarHeight);
      const y = (rect.height - barHeight) / 2;
      const x = i * barWidth;

      // Use destructive color for recording state
      ctx.fillStyle = `hsl(var(--destructive) / ${0.4 + (heightMultiplier * 0.6)})`;
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
    }
  }, [audioLevel]);

  return (
    <div className={`flex flex-col gap-2 px-4 py-3 bg-muted/50 border-y border-border ${className}`}>
      {/* Timer and Recording Indicator */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          {/* Pulsing red dot */}
          <div className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-destructive"></span>
          </div>
          <span className="text-muted-foreground font-medium">Recording</span>
        </div>

        {/* Duration timer */}
        <span className="font-mono text-muted-foreground tabular-nums">
          {formatDuration(duration)}
        </span>
      </div>

      {/* Waveform Canvas */}
      <canvas
        ref={canvasRef}
        className="w-full h-[48px] rounded"
        style={{ imageRendering: 'crisp-edges' }}
      />
    </div>
  );
}
