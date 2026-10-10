package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Helpers for log output. Logs must not contain the user's utterance (transcripts, text to
// translate, translations), OpenAI response bodies, or arbitrary strings sent by the client.

// logLangIDs lists the language IDs the frontend can send (frontend/src/languages.ts),
// plus "unknown", which the translate prompt asks OpenAI to return when detection fails.
var logLangIDs = map[string]struct{}{
	"ja": {}, "en": {}, "zh-CN": {}, "zh-TW": {}, "ko": {}, "th": {}, "vi": {},
	"unknown": {},
}

// logLang returns id when it is a known language ID, otherwise "other".
func logLang(id string) string {
	if _, ok := logLangIDs[id]; ok {
		return id
	}
	return "other"
}

// logSpeaker returns the speaker language when it matches one of the selected languages,
// otherwise "invalid".
func logSpeaker(speaker string, myLang, theirLang LangInfo) string {
	if speaker != "" && (speaker == myLang.ID || speaker == theirLang.ID) {
		return logLang(speaker)
	}
	return "invalid"
}

// detectedLangRe matches the language returned by the transcription API
// (a lowercase name such as "japanese" or an ISO 639-1 code such as "ja").
var detectedLangRe = regexp.MustCompile(`^[a-z]{2,20}$`)

// logDetectedLang returns the detected language when it has the expected form, otherwise "invalid".
func logDetectedLang(lang string) string {
	if detectedLangRe.MatchString(lang) {
		return lang
	}
	return "invalid"
}

// logFileExt returns the audio file extension when it is one the frontend sends, otherwise "other".
// The file name itself is never logged.
func logFileExt(name string) string {
	switch ext := strings.ToLower(filepath.Ext(name)); ext {
	case ".webm", ".mp4", ".ogg":
		return ext
	}
	return "other"
}

// logRunes returns the number of characters (runes) in s, logged instead of the text itself.
func logRunes(s string) int {
	return utf8.RuneCountInString(s)
}

// jsonErrSummary describes a JSON decoding error without the text of the input.
// (*json.SyntaxError).Error() quotes the offending character, so only the offset is used.
func jsonErrSummary(err error) string {
	switch e := err.(type) {
	case *json.SyntaxError:
		return fmt.Sprintf("json syntax error at offset %d", e.Offset)
	case *json.UnmarshalTypeError:
		return fmt.Sprintf("json type error at offset %d (field %q expects %s)", e.Offset, e.Field, e.Type)
	default:
		return fmt.Sprintf("json decode error (%T)", err)
	}
}
