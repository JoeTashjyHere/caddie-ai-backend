"use strict";

const fetch = require("node-fetch");
const { getModelForTask } = require("./modelRouter");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Generate a chat completion from OpenAI.
 *
 * @param {Object} opts
 * @param {string}  opts.taskType       - "full_shot" | "putting" | "quick_shot" | "default"
 * @param {string}  opts.systemPrompt   - System message content
 * @param {string}  opts.userPrompt     - User message content (text portion)
 * @param {string}  [opts.imageDataUrl] - data:image/… URL for vision requests
 * @param {string}  [opts.overrideModel]- Bypass modelRouter for testing
 * @param {string}  [opts.correlationId]
 * @returns {Promise<{content: string, model: string, durationMs: number}>}
 */
async function generateCaddieResponse({
  taskType = "default",
  systemPrompt,
  userPrompt,
  imageDataUrl,
  overrideModel,
  correlationId,
}) {
  if (!OPENAI_API_KEY) {
    throw Object.assign(new Error("Missing OPENAI_API_KEY"), { statusCode: 500 });
  }

  const model = overrideModel || getModelForTask(taskType);
  console.log(
    `[ModelRouter] task=${taskType} model=${model}${overrideModel ? " (override)" : ""} cid=${correlationId || "-"}`
  );

  const userContent = imageDataUrl
    ? [
        { type: "text", text: userPrompt || "" },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : userPrompt || "";

  const messages = [
    { role: "system", content: systemPrompt || "You are a helpful assistant." },
    { role: "user", content: userContent },
  ];

  const start = Date.now();

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages }),
  });

  const data = await response.json();
  const durationMs = Date.now() - start;

  if (data.error) {
    const msg =
      data.error.message || data.error.type || "provider_error";
    const err = new Error(msg);
    err.statusCode = 500;
    err.openaiDetail = msg;
    throw err;
  }

  const content = data?.choices?.[0]?.message?.content ?? null;
  if (content == null) {
    const err = new Error("Unexpected OpenAI response shape");
    err.statusCode = 500;
    err.openaiDetail = "missing_content";
    throw err;
  }

  return { content, model, durationMs };
}

module.exports = { generateCaddieResponse };
