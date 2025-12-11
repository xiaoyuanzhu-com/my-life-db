import type { TextExtractionResult, ExtractionOptions } from '~/types';

/**
 * Extract comprehensive information from text content
 * This uses AI (OpenAI/Ollama) to analyze text and extract structured data
 */
export async function extractTextInfo(
  content: string,
  options: ExtractionOptions = {}
): Promise<TextExtractionResult> {
  // TODO: Implement actual AI extraction using OpenAI/Ollama
  // For now, return a structured stub with basic rule-based extraction

  const {
    includeEntities = true,
    includeSentiment = true,
    includeActionItems = true,
  } = options;

  // Basic rule-based extraction for now
  const result: TextExtractionResult = {
    title: await generateTitle(content),
    summary: await generateSummary(content),
    tags: await extractTags(content),
    entities: includeEntities ? await extractEntities(content) : {
      people: [],
      places: [],
      organizations: [],
      concepts: [],
      dates: [],
    },
    category: await classifyCategory(content),
    sentiment: includeSentiment ? await analyzeSentiment(content) : 'neutral',
    priority: await detectPriority(content),
    mood: await detectMood(content),
    actionItems: includeActionItems ? await extractActionItems(content) : [],
    confidence: 0.7, // TODO: Calculate actual confidence
  };

  return result;
}

/**
 * Generate a concise title (3-8 words) from content
 */
async function generateTitle(content: string): Promise<string | null> {
  // TODO: Use AI to generate semantic title
  // For now, use first sentence or first N words
  const firstSentence = content.split(/[.!?]/)[0]?.trim();
  if (!firstSentence) return null;

  const words = firstSentence.split(/\s+/).slice(0, 8);
  return words.join(' ') + (firstSentence.split(/\s+/).length > 8 ? '...' : '');
}

/**
 * Generate a 1-2 sentence summary
 */
async function generateSummary(content: string): Promise<string | null> {
  // TODO: Use AI for extractive/abstractive summarization
  if (content.length < 50) return content;

  const sentences = content.split(/[.!?]/).filter((s) => s.trim().length > 0);
  if (sentences.length <= 2) return content;

  // Return first 2 sentences as summary
  return sentences.slice(0, 2).join('. ') + '.';
}

/**
 * Extract 2-5 relevant tags
 */
async function extractTags(content: string): Promise<string[]> {
  // TODO: Use AI/NLP for keyword extraction
  // Basic implementation: extract common words (excluding stop words)
  const stopWords = new Set([
    'the',
    'is',
    'at',
    'which',
    'on',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'with',
    'to',
    'for',
    'of',
    'as',
    'by',
    'that',
    'this',
    'it',
    'from',
    'be',
    'are',
    'was',
    'were',
  ]);

  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  // Count word frequency
  const wordFreq = new Map<string, number>();
  words.forEach((word) => {
    wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
  });

  // Get top 5 most frequent words
  const topWords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  return topWords;
}

/**
 * Extract named entities (people, places, organizations, concepts)
 */
async function extractEntities(content: string): Promise<{
  people: string[];
  places: string[];
  organizations: string[];
  concepts: string[];
  dates: string[];
}> {
  // TODO: Use NER (Named Entity Recognition) model
  // Basic implementation: look for capitalized words and date patterns

  const capitalizedWords = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  const datePatterns = content.match(/\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\w+ \d{1,2},? \d{4})\b/g) || [];

  return {
    people: [], // TODO: Detect person names
    places: [], // TODO: Detect place names
    organizations: [], // TODO: Detect organization names
    concepts: Array.from(new Set(capitalizedWords)).slice(0, 5), // Use capitalized words as concepts
    dates: Array.from(new Set(datePatterns)),
  };
}

/**
 * Classify content into categories
 */
