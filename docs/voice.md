# Voice Input System

## Overview

MyLifeDB features a real-time voice input system inspired by Plaud Note, providing live transcription with visual feedback, multi-view transcript processing, and seamless integration into the inbox workflow.

## UX Design

### Recording Experience

#### Two-Pass ASR System

**First Pass: Real-time Transcription**:
- Uses `fun-asr-realtime` model for instant feedback during recording
- Streams partial transcripts with ~1-2 second latency
- Low accuracy but provides immediate visual feedback

**Second Pass: High-Quality Refinement**:
- Automatically triggered after stopping recording
- Uses `fun-asr` (non-realtime) model for better accuracy
- Processes the saved audio file through batch ASR
- Replaces real-time transcript with refined version
- Shows "Refining transcript..." placeholder during processing
- Typically completes in 2-5 seconds for short recordings

**Benefits**:
- User sees instant feedback during recording (real-time pass)
- Final transcript is more accurate (refinement pass)
- Best of both worlds: responsiveness + quality
- No user action required - fully automatic

#### Visual Feedback During Recording

**Waveform Visualizer**:
- Canvas-based 40-bar waveform animation
- Real-time audio level visualization (0-100 scale)
- Organic wave effect with age-based height variation
- Positioned between textarea and control bar

**Recording Timer**:
- MM:SS format, updates every second
- Displayed prominently with recording indicator
- Pulsing red dot animation using Tailwind's `animate-ping`

**Button States**:
1. **Idle**: Ghost mic button (h-8 w-8, larger touch target)
2. **Recording**: Destructive button with:
   - Pulsing white dot indicator
   - Mic icon
   - "Stop" text label
   - Enhanced visibility (h-8, px-3)

**Transcript Display**:
- Partial transcripts: Gray overlay (60% opacity) during recording
- Final transcripts: Append to content immediately
- Clear separation prevents accidental submission of partial text
- Post-recording refinement: Shows "Refining transcript..." placeholder while processing

### Three-Tab Review Modal (Phase 2)

#### Tab 1: Raw Transcript
**What**: Unmodified ASR output
- Real-time updates as transcription arrives
- Shows all filler words (um, uh, like, you know)
- Raw punctuation from ASR engine
- Speaker labels if available
- Fully editable

**Update frequency**: Every 1-2 seconds (ASR latency)

**Use cases**:
- Verify transcription accuracy
- Legal/medical contexts requiring exact words
- Debugging ASR quality issues

#### Tab 2: Cleaned Transcript
**What**: Polished version preserving original meaning
- Removes filler words automatically
- Fixes common ASR errors (homophones)
- Improves punctuation and capitalization
- Maintains original meaning and content
- Fully editable

**Update frequency**: Every 3-5 seconds (debounced)

**Processing**:
- Regex-based cleanup (fast, local, no API calls)
- Runs incrementally as new sentences arrive
- Shows "Cleaning..." indicator briefly

**Cleanup operations**:
```javascript
// Remove filler words
text.replace(/\b(um|uh|like|you know)\b/gi, '')

// Fix capitalization
sentences.map(s => s.charAt(0).toUpperCase() + s.slice(1))

// Common ASR fixes
replacements = {
  'your welcome': 'you\'re welcome',
  'should of': 'should have',
  'could of': 'could have',
  // ... more patterns
}
```

**Use cases**:
- Quick notes that need to be readable
- Sharing transcripts with others
- Most common use case (80% of usage)

#### Tab 3: AI Summary
**What**: Condensed/restructured intelligent summary
- Key points as bullet points
- Action items extracted
- Main topics identified
- Template-based formatting

**Update frequency**: Every 30 seconds (rate limited, >30s duration)

**Processing**:
- LLM API call (OpenAI/Claude)
- Progressive summarization (cumulative)
- Lazy generation (only when tab is viewed)
- Cached once generated

**Summary timeline**:
```
0-30s:   "Keep talking..." (no summary yet)
30s:     First summary appears (2-3 bullet points)
60s:     Summary updates with new content
2min+:   Full structured summary with sections
5min+:   Detailed summary with action items
```

