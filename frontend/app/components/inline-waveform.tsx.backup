import { useEffect, useRef } from 'react';

interface InlineWaveformProps {
  audioLevel: number; // 0-100 scale
  saveAudio?: boolean; // Whether to save audio recording
  onSaveAudioChange?: (enabled: boolean) => void; // Toggle save audio
  className?: string;
}

export function InlineWaveform({ audioLevel, saveAudio = false, onSaveAudioChange, className = '' }: InlineWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Draw compact waveform on canvas
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

    // Draw compact waveform bars
    const barCount = 12;
    const barWidth = 2;
    const gap = 2;
    const totalWidth = barCount * (barWidth + gap) - gap;
    const startX = (rect.width - totalWidth) / 2;
    const maxBarHeight = rect.height * 0.8;
    const minBarHeight = 2;

    // Create bars with varying heights based on audio level
    for (let i = 0; i < barCount; i++) {
      // Create wave effect: recent bars are taller, older bars fade
      const age = (barCount - i) / barCount; // 1 (oldest) to 0 (newest)
      const heightMultiplier = 1 - (age * 0.6); // Recent bars are 100%, old bars are 40%

      // Add some randomness for organic look
      const randomVariation = 0.8 + (Math.random() * 0.2); // 0.8-1.0

      // Calculate bar height based on audio level
      const targetHeight = minBarHeight + ((audioLevel / 100) * maxBarHeight * heightMultiplier * randomVariation);

      // Center bars vertically
      const barHeight = Math.min(targetHeight, maxBarHeight);
      const y = (rect.height - barHeight) / 2;
      const x = startX + i * (barWidth + gap);

      // Use destructive color for recording state
      ctx.fillStyle = `hsl(var(--destructive) / ${0.5 + (heightMultiplier * 0.5)})`;
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }, [audioLevel]);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <canvas
        ref={canvasRef}
        className="h-5 w-16"
        style={{ imageRendering: 'crisp-edges' }}
      />
      {onSaveAudioChange && (
        <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={saveAudio}
            onChange={(e) => onSaveAudioChange(e.target.checked)}
            className="w-3 h-3 rounded border-border bg-background text-primary focus:ring-1 focus:ring-primary cursor-pointer"
          />
          <span className="text-xs text-muted-foreground select-none">Save Audio</span>
        </label>
      )}
    </div>
  );
}
