const OpenCC = require('opencc-js');

const MAX_COMMAND_LENGTH = 1024;
const MAX_QUERY_LENGTH = 512;
const unsafeControlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const lineBreakPattern = /[\r\n\u2028\u2029]/;
const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' });

class SongTextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SongTextError';
    this.code = code;
  }
}

function codePointLength(value) {
  return Array.from(value).length;
}

function assertSafeText(value, { maxLength = MAX_QUERY_LENGTH, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new SongTextError('invalid_text_type', '文本必须是字符串');
  }
  if (codePointLength(value) > maxLength) {
    throw new SongTextError('text_too_long', `文本长度不能超过 ${maxLength} 个字符`);
  }
  if (lineBreakPattern.test(value)) {
    throw new SongTextError('multiline_text_not_allowed', '文本必须保持单行');
  }
  if (unsafeControlPattern.test(value)) {
    throw new SongTextError('unsafe_control_character', '文本包含不安全的控制字符');
  }
  if (!allowEmpty && !value.trim()) {
    throw new SongTextError('empty_text', '文本不能为空');
  }
}

function normalizeSongText(value, options = {}) {
  assertSafeText(value, options);
  const rawText = value;
  const nfkcText = rawText.normalize('NFKC');
  const whitespaceNormalized = nfkcText.trim().replace(/[ \t\u3000]+/g, ' ');
  if (!options.allowEmpty && !whitespaceNormalized) {
    throw new SongTextError('empty_text', '文本不能为空');
  }
  const scriptKey = toSimplified(whitespaceNormalized);
  const punctuationKey = scriptKey
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
  return Object.freeze({
    raw_text: rawText,
    nfkc_text: nfkcText,
    whitespace_normalized: whitespaceNormalized,
    script_key: scriptKey,
    loose_candidate_key: scriptKey.toLocaleLowerCase('en-US'),
    punctuation_key: punctuationKey
  });
}

function parseSongRequestCommand(value) {
  try {
    assertSafeText(value, { maxLength: MAX_COMMAND_LENGTH });
    const rawText = value;
    const outerTrimmed = rawText.trim();
    const normalizedCommand = outerTrimmed.normalize('NFKC');
    const normalizedMatch = /^(点歌|點歌)[ \t]+(.+?)$/.exec(normalizedCommand);
    const originalMatch = /^(点歌|點歌)[ \t\u3000]+(.+?)$/.exec(outerTrimmed);
    if (!normalizedMatch || !originalMatch) {
      return Object.freeze({ matched: false, reason: 'not_song_request_command', raw_text: rawText });
    }

    const requestedTitle = originalMatch[2].trim();
    const titleNormalization = normalizeSongText(requestedTitle, { maxLength: MAX_QUERY_LENGTH });
    return Object.freeze({
      matched: true,
      raw_text: rawText,
      prefix: originalMatch[1],
      requested_title: requestedTitle,
      normalization: titleNormalization
    });
  } catch (error) {
    if (error instanceof SongTextError) {
      return Object.freeze({ matched: false, reason: error.code, raw_text: value });
    }
    throw error;
  }
}

module.exports = {
  MAX_COMMAND_LENGTH,
  MAX_QUERY_LENGTH,
  SongTextError,
  assertSafeText,
  normalizeSongText,
  parseSongRequestCommand
};
