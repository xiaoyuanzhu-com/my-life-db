# Aliyun Fun-ASR Realtime Configuration Guide

This document describes all available configuration parameters for Aliyun Fun-ASR Realtime API.

## Current Implementation

Our implementation in [backend/api/realtime_asr.go](../backend/api/realtime_asr.go) uses the DashScope WebSocket API directly with parameters verified from both the official documentation and the online demo:

```go
parameters := map[string]interface{}{
    "semantic_punctuation_enabled": false,  // VAD-based segmentation for lower latency
    "max_sentence_silence": 1300,           // Silence threshold in milliseconds
    "language_hints": []string{"zh"},       // Optional language hints
}
```

**Connection:** `wss://dashscope.aliyuncs.com/api-ws/v1/inference` (or `wss://dashscope-intl.aliyuncs.com` for Singapore region)

## All Available Parameters

### Required Input Parameters

| Parameter | Type | Description | Values |
|-----------|------|-------------|--------|
| `format` | string | Audio format | `"pcm"`, `"wav"`, `"mp3"`, `"opus"`, `"speex"`, `"aac"`, `"amr"` |
| `sample_rate` | integer | Audio sampling rate (Hz) | `16000` (recommended for Fun-ASR) |

### Optional Parameters

#### 1. Punctuation & Segmentation

**`semantic_punctuation_enabled`** (boolean, default: `false`)
- `true`: Uses semantic sentence segmentation with **higher accuracy**
  - Best for: Meetings, recordings, transcription quality over latency
  - Adds proper punctuation based on semantic understanding
- `false`: Uses VAD (Voice Activity Detection) based segmentation
  - Best for: Real-time interactive scenarios where low latency is critical

**Current setting**: `true` (optimized for quality)

#### 2. VAD Segmentation Control (only when `semantic_punctuation_enabled=false`)

**`max_sentence_silence`** (integer, default: `1300`, range: `200-6000`)
- Static silence threshold in milliseconds for sentence completion
- Lower values = more frequent sentence breaks (faster response, shorter sentences)
- Higher values = longer sentences (may delay output)

**`multi_threshold_mode_enabled`** (boolean, default: `false`)
- `true`: Prevents VAD segmentation from becoming excessively long
- Adds additional checks to segment long utterances

**Current setting**: Not used (we use `semantic_punctuation_enabled: false` for VAD-based segmentation)

#### 3. Language Detection

**`language_hints`** (array[string], optional)
- Provides language hints to improve recognition accuracy
- Supported languages:
  - `"zh"` - Chinese (Mandarin)
  - `"en"` - English
  - `"ja"` - Japanese
- If unspecified, model automatically detects language
- Can specify multiple: `["zh", "en"]` for mixed language scenarios

**Current setting**: Dynamically set based on client request (defaults to auto-detect if not specified)

#### 4. Custom Vocabulary

**`vocabulary_id`** (string, optional)
- Custom hotword ID for domain-specific terminology
- Improves recognition of specialized terms (medical, legal, technical, etc.)
- Must be pre-configured in Aliyun console

**Current setting**: Not implemented (can be added if needed)

## Recommended Settings by Use Case

### 1. Balanced Quality and Latency (Current Default)
```json
{
  "semantic_punctuation_enabled": false,
  "max_sentence_silence": 1300,
  "language_hints": ["zh"]
}
```
**Best for**: General real-time transcription with good balance of quality and latency

### 2. High-Quality Transcription
```json
{
  "semantic_punctuation_enabled": true,
  "language_hints": ["zh"]
}
```
**Best for**: Meetings, interviews, lectures where accuracy is more important than latency

### 3. Lower Latency (Faster Response)
```json
{
  "semantic_punctuation_enabled": false,
  "max_sentence_silence": 800,
  "language_hints": ["zh"]
}
```
**Best for**: Interactive applications, live subtitles where immediate feedback is needed

### 4. Mixed Language Scenarios
```json
{
  "semantic_punctuation_enabled": false,
  "max_sentence_silence": 1300,
  "language_hints": ["zh", "en"]
}
```
**Best for**: Bilingual conversations, code-switching scenarios

## Client Configuration

Clients can optionally specify configuration in the start message:

```json
{
  "type": "start",
  "metadata": {
    "sample_rate": 16000,
    "format": "pcm",
    "model": "fun-asr-realtime",
    "language": "zh"
  }
}
```

## Comparison with Online Demo

Based on HAR file analysis:
- ✅ `semantic_punctuation_enabled: false` - matches online demo
- ✅ `max_sentence_silence: 1300` - matches online demo
- ⚠️ The online demo uses a wrapper API (`wss://efm-ws.aliyuncs.com`), while we connect directly to DashScope (`wss://dashscope.aliyuncs.com`)
- Both APIs support the same parameters from the official DashScope documentation

## Environment Variables

```bash
# Set the model name
ALIYUN_ASR_REALTIME_MODEL=fun-asr-realtime

# Aliyun API credentials
DASHSCOPE_API_KEY=your_api_key_here
ALIYUN_REGION=cn-beijing  # or "singapore" for intl
```

## Audio Quality Tips

For best transcription results:

1. **Sample Rate**: Use 16kHz (required by Fun-ASR)
2. **Format**: PCM 16-bit is most reliable
3. **Noise**: Minimize background noise (use browser noise suppression if available)
4. **Microphone**: Use good quality microphone with proper positioning
5. **Network**: Stable connection to reduce packet loss
6. **Audio Processing**: Enable echo cancellation and noise suppression in browser audio constraints

## Future Improvements

Potential enhancements:
1. **Custom vocabulary support**: For domain-specific terminology
2. **Dynamic parameter switching**: Allow clients to change parameters mid-session
3. **Audio preprocessing**: Noise reduction before sending to Aliyun
4. **Quality metrics**: Track and log recognition confidence scores
