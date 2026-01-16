# Real-Time ASR API

This document describes the vendor-agnostic real-time speech recognition (ASR) API.

## Overview

The real-time ASR API provides a WebSocket-based interface for streaming audio and receiving transcription results in real-time. The API is vendor-agnostic, meaning the backend automatically routes to the configured ASR provider without requiring client-side changes.

## Endpoint

```
ws://localhost:12345/api/asr/realtime
```

## Supported Providers

The backend supports multiple ASR providers, configured via settings:

- **Aliyun Fun-ASR Realtime** (`fun-asr-realtime`) - Default, supports Chinese and English
- **HAID** (`haid`) - Not yet implemented for real-time ASR
- **Fun-ASR** (`fun-asr`) - Recorded audio only, not for real-time

Configure the provider in settings:
```json
{
  "vendors": {
    "aliyun": {
      "asrProvider": "fun-asr-realtime"
    }
  }
}
```

## Message Format

All messages are JSON-formatted and follow a vendor-agnostic schema:

### Client → Server Messages

#### 1. Start Session
```json
{
  "type": "start",
  "metadata": {
    "model": "fun-asr-realtime",
    "sample_rate": 16000,
    "format": "pcm",
    "language": "zh",
    "diarization": false
  }
}
```

**Fields:**
- `model` (optional): Model name (provider-specific, default: `fun-asr-realtime`)
- `sample_rate` (optional): Audio sample rate in Hz (default: 16000)
- `format` (optional): Audio format - `pcm`, `opus`, `wav`, etc (default: `pcm`)
- `language` (optional): Language code (e.g., `zh`, `en`)
- `diarization` (optional): Enable speaker diarization (default: false)

#### 2. Send Audio Data
```json
{
  "type": "audio",
  "metadata": {
    "data": "<base64 or raw binary audio data>"
  }
}
```

**Notes:**
- Send audio in small chunks (e.g., 100ms intervals)
- Audio format must match the format specified in the start message

#### 3. Stop Session
```json
{
  "type": "stop"
}
```

### Server → Client Messages

#### 1. Session Started
```json
{
  "type": "start",
  "task_id": "task_1234567890"
}
```

#### 2. Transcription Result
```json
{
  "type": "result",
  "task_id": "task_1234567890",
  "text": "你好世界",
  "is_final": false,
  "timestamp": 1.234
}
```

**Fields:**
- `text`: Transcribed text
- `is_final`: Whether this is a final result (true) or partial/interim (false)
- `timestamp`: Time in seconds from the start of the audio

#### 3. Session Ended
```json
{
  "type": "end",
  "task_id": "task_1234567890"
}
```

#### 4. Error
```json
{
  "type": "error",
  "task_id": "task_1234567890",
  "error": "Error message describing what went wrong"
}
```

## Example Usage (JavaScript)

```javascript
// Connect to WebSocket
const ws = new WebSocket('ws://localhost:12345/api/asr/realtime');

ws.onopen = () => {
  console.log('Connected to ASR service');

  // Start ASR session
  ws.send(JSON.stringify({
    type: 'start',
    metadata: {
      sample_rate: 16000,
      format: 'pcm'
    }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'start':
      console.log('Session started:', msg.task_id);
      break;

    case 'result':
      console.log(`[${msg.is_final ? 'FINAL' : 'PARTIAL'}] ${msg.text}`);
      break;

    case 'end':
      console.log('Session ended');
      break;

    case 'error':
      console.error('Error:', msg.error);
      break;
  }
};

// Send audio data (example using Web Audio API)
navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
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
        data: btoa(String.fromCharCode.apply(null, new Uint8Array(int16Array.buffer)))
      }
    }));
  };

  source.connect(processor);
  processor.connect(audioContext.destination);
});

// Stop ASR session when done
setTimeout(() => {
  ws.send(JSON.stringify({ type: 'stop' }));
}, 10000); // Stop after 10 seconds
```

## Audio Format Requirements

### PCM (Recommended)
- Single channel (mono)
- Sample rate: 8000, 16000, 24000, 32000, 44100, or 48000 Hz
- Bit depth: 16-bit signed integers (little-endian)

### Other Formats
- **WAV**: Must use PCM encoding
- **Opus**: Must be in Ogg container
- **Speex**: Must be in Ogg container
- **AMR**: Only AMR-NB (narrowband) supported

## Error Handling

The server will send error messages in the following situations:

1. **Provider not configured**: The selected ASR provider is not configured in settings
2. **Invalid audio format**: The audio format is not supported
3. **Connection failure**: Failed to connect to the upstream ASR provider
4. **Task failure**: The ASR task failed on the provider side

Always handle error messages gracefully and inform the user.

## Rate Limits

Rate limits depend on the configured provider:
- **Aliyun Fun-ASR Realtime**: Subject to Aliyun's rate limits (check your account)
- **HAID**: Subject to your self-hosted instance limits

## Best Practices

1. **Send audio in small chunks**: Send audio data in 100-200ms intervals for smooth real-time transcription
2. **Handle partial results**: Display partial results to the user while waiting for final results
3. **Buffer management**: Implement proper buffering to avoid sending too much data at once
4. **Error recovery**: Implement reconnection logic for network failures
5. **User feedback**: Show connection status and transcription state to the user

## Provider-Specific Notes

### Aliyun Fun-ASR Realtime

- Best performance with 16kHz PCM audio
- Supports Chinese and English
- Provides word-level timestamps in results
- Automatically handles punctuation and text normalization
- Session timeout: ~60 seconds of silence

## Configuration

Set the ASR provider in your environment variables or settings:

```bash
# Environment variable (used if not set in database)
export ALIYUN_ASR_REALTIME_PROVIDER=fun-asr-realtime
export DASHSCOPE_API_KEY=your_api_key_here
export ALIYUN_REGION=cn-beijing  # or "singapore"
```

Or configure via the settings API:
```json
{
  "vendors": {
    "aliyun": {
      "apiKey": "your_api_key_here",
      "region": "beijing",
      "asrProvider": "fun-asr-realtime"
    }
  }
}
```
