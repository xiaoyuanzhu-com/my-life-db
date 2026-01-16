import { useRef, useState, useCallback, useEffect } from 'react';

interface UseRealtimeASROptions {
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  sampleRate?: number;
}

export function useRealtimeASR({ onTranscript, onError, sampleRate = 16000 }: UseRealtimeASROptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const durationIntervalRef = useRef<number | null>(null);

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
        console.log('🔌 ASR WebSocket connected');

        // Send run-task message (Aliyun schema)
        const taskId = `task_${Date.now()}`;
        taskIdRef.current = taskId;
        const startMsg = {
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
        };
        console.log('📤 Sending run-task:', startMsg);
        ws.send(JSON.stringify(startMsg));

        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          console.log('📥 Received message:', msg);

          // Parse Aliyun message format
          const header = msg.header;
          const payload = msg.payload;

          if (!header) {
            console.warn('⚠️ Message missing header:', msg);
            return;
          }

          const eventType = header.event;

          switch (eventType) {
            case 'task-started':
              console.log('✅ ASR task started:', header.task_id);
              break;

            case 'result-generated':
              // Extract transcription from Aliyun format
              const output = payload?.output;
              const sentence = output?.sentence;
              console.log('🗣️ Result generated:', { sentence, isFinal: sentence?.end_time > 0 });
              if (sentence?.text) {
                const isFinal = sentence.end_time && sentence.end_time > 0;
                onTranscript?.(sentence.text, isFinal);
              }
              break;

            case 'task-finished':
              console.log('🏁 ASR task finished');
              // Close WebSocket gracefully after receiving task-finished
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.close();
                wsRef.current = null;
              }
              break;

            case 'task-failed':
              const errorMsg = payload?.message || 'ASR task failed';
              console.error('❌ ASR error:', errorMsg, payload);
              onError?.(errorMsg);
              break;

            default:
              console.log('❓ Unknown event type:', eventType, msg);
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
      const currentAnimationFrame = animationFrameRef;

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

  const stopRecording = useCallback(() => {
    // Send finish-task message (Aliyun schema)
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && taskIdRef.current) {
      const stopMsg = {
        header: {
          action: 'finish-task',
          task_id: taskIdRef.current,
          streaming: 'duplex'
        },
        payload: {
          input: {}
        }
      };
      console.log('📤 Sending finish-task:', stopMsg);
      wsRef.current.send(JSON.stringify(stopMsg));
      // Don't close immediately - wait for task-finished response
      // The ws.onmessage handler will close when it receives task-finished
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

    setIsRecording(false);
    setAudioLevel(0);
    setRecordingDuration(0);
  }, []);

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
    startRecording,
    stopRecording
  };
}