**Summary formats**:
- **Default**: Bullet points with key topics
- **Meeting**: Attendees, decisions, action items, next steps
- **Interview**: Main themes, quotes, follow-up questions
- **Brainstorm**: Ideas, pros/cons, next actions

**Use cases**:
- Long recordings (meetings, interviews >5min)
- Quick reference later
- Sharing highlights with team

### Modal Actions

**Primary Actions**:
1. **Save to Inbox** (primary button)
   - Adds entry to inbox with selected transcript version
   - Can choose which tab's content to save
   - Includes metadata (duration, timestamp)

2. **Discard** (destructive button)
   - Deletes recording and transcripts
   - Confirms before deletion
   - Removes temp audio file

3. **Save as Draft** (secondary button)
   - Saves to recordings library for later review
   - Preserves all 3 transcript versions
   - Can be reopened and edited later

### Tab Switching During Recording

**Behavior**:
- All 3 tabs update in real-time during recording
- Switch freely between tabs while recording
- Auto-scroll keeps latest content visible
- Update indicators show freshness:
  - "⏳ Transcribing..." (Raw)
  - "🧹 Cleaning... (updated 2s ago)" (Cleaned)
  - "💡 Next update in 18s..." (Summary)

**Performance**:
- Raw: Always active (free)
- Cleaned: Eager processing (cheap, <10ms)
- Summary: Lazy processing (expensive, only if tab viewed + >30s duration)

## Technical Architecture

### Frontend Components

#### Hook: `useRealtimeASR`
**File**: `frontend/app/hooks/use-realtime-asr.ts`

**State**:
```typescript
interface UseRealtimeASRReturn {
  isRecording: boolean;           // Recording active
  audioLevel: number;             // 0-100 scale for visualization
  recordingDuration: number;      // Elapsed seconds
  rawTranscript: string;          // Accumulated final sentences
  partialSentence: string;        // Current partial sentence
  isRefining: boolean;            // Refinement in progress
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}
```

**Audio Processing**:
- `AudioContext` at 16kHz sample rate
- `AnalyserNode` for amplitude extraction (FFT size: 256)
- `ScriptProcessorNode` for audio chunking (4096 samples)
- WebSocket binary messages for audio streaming

**Level Calculation**:
```javascript
// Extract frequency data
analyser.getByteFrequencyData(dataArray);

// Calculate average amplitude
const average = dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;

// Normalize to 0-100 with sensitivity boost
const level = Math.min(100, (average / 255) * 150);
```

**Timer Management**:
- `setInterval` updates duration every 1000ms
- `requestAnimationFrame` updates audio level (~60fps)
- Proper cleanup on stop/unmount

#### Component: `RecordingVisualizer`
**File**: `frontend/app/components/recording-visualizer.tsx`

**Props**:
```typescript
interface RecordingVisualizerProps {
  audioLevel: number;   // Current volume (0-100)
  duration: number;     // Elapsed seconds
  className?: string;
}
```

**Canvas Rendering**:
- 40 bars, responsive width
- Height: 48px
- Bar width: `containerWidth / 40`
- Bar height: `minHeight + (audioLevel * maxHeight * heightMultiplier * randomVariation)`

**Animation**:
- Age-based fade: Recent bars 100% height, older bars 30%
- Random variation: 0.7-1.0 multiplier for organic feel
- Color: `hsl(var(--destructive) / opacity)` with age-based opacity
- Updates on every `audioLevel` change (React effect)

**Timer Formatting**:
```javascript
const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};
```

#### Integration: `OmniInput`
**File**: `frontend/app/components/omni-input.tsx`

**Layout**:
```
┌─────────────────────────────────────┐
│ Textarea                            │
│ (disabled during recording)         │
│                                     │
│ [Partial transcript overlay]        │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ RecordingVisualizer                 │ ← Only when isRecording
│ (waveform + timer + indicator)      │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ File chips (if any)                 │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ [+] [Search Status] [Mic/Stop/Send] │ ← Control bar
└─────────────────────────────────────┘
```

