"use strict";

const VISION_FAST = "gpt-5-vision-fast";
const TEXT_FAST = "gpt-5-fast";

/**
 * Return the appropriate OpenAI model for a given task type.
 * Optimized for low-latency, real-time golf recommendations.
 *
 * @param {"full_shot"|"putting"|"quick_shot"|string} taskType
 * @returns {string} OpenAI model identifier
 */
function getModelForTask(taskType) {
  switch (taskType) {
    case "full_shot":
      return VISION_FAST;
    case "putting":
      return VISION_FAST;
    case "quick_shot":
      return TEXT_FAST;
    default:
      return TEXT_FAST;
  }
}

module.exports = { getModelForTask, VISION_FAST, TEXT_FAST };
