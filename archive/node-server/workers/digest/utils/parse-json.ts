/**
 * Robust JSON parser for LLM responses.
 *
 * Handles various formats:
 * - Raw JSON: {"tags": [...]}
 * - Code blocks: ```json\n{...}\n``` or ```\n{...}\n```
 * - Surrounding text: "Here are the tags: {...}"
 * - Arrays: [...]
 */
export function parseJsonFromLlmResponse(content: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch {
    // Continue to extraction strategies
  }

  // Try to find JSON in markdown code blocks (```json or ```)
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Continue to next strategy
    }
  }

  // Try to find JSON object by looking for outermost { ... }
  const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    try {
      return JSON.parse(jsonObjectMatch[0]);
    } catch {
      // Continue to next strategy
    }
  }

  // Try to find JSON array by looking for outermost [ ... ]
  const jsonArrayMatch = content.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    try {
      return JSON.parse(jsonArrayMatch[0]);
    } catch {
      // All strategies failed
    }
  }

  throw new Error('Unable to parse JSON from LLM response');
}