**State Management**:
```typescript
const [partialTranscript, setPartialTranscript] = useState('');
const {
  isRecording,
  audioLevel,
  recordingDuration,
  rawTranscript,
  cleanedTranscript,
  summary,
  startRecording,
  stopRecording
} = useRealtimeASR({
  onTranscript: (text, isFinal) => {
    if (isFinal) {
      setContent(prev => prev ? `${prev} ${text}` : text);
      setPartialTranscript('');
    } else {
      setPartialTranscript(text);
    }
  },
  onError: (errorMsg) => setError(`Voice input error: ${errorMsg}`)
});
```

### Backend Architecture

#### WebSocket Proxy: `RealtimeASR`
**File**: `backend/api/realtime_asr.go`

**Architecture**: Vendor-agnostic proxy with message transformation

**Flow**:
```
Client (Browser)
    ↓ WebSocket (our schema: "start", "stop" + binary audio)
Backend Proxy (Go)
    ↓ Transform our schema → provider schema
    ↓ WebSocket (Aliyun schema: "run-task", "finish-task" + binary audio)
ASR Provider (Aliyun/OpenAI/etc)
    ↓ WebSocket (provider schema: transcription results)
Backend Proxy (Go)
    ↓ Transform provider schema → our schema
    ↓ WebSocket (our schema: "transcript", "done", "error")
Client (Browser)
```

**Benefits of Abstraction**:
- Frontend decoupled from ASR provider implementation
- Can swap providers (Aliyun → OpenAI Whisper → Deepgram) without frontend changes
- Consistent API regardless of upstream provider quirks
- Backend handles provider-specific authentication and configuration

**Message Types**:

1. **Client → Backend**:
   - Text: `start`, `stop` (JSON control messages)
   - Binary: PCM audio chunks (int16, 16kHz)

2. **Backend → Client**:
   - Text: `ready`, `transcript`, `done`, `error` (JSON responses)

**Our Vendor-Agnostic Message Format**:

```json
// Client sends "start" to begin recording
{
  "type": "start",
  "payload": {}
}

// Backend responds "ready" when ASR is initialized
{
  "type": "ready",
  "payload": {}
}

// Backend sends "transcript" for each result (partial or final)
{
  "type": "transcript",
  "payload": {
    "text": "transcribed text",     // FULL text of current sentence
    "is_final": false | true,       // true if finalized, false if partial
    "begin_time": 520,              // Milliseconds from start (optional)
    "end_time": 5600,               // Milliseconds from start (optional)
    "speaker_id": "speaker_1"       // Speaker identifier (optional, if diarization enabled)
  }
}

// Client sends "stop" to end recording
{
  "type": "stop",
  "payload": {}
}

// Backend responds "done" when ASR has finished
{
  "type": "done",
  "payload": {
    "temp_audio_path": "/path/to/temp/20060102_150405.pcm"  // Optional: Path for refinement
  }
}

// Backend sends "error" if something goes wrong
{
  "type": "error",
  "payload": {
    "message": "error description",
    "code": "error_code"
  }
}
```

**ASR Behavior** (Important):
- **Per-sentence updates**: Each `transcript` message contains the **complete text** of the **current sentence** only
- **Progressive refinement**: While you're speaking one sentence, the backend sends multiple updates with progressively refined **full sentence text** (not incremental words)
- **Sentence finalization**: When you pause, the backend sends a final `transcript` message with `is_final: true`
- **Multi-sentence session**: The frontend must **accumulate** final sentences to build the complete transcript (hook provides `rawTranscript` for this)
- **Silence markers**: Empty `transcript` messages with `is_final: true` and empty `text` indicate silence between speaking segments
- **Vendor abstraction**: The backend transforms provider-specific formats (Aliyun, OpenAI, etc.) into our unified schema
- **Temp audio path**: The `done` message includes `temp_audio_path` in the payload for refinement

