package digest

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strings"
)

// ChunkResult represents a single chunk of text
type ChunkResult struct {
	ChunkIndex    int
	ChunkCount    int
	ChunkText     string
	SpanStart     int
	SpanEnd       int
	OverlapTokens int
	WordCount     int
	TokenCount    int
}

// ChunkText splits text into overlapping chunks for vector embeddings
//
// Strategy:
// - Target: 800-1000 tokens per chunk (~3200-4000 chars at 4 chars/token)
// - Overlap: 15% (~120-150 tokens) to preserve context at boundaries
// - Boundaries: Prefer markdown headings, then paragraphs, then sentences
//
// Parameters:
//   - text: Text to chunk
//   - targetTokens: Target tokens per chunk (default: 900)
//   - overlapPercent: Overlap as fraction of target (default: 0.15 for 15%)
//
// Returns: Array of chunks with metadata
func ChunkText(text string, targetTokens int, overlapPercent float64) []ChunkResult {
	if targetTokens <= 0 {
		targetTokens = 900
	}
	if overlapPercent <= 0 {
		overlapPercent = 0.15
	}

	overlapTokens := int(float64(targetTokens) * overlapPercent)

	// Estimate: 4 chars per token
	charsPerToken := 4
	targetChars := targetTokens * charsPerToken
	overlapChars := overlapTokens * charsPerToken

	// If text is short enough for single chunk, return as-is
	if len(text) <= targetChars {
		tokenCount := estimateTokens(text)
		return []ChunkResult{
			{
				ChunkIndex:    0,
				ChunkCount:    1,
				ChunkText:     text,
				SpanStart:     0,
				SpanEnd:       len(text),
				OverlapTokens: 0,
				WordCount:     countWords(text),
				TokenCount:    tokenCount,
			},
		}
	}

	// Split into chunks with overlap
	var chunks []ChunkResult
	currentPosition := 0
	chunkIndex := 0

	for currentPosition < len(text) {
		isLastChunk := currentPosition+targetChars >= len(text)

		var chunkEnd int
		if isLastChunk {
			chunkEnd = len(text)
		} else {
			chunkEnd = findBoundary(text, currentPosition+targetChars)
		}

		chunkText := text[currentPosition:chunkEnd]
		tokenCount := estimateTokens(chunkText)

		chunks = append(chunks, ChunkResult{
			ChunkIndex:    chunkIndex,
			ChunkCount:    0, // Will be set after all chunks are created
			ChunkText:     chunkText,
			SpanStart:     currentPosition,
			SpanEnd:       chunkEnd,
			OverlapTokens: 0, // Will be set below
			WordCount:     countWords(chunkText),
			TokenCount:    tokenCount,
		})

		if isLastChunk {
			break
		}

		// Move position forward (accounting for overlap with previous chunk)
		currentPosition = chunkEnd - overlapChars
		if currentPosition <= chunks[chunkIndex].SpanStart {
			// Safety: Ensure we make progress
			currentPosition = chunks[chunkIndex].SpanStart + 1
		}
		chunkIndex++
	}

	// Set chunk count and overlap tokens on all chunks
	chunkCount := len(chunks)
	for i := range chunks {
		chunks[i].ChunkCount = chunkCount
		if i > 0 {
			chunks[i].OverlapTokens = overlapTokens
		}
	}

	return chunks
}

// findBoundary finds the optimal position to split text
// Priority: markdown heading > double newline (paragraph) > sentence > whitespace
func findBoundary(text string, targetPosition int) int {
	searchWindow := 800 // Look ±800 chars around target
	start := maxInt(0, targetPosition-searchWindow)
	end := minInt(len(text), targetPosition+searchWindow)
	searchText := text[start:end]

	// 1. Try to find markdown heading
	headingPattern := regexp.MustCompile(`\n#{1,6}\s+`)
	headingMatches := headingPattern.FindAllStringIndex(searchText, -1)
	if len(headingMatches) > 0 {
		// Find last heading in search window
		lastHeading := headingMatches[len(headingMatches)-1]
		if lastHeading[0] > searchWindow/2 {
			return start + lastHeading[0] + 1 // +1 to skip newline
		}
	}

	// 2. Try to find paragraph break (double newline)
	paragraphPattern := regexp.MustCompile(`\n\n+`)
	paragraphMatches := paragraphPattern.FindAllStringIndex(searchText, -1)
	if len(paragraphMatches) > 0 {
		lastParagraph := paragraphMatches[len(paragraphMatches)-1]
		if lastParagraph[0] > searchWindow/2 {
			return start + lastParagraph[0] + 2 // +2 to skip both newlines
		}
	}

	// 3. Try to find sentence ending
	sentencePattern := regexp.MustCompile(`[.!?]\s+`)
	sentenceMatches := sentencePattern.FindAllStringIndex(searchText, -1)
	if len(sentenceMatches) > 0 {
		lastSentence := sentenceMatches[len(sentenceMatches)-1]
		if lastSentence[0] > searchWindow/2 {
			return start + lastSentence[0] + 2 // +2 for punctuation + space
		}
	}

	// 4. Fall back to any whitespace
	whitespacePattern := regexp.MustCompile(`\s+`)
	whitespaceMatches := whitespacePattern.FindAllStringIndex(searchText, -1)
	if len(whitespaceMatches) > 0 {
		lastWhitespace := whitespaceMatches[len(whitespaceMatches)-1]
		if lastWhitespace[0] > searchWindow/2 {
			return start + lastWhitespace[0] + 1
		}
	}

	// 5. No good boundary found, just split at target
	return targetPosition
}

// countWords counts words in text (simple whitespace-based count)
func countWords(text string) int {
	words := strings.Fields(text)
	return len(words)
}

// estimateTokens estimates token count (rough approximation: 4 chars per token)
// This is a simplification - actual tokenization depends on the model
func estimateTokens(text string) int {
	return (len(text) + 3) / 4 // Round up
}

// hashString generates SHA256 hash of a string
func hashString(text string) string {
	hash := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%x", hash)
}

// Helper functions
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
