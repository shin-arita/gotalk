package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
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

// whisperLanguageNames is the set of language names in whisperLanguages.
var whisperLanguageNames = func() map[string]struct{} {
	m := make(map[string]struct{}, len(whisperLanguages))
	for _, name := range whisperLanguages {
		m[name] = struct{}{}
	}
	return m
}()

// logDetectedLang returns the language detected by the transcription API when it is a language
// name or code Whisper supports (for example, "japanese" or "ja"), otherwise "other".
func logDetectedLang(lang string) string {
	if _, ok := whisperLanguages[lang]; ok {
		return lang
	}
	if _, ok := whisperLanguageNames[lang]; ok {
		return lang
	}
	return "other"
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
	// An empty body (EOF) and a truncated body (unexpected EOF) are reported as fixed strings.
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return "json decode error: unexpected EOF"
	}
	if errors.Is(err, io.EOF) {
		return "json decode error: EOF"
	}
	switch e := err.(type) {
	case *json.SyntaxError:
		return fmt.Sprintf("json syntax error at offset %d", e.Offset)
	case *json.UnmarshalTypeError:
		return fmt.Sprintf("json type error at offset %d (field %q expects %s)", e.Offset, e.Field, e.Type)
	default:
		return fmt.Sprintf("json decode error (%T)", err)
	}
}

// maxErrorBodyBytes is the most bytes read from an OpenAI error response body.
// OpenAI error bodies are a small JSON object ({"error":{"message","type","param","code"}}),
// a few hundred bytes in practice, so 64 KiB leaves ample room while bounding memory use.
const maxErrorBodyBytes = 64 << 10

// readOpenAIErrorDetail reads at most maxErrorBodyBytes+1 bytes of an OpenAI error response body
// and summarizes it with openAIErrorDetail.
//   - When reading fails part way, "body read error after N bytes (<cause>)" is reported (see
//     readErrorCause). If the bytes read so far already form a complete OpenAI error object,
//     its type and code are prefixed as in openAIErrorDetail, for example
//     "type=server_error code=none, body read error after 64 bytes (unexpected EOF)".
//   - When the body is larger than maxErrorBodyBytes, it is not decoded and only
//     "body over N bytes (truncated)" is reported.
//   - Otherwise "body N bytes" is the size of the whole body.
func readOpenAIErrorDetail(r io.Reader) string {
	detail, _, _ := readOpenAIError(r)
	return detail
}

// readOpenAIError is readOpenAIErrorDetail that also returns the error type and code
// (filtered by openAIErrorToken; "" when the body is not an OpenAI error object or is over
// maxErrorBodyBytes), so that the caller can tell, for example, a spend limit from a rate limit.
func readOpenAIError(r io.Reader) (detail, errType, errCode string) {
	body, err := io.ReadAll(io.LimitReader(r, maxErrorBodyBytes+1))
	if err != nil {
		readErr := fmt.Sprintf("body read error after %d bytes (%s)", len(body), readErrorCause(err))
		if errType, errCode, ok := openAIErrorFields(body); ok {
			return fmt.Sprintf("type=%s code=%s, %s", errType, errCode, readErr), errType, errCode
		}
		return readErr, "", ""
	}
	if len(body) > maxErrorBodyBytes {
		return fmt.Sprintf("body over %d bytes (truncated)", maxErrorBodyBytes), "", ""
	}
	errType, errCode, _ = openAIErrorFields(body)
	return openAIErrorDetail(body), errType, errCode
}

// readErrorCause describes an error from reading a response body as a fixed string:
// "unexpected EOF" when the connection closed before the body was complete, "timeout" for
// a timeout (a net.Error whose Timeout() is true, including the http.Client timeout),
// and the error type otherwise. Error messages are never included.
func readErrorCause(err error) string {
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return "unexpected EOF"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	return fmt.Sprintf("%T", err)
}

// openAIErrorTokenRe matches the error type and code values that are safe to log
// (for example, "insufficient_quota" or "invalid_request_error").
var openAIErrorTokenRe = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

// openAIErrorDetail summarizes an OpenAI error response body for logs, for example
// "type=insufficient_quota code=insufficient_quota, body 312 bytes".
// Only error.type and error.code are included, and only when they match openAIErrorTokenRe;
// error.message is never included because it can quote the request input.
// A missing or null value is reported as "none", any other value as "invalid".
// When the body is not an OpenAI error object, only the body size is reported.
func openAIErrorDetail(body []byte) string {
	if typeCode, ok := openAIErrorTypeCode(body); ok {
		return fmt.Sprintf("%s, body %d bytes", typeCode, len(body))
	}
	return fmt.Sprintf("body %d bytes", len(body))
}

// openAIErrorTypeCode decodes body as an OpenAI error object and returns "type=<type> code=<code>"
// (each value filtered by openAIErrorToken). ok is false when body is not a complete JSON object
// with an "error" object.
func openAIErrorTypeCode(body []byte) (typeCode string, ok bool) {
	errType, errCode, ok := openAIErrorFields(body)
	if !ok {
		return "", false
	}
	return fmt.Sprintf("type=%s code=%s", errType, errCode), true
}

// openAIErrorFields decodes body as an OpenAI error object and returns its type and code, each
// filtered by openAIErrorToken. ok is false when body is not a complete JSON object with an
// "error" object.
func openAIErrorFields(body []byte) (errType, errCode string, ok bool) {
	var resp struct {
		Error *struct {
			Type json.RawMessage `json:"type"`
			Code json.RawMessage `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.Error == nil {
		return "", "", false
	}
	return openAIErrorToken(resp.Error.Type), openAIErrorToken(resp.Error.Code), true
}

// openAIErrorToken returns a raw JSON value when it is a string matching openAIErrorTokenRe,
// "none" when it is missing or null, and "invalid" otherwise.
func openAIErrorToken(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "none"
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || !openAIErrorTokenRe.MatchString(s) {
		return "invalid"
	}
	return s
}