**Example flow**:
```
Client → Backend:
{ "type": "start", "payload": {} }

Backend → Client:
{ "type": "ready", "payload": {} }

User speaks: "Hello, I want to test..."
Backend → Client:
{ "type": "transcript", "payload": { "text": "你好", "is_final": false } }
{ "type": "transcript", "payload": { "text": "你好想测试", "is_final": false } }
{ "type": "transcript", "payload": { "text": "你好，我想测试中英文的混合输入。", "is_final": true, "end_time": 5600 } }

User pauses (silence):
Backend → Client:
{ "type": "transcript", "payload": { "text": "", "is_final": true, "end_time": 11000 } }

User continues: "Let me try..."
Backend → Client:
{ "type": "transcript", "payload": { "text": "来试试", "is_final": false } }
{ "type": "transcript", "payload": { "text": "来试试看效果", "is_final": true, "end_time": 15200 } }

Client → Backend:
{ "type": "stop", "payload": {} }

Backend → Client:
{ "type": "done", "payload": {} }
```

**Crash Protection & Refinement**:
- Auto-save audio chunks to `APP_DATA_DIR/recordings/temp/[timestamp].pcm`
- File persists if browser/server crashes
- Temp file path sent to client in `done` message for refinement
- Client triggers refinement via `/api/asr/refine` endpoint
- Backend cleans up temp file after successful refinement
- If refinement fails, temp files remain for recovery (manual cleanup >24h)

**Goroutine Architecture**:
```go
// Goroutine 1: Client → Aliyun
for {
  msg := clientConn.ReadMessage()
  if binary {
    audioFile.Write(msg)  // Auto-save
  }
  aliyunConn.WriteMessage(msg)  // Forward
}

// Goroutine 2: Aliyun → Client
for {
  msg := aliyunConn.ReadMessage()
  clientConn.WriteMessage(msg)  // Forward
}

// Main: Wait for either goroutine to finish
wg.Wait()
```

**Error Handling**:
- Graceful WebSocket closes (normal, going away)
- Unexpected close detection
- User-friendly error messages
- Cleanup on error (intervals, connections, files)

### Transcript Processing Pipeline

#### Phase 2 Architecture (To Implement)

**Processing Chain**:
```
ASR Engine (Aliyun)
    ↓
Raw Transcript State
    ↓ (debounced 3s, regex-based)
Cleaned Transcript State
    ↓ (debounced 30s, LLM-based, lazy)
Summary State
```

**Debouncing Strategy**:
```typescript
// Cleaned: Fast, cheap, eager
const cleanupDebounced = useDebouncedCallback((raw: string) => {
  setCleanedTranscript(cleanupText(raw));
}, 3000);

// Summary: Slow, expensive, lazy
const summaryDebounced = useDebouncedCallback(async (raw: string) => {
  if (recordingDuration < 30) return; // Don't summarize short recordings
  if (!summaryTabVisible) return;     // Only if user is viewing tab

  const summary = await generateSummary(raw);
  setSummary(summary);
}, 30000);
```

**Cleanup Function** (Regex-based):
```typescript
function cleanupText(text: string): string {
  let cleaned = text;

  // Remove filler words
  cleaned = cleaned.replace(/\b(um|uh|like|you know|i mean)\b/gi, '');

  // Remove repeated words
  cleaned = cleaned.replace(/\b(\w+)\s+\1\b/gi, '$1');

  // Fix spacing around punctuation
  cleaned = cleaned.replace(/\s+([,.])/g, '$1');
  cleaned = cleaned.replace(/([,.])\s*/g, '$1 ');

  // Capitalize sentences
  cleaned = cleaned.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) =>
    p1 + p2.toUpperCase()
  );

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}
```

**Summary Generation** (LLM-based):
```typescript
async function generateSummary(text: string): Promise<string> {
  const prompt = `Summarize the following transcript into key bullet points.
Focus on main topics, decisions, and action items:

${text}

Summary:`;

  const response = await fetch('/api/ai/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      max_tokens: 300,
      temperature: 0.3
    })
  });

  return response.json();
}
```

### Data Storage (Phase 3)

#### Database Schema

**Table: `recordings`**:
```sql
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,                    -- UUID
  created_at INTEGER NOT NULL,            -- Unix timestamp
  duration INTEGER NOT NULL,              -- Seconds
  file_path TEXT NOT NULL,                -- Path to audio file (SQLAR)
  raw_transcript TEXT NOT NULL,           -- Unmodified ASR output
  cleaned_transcript TEXT,                -- Processed version (nullable)
  summary TEXT,                           -- AI summary (nullable)
  metadata TEXT,                          -- JSON: {speakers: [], tags: []}
  UNIQUE(file_path)
);

CREATE INDEX idx_recordings_created ON recordings(created_at DESC);
```

