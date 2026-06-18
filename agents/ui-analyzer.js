/**
 * ui-analyzer.js
 *
 * Agent Step 2 — Visual UI Analysis
 *
 * Receives the base64-encoded screenshots from ui-tester.js and sends
 * them to Claude Vision (claude-sonnet-4-6) for structured UI analysis.
 *
 * Claude checks layout quality, responsiveness, visual issues, and
 * returns a scored JSON report with per-viewport notes and a list of
 * actionable issues sorted by severity.
 */

const SYSTEM_PROMPT = `You are a senior UI/UX engineer reviewing screenshots of a React web application.

You will receive screenshots at three viewports:
  - DESKTOP  (1280px wide)
  - TABLET   (768px wide)
  - MOBILE   (375px wide)

Analyze all three thoroughly and return ONLY a valid JSON object with this exact structure — no markdown, no explanation, just the JSON:

{
  "renders": true,
  "score": 7,
  "summary": "2-3 sentence overall assessment of the UI quality and any critical problems.",
  "issues": [
    {
      "severity": "high",
      "viewport": "mobile",
      "description": "What is wrong and where.",
      "suggestion": "How to fix it."
    }
  ],
  "per_viewport": {
    "desktop": { "rating": 8, "notes": "What works well and what doesn't at this size." },
    "tablet":  { "rating": 7, "notes": "..." },
    "mobile":  { "rating": 6, "notes": "..." }
  }
}

Fields:
  - renders       : false if the page is blank, shows an error, or has no visible content
  - score         : 1–10 overall quality (10 = production-ready)
  - issues        : only real problems, sorted high → medium → low; empty array if none
  - severity      : "high" (broken/unusable), "medium" (noticeable but workable), "low" (polish)
  - viewport      : "desktop", "tablet", "mobile", or "all" if it affects every size

Check for:
  - Blank or broken render (white screen, JS error text, missing content)
  - Horizontal overflow / elements clipped outside viewport
  - Text readability — font size too small, low contrast, text overlapping
  - Inconsistent spacing or misaligned elements
  - Buttons, inputs, and interactive elements clearly visible and sized correctly
  - Mobile: tap targets at least 44px, no tiny text, no desktop-only layouts squeezed in
  - Placeholder or lorem ipsum content visible that shouldn't be
  - Missing images or broken icon references`;

/**
 * Sends screenshots to Claude Vision and returns a structured UI analysis.
 *
 * @param {Array}  screenshots  - Output from captureScreenshots() — each item has { viewport, width, height, base64 }
 * @param {object} client       - Configured Anthropic SDK client passed in from server.js
 * @returns {Promise<{ analysis: object, usage: object }>}
 */
export async function analyzeUI(screenshots, client) {
  // Build the message content: label + image for each viewport
  const content = [];

  for (const s of screenshots) {
    content.push({
      type: 'text',
      text: `=== ${s.viewport.toUpperCase()} (${s.width}×${s.height}) ===`,
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: s.base64 },
    });
  }

  content.push({
    type: 'text',
    text: 'Analyze these screenshots and return the JSON report.',
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';

  // Extract the JSON object from the response (handles any stray text around it)
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return a valid JSON analysis. Raw response: ' + text.slice(0, 300));

  return {
    analysis: JSON.parse(match[0]),
    usage: response.usage,
  };
}
