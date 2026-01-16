import { useRef, useState, useCallback } from 'react';

interface UseRealtimeASROptions {
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  sampleRate?: number;
}

export function useRealtimeASR({ onTranscript, onError, sampleRate = 16000 }: UseRealtimeASROptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

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

      // Create WebSocket connection
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/asr/realtime`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('ASR WebSocket connected');

        // Send start message
        ws.send(JSON.stringify({
          type: 'start',
          metadata: {
            sample_rate: sampleRate,
            format: 'pcm'
          }
        }));

        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case 'start':
              console.log('ASR session started:', msg.task_id);
              break;

            case 'result':
              if (msg.text) {
                onTranscript?.(msg.text, msg.is_final || false);
              }
              break;

            case 'end':
              console.log('ASR session ended');
              break;

            case 'error':
              console.error('ASR error:', msg.error);
              onError?.(msg.error || 'ASR error occurred');
              break;
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        onError?.('Connection error');
      };

      ws.onclose = () => {
        console.log('ASR WebSocket closed');
        setIsRecording(false);
      };

      // Create audio context and processor
      const audioContext = new AudioContext({ sampleRate });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const audioData = e.inputBuffer.getChannelData(0);
          const int16Array = new Int16Array(audioData.length);

          // Convert float32 to int16
          for (let i = 0; i < audioData.length; i++) {
            int16Array[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32768));
          }

          // Send audio chunk
          ws.send(JSON.stringify({
            type: 'audio',
            metadata: {
              data: btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(int16Array.buffer))))
            }
          }));
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

    } catch (err) {
      console.error('Failed to start recording:', err);

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
    }
  }, [sampleRate, onTranscript, onError]);

  const stopRecording = useCallback(() => {
    // Send stop message
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      wsRef.current.close();
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

    wsRef.current = null;
    setIsRecording(false);
  }, []);

  return {
    isRecording,
    startRecording,
    stopRecording
  };
}
