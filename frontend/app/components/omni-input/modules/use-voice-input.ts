import { useCallback, useRef } from 'react';
import { useRealtimeASR } from '~/hooks/use-realtime-asr';

interface UseVoiceInputOptions {
  onError?: (error: string) => void;
}

export interface VoiceInputControls {
  // State
  isRecording: boolean;
  audioLevel: number;
  duration: number;
  transcript: {
    finalized: string;
    partial: string;
  };
  recordedAudio: Blob | null;
  isRefining: boolean;

  // Actions
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * Voice input hook - wraps use-realtime-asr with a cleaner interface
 * Manages all voice recording and ASR state
 * Returns data + controls, NO UI
 */
export function useVoiceInput(options?: UseVoiceInputOptions): VoiceInputControls {
  const saveAudioRef = useRef(false);

  const handleRecordingComplete = useCallback((_audioBlob: Blob | null) => {
    // This callback is handled by the main component
    // which will check saveAudioRef to decide what to do with the blob
  }, []);

  const {
    isRecording,
    audioLevel,
    recordingDuration,
    rawTranscript,
    partialSentence,
    recordedAudio,
    startRecording,
    stopRecording
  } = useRealtimeASR({
    saveAudio: saveAudioRef.current,
    onError: options?.onError,
    onRecordingComplete: handleRecordingComplete
  });

  // Wrapper functions to maintain consistent interface
  const start = useCallback(async () => {
    await startRecording();
  }, [startRecording]);

  const stop = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  return {
    isRecording,
    audioLevel,
    duration: recordingDuration,
    transcript: {
      finalized: rawTranscript,
      partial: partialSentence
    },
    recordedAudio,
    start,
    stop
  };
}

/**
 * Helper hook to expose saveAudio control separately
 * This allows the main component to manage the save audio checkbox state
 */
export function useVoiceInputWithSaveAudio(options?: UseVoiceInputOptions) {
  const saveAudioRef = useRef(false);

  const handleRecordingComplete = useCallback((_audioBlob: Blob | null) => {
    // Callback will be provided by component using this hook
  }, []);

  const {
    isRecording,
    audioLevel,
    recordingDuration,
    rawTranscript,
    partialSentence,
    recordedAudio,
    isRefining,
    startRecording,
    stopRecording
  } = useRealtimeASR({
    saveAudio: saveAudioRef.current,
    onError: options?.onError,
    onRecordingComplete: handleRecordingComplete
  });

  return {
    isRecording,
    audioLevel,
    duration: recordingDuration,
    transcript: {
      finalized: rawTranscript,
      partial: partialSentence
    },
    recordedAudio,
    isRefining,
    saveAudioRef, // Expose ref for external control
    start: startRecording,
    stop: stopRecording
  };
}
