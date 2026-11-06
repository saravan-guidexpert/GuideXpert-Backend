'use strict';

const { generateAnswer } = require('../services/answerStudio/generationService');
const { sendGenerationError } = require('../services/answerStudio/generationValidation');

async function generate(req, res) {
  try {
    const data = await generateAnswer(req.body, req.admin);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return sendGenerationError(res, error);
  }
}

module.exports = {
  generate,
};
