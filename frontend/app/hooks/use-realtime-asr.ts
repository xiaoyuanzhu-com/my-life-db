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
  const taskIdRef = useRef<string | null>(null);

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

        // Send run-task message (Aliyun schema)
        const taskId = `task_${Date.now()}`;
        taskIdRef.current = taskId;
        ws.send(JSON.stringify({
          header: {
            action: 'run-task',
            task_id: taskId,
            streaming: 'duplex'
          },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: 'fun-asr-realtime',
            input: {
              format: 'pcm',
              sample_rate: sampleRate
            }
            // parameters will be injected by the backend if not provided
          }
        }));

        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // Parse Aliyun message format
          const header = msg.header;
          const payload = msg.payload;

          if (!header) return;

          const eventType = header.event;

          switch (eventType) {
            case 'task-started':
              console.log('ASR task started:', header.task_id);
              break;

            case 'result-generated':
              // Extract transcription from Aliyun format
              const output = payload?.output;
              const sentence = output?.sentence;
              if (sentence?.text) {
                const isFinal = sentence.end_time && sentence.end_time > 0;
                onTranscript?.(sentence.text, isFinal);
              }
              break;

            case 'task-finished':
              console.log('ASR task finished');
              break;

            case 'task-failed':
              const errorMsg = payload?.message || 'ASR task failed';
              console.error('ASR error:', errorMsg, payload);
              onError?.(errorMsg);
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

          // Send binary audio data directly (Aliyun expects binary WebSocket messages)
          ws.send(int16Array.buffer);
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
    // Send finish-task message (Aliyun schema)
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && taskIdRef.current) {
      wsRef.current.send(JSON.stringify({
        header: {
          action: 'finish-task',
          task_id: taskIdRef.current,
          streaming: 'duplex'
        },
        payload: {
          input: {}
        }
      }));
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
