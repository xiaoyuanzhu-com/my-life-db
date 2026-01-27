import { useRef, useState, useCallback, useEffect } from 'react';
import { api } from '~/lib/api';

interface UseRealtimeASROptions {
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  onRecordingComplete?: (audioBlob: Blob | null) => void; // Called when recording stops
  onRefinedTranscript?: (text: string) => void; // Called when ASR refinement completes
  saveAudio?: boolean; // Whether to save audio recording
  sampleRate?: number;
}

export function useRealtimeASR({ onTranscript, onError, onRecordingComplete, onRefinedTranscript, saveAudio = false, sampleRate = 16000 }: UseRealtimeASROptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [rawTranscript, setRawTranscript] = useState(''); // Accumulated final sentences
  const [partialSentence, setPartialSentence] = useState(''); // Current partial sentence
  const [recordedAudio, setRecordedAudio] = useState<Blob | null>(null); // Recorded audio blob
  const [isRefining, setIsRefining] = useState(false); // Whether ASR refinement is in progress
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const durationIntervalRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const wsDoneResolverRef = useRef<(() => void) | null>(null);

  const startRecording = useCallback(async () => {
    try {
      // Ensure we're in a browser environment
      if (typeof window === 'undefined') {
        throw new Error('Voice input is only available in the browser');
      }

      // Check if browser supports required APIs
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access is not supported in this browser');
      }

      if (typeof AudioContext === 'undefined' && typeof (window as any).webkitAudioContext === 'undefined') {
        throw new Error('Web Audio API is not supported in this browser');
      }

      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Always initialize MediaRecorder (for ASR refinement)
      // saveAudio only controls whether the audio is attached to the inbox entry
      audioChunksRef.current = []; // Reset chunks
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm' // Use WebM for better browser support
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start(1000); // Collect data every second
      mediaRecorderRef.current = mediaRecorder;
      console.log('🎙️ MediaRecorder started (for ASR refinement)');

      // Create WebSocket connection
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/asr/realtime`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('🔌 ASR WebSocket connected');

        // Send start message (our vendor-agnostic schema)
        const startMsg = {
          type: 'start',
          payload: {}
        };
        console.log('📤 Sending start:', startMsg);
        ws.send(JSON.stringify(startMsg));

        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          console.log('📥 Received message:', JSON.stringify(msg));

          // Parse our vendor-agnostic message format
          const msgType = msg.type;
          const payload = msg.payload;

          if (!msgType) {
            console.warn('⚠️ Message missing type:', msg);
            return;
          }

          switch (msgType) {
            case 'ready':
              console.log('✅ ASR ready');
              break;

            case 'transcript': {
              // Extract transcription from our format
              const text = payload?.text || '';
              const isFinal = payload?.is_final || false;
              const hasText = text.trim().length > 0;

              console.log('🗣️ Transcript:', JSON.stringify({ text, isFinal }));

              // Update transcript state
              // Backend sends progressive FULL updates per sentence, then finalizes with is_final: true
              if (isFinal && hasText) {
                // Final: Append to accumulated transcript, clear partial
                setRawTranscript(prev => prev ? `${prev} ${text}` : text);
                setPartialSentence('');
              } else if (isFinal && !hasText) {
                // Empty final sentence (silence marker): just clear partial
                setPartialSentence('');
              } else if (hasText) {
                // Partial: Update current sentence being spoken
                setPartialSentence(text);
              }
              // IMPORTANT: Ignore empty non-final transcripts - don't clear partialSentence
              // This prevents the display from clearing when stop is sent

              // Call the callback for backwards compatibility (only if has text)
              if (hasText) {
                onTranscript?.(text, isFinal);
              }
              break;
            }

            case 'done':
              console.log('🏁 ASR finished');

              // Notify that WebSocket is done (for stopRecording to wait)
              if (wsDoneResolverRef.current) {
                wsDoneResolverRef.current();
                wsDoneResolverRef.current = null;
              }

              // Close WebSocket gracefully after receiving done
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.close();
                wsRef.current = null;
              }
              break;

            case 'error': {
              const errorMsg = payload?.message || 'ASR error';
              console.error('❌ ASR error:', errorMsg, payload);
              onError?.(errorMsg);
              break;
            }

            default:
              console.log('❓ Unknown message type:', msgType, msg);
          }
        } catch (err) {
          console.error('❌ Failed to parse WebSocket message:', err);
        }
      };

      ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        onError?.('Connection error');
      };

      ws.onclose = () => {
        console.log('🔌 ASR WebSocket closed');
        setIsRecording(false);
      };

      // Create audio context and processor
      const audioContext = new AudioContext({ sampleRate });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // Create analyser for audio level visualization
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      // Connect audio graph: source -> analyser -> processor -> destination
      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(audioContext.destination);

      // Start duration timer
      setRecordingDuration(0);
      durationIntervalRef.current = window.setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);

      // Update audio level periodically using requestAnimationFrame
      const animationFrameRef = { current: 0 };
      const updateAudioLevel = () => {
        if (analyserRef.current && audioContextRef.current?.state === 'running') {
          const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(dataArray);

          // Calculate average volume (0-100 scale)
          const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
          const normalizedLevel = Math.min(100, (average / 255) * 150); // Boost sensitivity
          setAudioLevel(normalizedLevel);

          animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
        }
      };
      updateAudioLevel();

      // Store animation frame ID for cleanup
      const _currentAnimationFrame = animationFrameRef;

      let audioChunkCount = 0;
      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const audioData = e.inputBuffer.getChannelData(0);
          const int16Array = new Int16Array(audioData.length);

          // Convert float32 to int16
          for (let i = 0; i < audioData.length; i++) {
            int16Array[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32768));
          }

          // Log every 50th chunk to avoid spam
          audioChunkCount++;
          if (audioChunkCount % 50 === 0) {
            console.log(`🎤 Sent ${audioChunkCount} audio chunks (${int16Array.buffer.byteLength} bytes each)`);
          }

          // Send binary audio data directly (Aliyun expects binary WebSocket messages)
          ws.send(int16Array.buffer);
        }
      };

    } catch (err) {
      console.error('Failed to start recording:', err);

      // Clean up on error
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }

      // Provide user-friendly error messages
      let errorMessage = 'Failed to start recording';
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          errorMessage = 'Microphone permission denied. Please allow microphone access in your browser settings.';
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          errorMessage = 'No microphone found. Please connect a microphone and try again.';
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          errorMessage = 'Microphone is already in use by another application.';
        } else {
          errorMessage = err.message;
        }
      }

      onError?.(errorMessage);
      setIsRecording(false);
      setAudioLevel(0);
      setRecordingDuration(0);
    }
  }, [sampleRate, onTranscript, onError]);

  const stopRecording = useCallback(async () => {
    console.log('🛑 Stop recording called, saveAudio:', saveAudio);

    // Send stop message (our vendor-agnostic schema) and wait for WebSocket to finish
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const stopMsg = {
        type: 'stop',
        payload: {}
      };
      console.log('📤 Sending stop:', stopMsg);
      wsRef.current.send(JSON.stringify(stopMsg));

      // Wait for 'done' response before proceeding with refinement
      await new Promise<void>((resolve) => {
        wsDoneResolverRef.current = resolve;
        // Timeout after 5 seconds if no 'done' message
        setTimeout(() => {
          if (wsDoneResolverRef.current === resolve) {
            console.warn('⚠️ WebSocket done timeout, proceeding anyway');
            wsDoneResolverRef.current = null;
            resolve();
          }
        }, 5000);
      });
      console.log('✅ WebSocket finished, proceeding with refinement');
    }

    // Always record audio (for refinement), regardless of saveAudio setting
    // saveAudio only controls whether to attach the audio file to the inbox entry
    let audioBlob: Blob | null = null;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      console.log('🎙️ Stopping MediaRecorder, state:', mediaRecorderRef.current.state);

      // Wait for MediaRecorder to stop and create blob
      audioBlob = await new Promise<Blob>((resolve) => {
        if (!mediaRecorderRef.current) {
          resolve(new Blob());
          return;
        }

        mediaRecorderRef.current.onstop = () => {
          const blob = new Blob(audioChunksRef.current, {
            type: 'audio/webm'
          });
          console.log('🎙️ MediaRecorder stopped, created blob:', blob.size, 'bytes');
          resolve(blob);
        };

        mediaRecorderRef.current.stop();
      });

      setRecordedAudio(audioBlob);

      // Refine transcript using batch ASR (always, regardless of saveAudio)
      if (audioBlob && audioBlob.size > 0) {
        console.log('🔄 Starting ASR refinement...');
        setIsRefining(true);

        try {
          // Create a File object and use FormData for multipart upload
          const tempFileName = `${Date.now()}.webm`;
          const formData = new FormData();
          const file = new File([audioBlob], tempFileName, { type: 'audio/webm' });
          formData.append('audio', file);

          // Call ASR endpoint with multipart upload
          const asrRes = await api.fetch('/api/asr', {
            method: 'POST',
            body: formData
          });

          if (!asrRes.ok) {
            const errorText = await asrRes.text();
            throw new Error(`ASR refinement failed: ${errorText}`);
          }

          const asrData = await asrRes.json();
          const refinedText = asrData.text || '';

          console.log('✅ ASR refinement complete:', refinedText);

          // Update transcript with refined version
          setRawTranscript(refinedText);
          onRefinedTranscript?.(refinedText);
        } catch (err) {
          console.error('❌ ASR refinement failed:', err);
          onError?.('Failed to refine transcript: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
          setIsRefining(false);
        }
      }

      // Notify completion (only if saveAudio is enabled, audio should be attached)
      onRecordingComplete?.(saveAudio ? audioBlob : null);

      // Clean up
      mediaRecorderRef.current = null;
      audioChunksRef.current = [];
    } else {
      // No MediaRecorder active (shouldn't happen anymore since we always record)
      console.log('🎙️ No MediaRecorder active');
      setRecordedAudio(null);
      onRecordingComplete?.(null);
    }

    // Stop duration timer
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    // Clean up audio analyser
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    // Clean up audio context
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Stop media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Don't set isRecording = false here - let ws.onclose do it after final transcript arrives
    setAudioLevel(0);
    setRecordingDuration(0);
  }, [saveAudio, onRecordingComplete, onRefinedTranscript, onError]);

  // Reset transcripts and audio only when starting new recording (not when stopping)
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (isRecording && !wasRecordingRef.current) {
      // Just started recording (transition from false to true)
      setRawTranscript('');
      setPartialSentence('');
      setRecordedAudio(null);
    }
    wasRecordingRef.current = isRecording;
  }, [isRecording]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
    };
  }, []);

  return {
    isRecording,
    audioLevel,
    recordingDuration,
    rawTranscript,
    partialSentence,
    recordedAudio,
    isRefining,
    startRecording,
    stopRecording
  };
}