**Audio Storage**:
- Format: PCM int16, 16kHz mono
- Location: SQLAR archive (existing infrastructure)
- Path pattern: `recordings/[YYYYMMDD]/[timestamp]_[id].pcm`
- Temp files: `APP_DATA_DIR/recordings/temp/[timestamp].pcm`

#### API Endpoints

**Realtime ASR**:
```
GET  /api/asr/realtime         - WebSocket endpoint for real-time ASR
POST /api/asr/refine           - Refine transcript using non-realtime ASR
```

**Refinement Request**:
```json
{
  "audio_path": "/path/to/temp/20060102_150405.pcm"
}
```

**Refinement Response**:
```json
{
  "text": "Refined transcript text with better accuracy"
}
```

**Phase 3 - Recordings Library**:
```
GET  /api/recordings           - List all recordings
GET  /api/recordings/:id       - Get recording details + transcripts
POST /api/recordings           - Create recording from temp file
PUT  /api/recordings/:id       - Update transcript/summary
DELETE /api/recordings/:id     - Delete recording
POST /api/recordings/:id/inbox - Move recording to inbox
```

## Configuration

### Environment Variables

```bash
# No additional env vars needed for basic ASR
# Aliyun credentials stored in user settings via UI

# For AI summary (Phase 2)
OPENAI_API_KEY=sk-...           # OpenAI API key
OPENAI_BASE_URL=...             # Optional: Custom endpoint
OPENAI_MODEL=gpt-4o-mini        # Model for summarization
```

### User Settings

**File**: Database `settings` table

```json
{
  "vendors": {
    "aliyun": {
      "apiKey": "sk-...",
      "region": "beijing" | "singapore"
    }
  },
  "voice": {
    "autoCleanup": true,              // Auto-generate cleaned transcript
    "autoSummary": false,             // Auto-generate summary (expensive)
    "summaryInterval": 30,            // Seconds between summary updates
    "defaultSummaryTemplate": "meeting" | "interview" | "brainstorm"
  }
}
```

## Implementation Phases

### ✅ Phase 1: Visual Recording Experience (Completed)
- Audio level visualization with waveform
- Recording timer with duration tracking
- Enhanced button states with pulse animation
- Backend auto-save for crash protection
- Real-time partial transcript overlay
- Two-pass ASR: Real-time + refinement for better accuracy
- Automatic transcript refinement after recording stops

### 🚧 Phase 2: Three-Tab Review Modal (Next)
1. Create modal component with tab navigation
2. Implement cleaned transcript processing (regex)
3. Implement AI summary generation (LLM)
4. Add real-time updates during recording
5. Wire up save/discard/draft actions

### 📋 Phase 3: Recordings Library
1. Database schema and migrations
2. API endpoints for CRUD operations
3. List view with recordings (sort/filter)
4. Detail view with playback + transcript
5. Export functionality (TXT, JSON, SRT)

### 🎯 Phase 4: Multimodal Context
1. Text notes during recording
2. Image attachments (camera/gallery)
3. Timestamp highlights/bookmarks
4. Context display in review modal

### 🤖 Phase 5: Advanced Features
1. Speaker diarization UI
2. Template-based summaries
3. Mind map visualization
4. Action item extraction
5. Integration with calendar/tasks

## Performance Considerations

### Frontend Optimization
- **Audio Analysis**: ~60fps using `requestAnimationFrame`
- **Canvas Rendering**: Only redraw on `audioLevel` change
- **WebSocket**: Binary protocol for audio (efficient)
- **Cleanup**: Debounced (3s) to avoid excessive processing
- **Summary**: Rate-limited (30s) + lazy (only when viewed)

### Backend Optimization
- **Zero Processing**: Transparent proxy, no transformation
- **Goroutines**: Concurrent bidirectional forwarding
- **Auto-save**: Async write, non-blocking
- **Memory**: Stream audio chunks, no buffering

