package main

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// supportedLanguages lists the languages the frontend offers (frontend/src/languages.ts), with the
// label used in the OpenAI prompts. TestSupportedLanguagesMatchFrontend checks that both lists match.
//
// The client sends {"id","label"} for each language, but only the id is used: it must be one of
// these, and the label in the prompts always comes from this list. Client-supplied labels never
// reach OpenAI, so they cannot make the prompts longer or inject text into them.
var supportedLanguages = []LangInfo{
	{ID: "ja", Label: "Japanese"},
	{ID: "en", Label: "English"},
	{ID: "zh-CN", Label: "Chinese Simplified"},
	{ID: "zh-TW", Label: "Chinese Traditional"},
	{ID: "ko", Label: "Korean"},
	{ID: "th", Label: "Thai"},
	{ID: "vi", Label: "Tiếng Việt"},
}

// supportedLanguageByID indexes supportedLanguages by id.
var supportedLanguageByID = func() map[string]LangInfo {
	m := make(map[string]LangInfo, len(supportedLanguages))
	for _, l := range supportedLanguages {
		m[l.ID] = l
	}
	return m
}()

// lookupLanguage returns the supported language with the given id, with the backend's label.
func lookupLanguage(id string) (LangInfo, bool) {
	l, ok := supportedLanguageByID[id]
	return l, ok
}

// resolveLanguagePair checks that a and b are two different supported languages and returns them
// with the backend's labels (the client labels are ignored).
func resolveLanguagePair(a, b LangInfo) (LangInfo, LangInfo, bool) {
	la, okA := lookupLanguage(a.ID)
	lb, okB := lookupLanguage(b.ID)
	if !okA || !okB || la.ID == lb.ID {
		return LangInfo{}, LangInfo{}, false
	}
	return la, lb, true
}

// decodeLangField decodes a {"id","label"} JSON value from a multipart field, rejecting unknown
// fields and any data after the value, like decodeJSONBody.
func decodeLangField(s string) (LangInfo, error) {
	var l LangInfo
	dec := json.NewDecoder(strings.NewReader(s))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&l); err != nil {
		return LangInfo{}, err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return LangInfo{}, errTrailingData
	}
	return l, nil
}

// Limits for the non-file fields of /api/interpret. The transcript is checked again after trimming
// (maxTextRunes); its byte limit only leaves room for 4-byte characters and surrounding spaces.
const (
	maxInterpretFieldBytes      = 1 << 10 // 1 KiB
	maxInterpretTranscriptBytes = 4 << 10 // 4 KiB
)

// errFieldTooLarge is returned by checkInterpretFields when a field is over its limit.
var errFieldTooLarge = errors.New("form field too large")

// checkInterpretFields checks the size of every non-file value of a parsed multipart form.
func checkInterpretFields(values map[string][]string) error {
	for name, vs := range values {
		limit := maxInterpretFieldBytes
		if name == "transcript" {
			limit = maxInterpretTranscriptBytes
		}
		for _, v := range vs {
			if len(v) > limit {
				return errFieldTooLarge
			}
		}
	}
	return nil
}
