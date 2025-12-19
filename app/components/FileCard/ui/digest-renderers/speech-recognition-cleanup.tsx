/**
 * Speech Recognition Cleanup Renderer
 * Displays cleaned/polished transcription with speaker diarization
 * Supports optional sync with audio playback (highlight, scroll, seek)
 *
 * Uses the same format as speech-recognition since cleanup produces identical JSON structure
 */

import { SpeechRecognitionRenderer } from './speech-recognition';

interface Props {
  content: string | null;
  sqlarName?: string | null;
  filePath?: string;
  /** Current playback time in seconds (enables sync mode) */
  currentTime?: number;
  /** Callback when user clicks a segment to seek */
  onSeek?: (time: number) => void;
}

export function SpeechRecognitionCleanupRenderer(props: Props) {
  // Reuse the speech-recognition renderer since cleanup produces the same JSON format
  return <SpeechRecognitionRenderer {...props} />;
}