async function classifyCategory(
  content: string
): Promise<'journal' | 'idea' | 'observation' | 'question' | 'meeting' | 'todo' | 'note' | 'other'> {
  // TODO: Use text classification AI model
  // Rule-based classification for now

  const lowerContent = content.toLowerCase();

  // Question indicators
  if (lowerContent.includes('?') || lowerContent.startsWith('how ') || lowerContent.startsWith('why ')) {
    return 'question';
  }

  // Todo indicators
  if (
    lowerContent.includes('todo') ||
    lowerContent.includes('need to') ||
    lowerContent.includes('must ') ||
    lowerContent.includes('should ')
  ) {
    return 'todo';
  }

  // Meeting indicators
  if (
    lowerContent.includes('meeting') ||
    lowerContent.includes('discussed') ||
    lowerContent.includes('agenda')
  ) {
    return 'meeting';
  }

  // Idea indicators
  if (
    lowerContent.includes('idea') ||
    lowerContent.includes('what if') ||
    lowerContent.includes('concept')
  ) {
    return 'idea';
  }

  // Journal indicators (personal, emotional language)
  if (
    lowerContent.includes('i feel') ||
    lowerContent.includes('today i') ||
    lowerContent.includes('grateful')
  ) {
    return 'journal';
  }

  return 'note';
}

/**
 * Analyze sentiment (positive, negative, neutral, mixed)
 */
async function analyzeSentiment(content: string): Promise<'positive' | 'negative' | 'neutral' | 'mixed'> {
  // TODO: Use sentiment analysis AI model
  // Basic lexicon-based approach

  const positiveWords = [
    'good',
    'great',
    'excellent',
    'happy',
    'love',
    'wonderful',
    'amazing',
    'grateful',
    'success',
    'excited',
  ];
  const negativeWords = [
    'bad',
    'terrible',
    'sad',
    'angry',
    'hate',
    'awful',
    'difficult',
    'problem',
    'stress',
    'anxious',
  ];

  const lowerContent = content.toLowerCase();
  const positiveCount = positiveWords.filter((w) => lowerContent.includes(w)).length;
  const negativeCount = negativeWords.filter((w) => lowerContent.includes(w)).length;

  if (positiveCount > 0 && negativeCount > 0) return 'mixed';
  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'neutral';
}

/**
 * Detect priority/urgency
 */
async function detectPriority(
  content: string
): Promise<'low' | 'medium' | 'high' | 'urgent'> {
  // TODO: Use AI to detect priority indicators
  const lowerContent = content.toLowerCase();

  if (lowerContent.includes('urgent') || lowerContent.includes('asap') || lowerContent.includes('critical')) {
    return 'urgent';
  }

  if (lowerContent.includes('important') || lowerContent.includes('priority')) {
    return 'high';
  }

  if (lowerContent.includes('soon') || lowerContent.includes('need to')) {
    return 'medium';
  }

  return 'low';
}

/**
 * Detect mood (for journal entries)
 */
async function detectMood(content: string): Promise<string | undefined> {
  // TODO: Use emotion detection AI
  const lowerContent = content.toLowerCase();

  const moods = [
    { mood: 'grateful', keywords: ['grateful', 'thankful', 'blessed'] },
    { mood: 'anxious', keywords: ['anxious', 'nervous', 'worried', 'stress'] },
    { mood: 'excited', keywords: ['excited', 'thrilled', 'pumped'] },
    { mood: 'contemplative', keywords: ['thinking', 'wondering', 'reflecting'] },
    { mood: 'happy', keywords: ['happy', 'joy', 'delighted'] },
    { mood: 'sad', keywords: ['sad', 'down', 'upset'] },
  ];

  for (const { mood, keywords } of moods) {
    if (keywords.some((kw) => lowerContent.includes(kw))) {
      return mood;
    }
  }

  return undefined;
}

/**
 * Extract action items with assignees and due dates
 */
async function extractActionItems(
  content: string
): Promise<Array<{ task: string; assignee?: string; dueDate?: string }>> {
  // TODO: Use AI to extract structured action items
  const actionItems: Array<{ task: string; assignee?: string; dueDate?: string }> = [];

  // Look for todo-like patterns
  const todoPatterns = [
    /(?:todo|need to|must|should|task):\s*(.+?)(?:\n|$)/gi,
    /\[\s*\]\s*(.+?)(?:\n|$)/g, // Markdown checkbox
    /^[-*]\s*(.+?)(?:\n|$)/gm, // Bullet points
  ];

  for (const pattern of todoPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        actionItems.push({
          task: match[1].trim(),
        });
      }
    }
  }

  return actionItems.slice(0, 10); // Limit to 10 action items
}