### Cost Optimization
- **ASR**: Aliyun charges per audio minute (~$0.0008/min)
- **Cleanup**: Free (regex-based, local)
- **Summary**: OpenAI GPT-4o-mini (~$0.0001 per request)
- **Storage**: PCM audio ~1.9MB per minute

## Security Considerations

### Client-Side
- Microphone permission required
- User-triggered recording only (no auto-start)
- Clear visual feedback when recording
- Partial transcripts not submitted accidentally

### Server-Side
- WebSocket CORS: Currently allows all origins (TODO: restrict in production)
- API key from user settings, not hardcoded
- Temp file cleanup on successful completion
- No audio storage without user action

### Privacy
- Audio processed by Aliyun (external service)
- Transcripts stored locally in SQLite
- No telemetry or analytics on transcripts
- User owns all data (GDPR compliant)

## Browser Compatibility

### Required APIs
- `navigator.mediaDevices.getUserMedia()` - Microphone access
- `AudioContext` / `webkitAudioContext` - Audio processing
- `WebSocket` - Real-time communication
- `Canvas` - Waveform visualization

### Supported Browsers
- ✅ Chrome/Edge 88+
- ✅ Firefox 94+
- ✅ Safari 14.1+
- ✅ Mobile Safari (iOS 14.5+)
- ✅ Chrome Android

### Known Limitations
- Safari: Requires HTTPS for `getUserMedia()`
- Firefox: May have higher audio latency
- Mobile: Background recording not supported (OS limitation)

## Troubleshooting

### Common Issues

**"Microphone permission denied"**:
- Check browser settings: Site permissions
- Ensure HTTPS connection (HTTP blocked in most browsers)
- Try incognito mode to rule out extension conflicts

**"No microphone found"**:
- Check system settings: Input device enabled
- Ensure microphone physically connected
- Try different USB port or Bluetooth pairing

**"Microphone already in use"**:
- Close other apps using microphone (Zoom, Discord, etc.)
- Restart browser to release stuck connections

**"Connection error"**:
- Check network connectivity
- Verify Aliyun API key in settings
- Check browser console for WebSocket errors

**Waveform not animating**:
- Audio level might be too low (speak louder)
- Check microphone input level in system settings
- Verify AudioContext is running (not suspended)

**Summary not generating**:
- Recording must be >30 seconds
- Must view Summary tab to trigger generation
- Check OpenAI API key in settings
- Check browser console for API errors

## Future Enhancements

### Short-term (Phase 2-3)
- [ ] Keyboard shortcuts (Space to start/stop, Tab to switch tabs)
- [ ] Waveform scrubbing for playback positioning
- [ ] Export transcripts in multiple formats (SRT, VTT, JSON)
- [ ] Search within transcript
- [ ] Highlight key phrases automatically

### Medium-term (Phase 4-5)
- [ ] Speaker diarization with avatar assignment
- [ ] Multi-language support (112 languages via Aliyun)
- [ ] Custom vocabulary for domain-specific terms
- [ ] Integration with note-taking templates
- [ ] Voice commands during recording (e.g., "mark important")

### Long-term
- [ ] Offline mode with local Whisper model
- [ ] Real-time collaboration (shared recordings)
- [ ] Meeting calendar integration
- [ ] Automatic action item detection
- [ ] Integration with task management systems
- [ ] Voice-activated semantic search

## References

### Inspiration
- [Plaud Note](https://www.plaud.ai/products/plaud-note-ai-voice-recorder) - UX inspiration
- [Typeless](https://typeless.app/) - Cleaned transcript approach
- [Otter.ai](https://otter.ai/) - Real-time collaboration

### Technical Documentation
- [Aliyun Fun-ASR Realtime API](https://help.aliyun.com/document_detail/464499.html)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)
- [MediaStream Recording API](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream_Recording_API)

### Related Code
- `frontend/app/hooks/use-realtime-asr.ts` - ASR hook implementation
- `frontend/app/components/recording-visualizer.tsx` - Waveform component
- `frontend/app/components/omni-input.tsx` - Integration point
- `backend/api/realtime_asr.go` - WebSocket proxy
- `backend/api/routes.go` - API routing
