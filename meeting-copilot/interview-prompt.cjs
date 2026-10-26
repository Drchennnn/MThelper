'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createInterviewPrompt({ file, original }) {
  function validate(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 64000) throw new Error('面试 Prompt 不能为空，且不能超过 64000 字符');
    return value;
  }
  function getPublic() {
    try { return { interview: fs.existsSync(file) ? validate(fs.readFileSync(file, 'utf8')) : original, interviewDefault: original, warning: '' }; }
    catch (error) { return { interview: original, interviewDefault: original, warning: error.message }; }
  }
  function read() { return getPublic().interview; }
  function save(value) {
    validate(value);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', value, 'utf8');
    fs.renameSync(file + '.tmp', file);
  }
  return { read, getPublic, validate, save };
}
module.exports = { createInterviewPrompt };
