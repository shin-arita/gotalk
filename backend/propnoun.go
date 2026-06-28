package main

import (
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

// introPatternDefs pairs a self-introduction regex with the minimum number of name words required.
// "my name is" is unambiguous so min=1; "I am"/"I'm" require min=2 to avoid false positives
// like "I am happy" or "I am japanese".
var introPatternDefs = []struct {
	re       *regexp.Regexp
	minWords int
}{
	{regexp.MustCompile(`(?i)\bmy\s+name\s+is\s+`), 1},
	{regexp.MustCompile(`(?i)\bi\s*'\s*m\s+`), 2},
	{regexp.MustCompile(`(?i)\bi\s+am\s+`), 2},
}

// introNamePatterns is a flat list of regexes for cheap hasIntroPatterns checks.
var introNamePatterns []*regexp.Regexp

func init() {
	for _, d := range introPatternDefs {
		introNamePatterns = append(introNamePatterns, d.re)
	}
}

// englishNameWordRe finds consecutive ASCII-letter runs (words) in a string.
var englishNameWordRe = regexp.MustCompile(`[a-zA-Z]+`)

// nameStopWords are words that cannot begin or appear within a person name after an intro phrase.
var nameStopWords = map[string]bool{
	// possessives/determiners
	"my": true, "your": true, "his": true, "our": true, "their": true, "its": true,
	"this": true, "that": true, "these": true, "those": true,
	// articles
	"a": true, "an": true, "the": true,
	// conjunctions
	"and": true, "but": true, "or": true, "so": true, "because": true,
	"then": true, "if": true, "when": true, "while": true,
	// pronouns
	"i": true, "you": true, "he": true, "she": true, "we": true, "they": true, "it": true,
	"me": true, "him": true, "her": true, "us": true, "them": true,
	// prepositions
	"from": true, "in": true, "at": true, "on": true, "to": true, "for": true,
	"of": true, "with": true, "by": true, "about": true,
	// auxiliaries
	"is": true, "are": true, "was": true, "were": true,
	"have": true, "has": true, "had": true, "do": true, "does": true, "did": true,
	"will": true, "would": true, "can": true, "could": true, "should": true,
	// common gerunds/verbs
	"going": true, "coming": true, "working": true, "living": true, "trying": true,
	"looking": true, "doing": true, "being": true, "having": true, "getting": true, "feeling": true,
	// other common non-name words
	"not": true, "just": true, "very": true, "here": true, "there": true, "also": true,
	"happy": true, "good": true, "bad": true, "fine": true, "great": true,
	"sorry": true, "sure": true, "new": true, "old": true,
	"please": true, "thank": true, "thanks": true,
}

type propNounType string

const (
	propNounPerson       propNounType = "person"
	propNounPlace        propNounType = "place"
	propNounOrganization propNounType = "organization"
	propNounUnknown      propNounType = "unknown"
)

type propNounEntry struct {
	Placeholder   string            `json:"placeholder"`
	Surface       string            `json:"surface"`
	RomanizedText *string           `json:"romanizedText"`
	Type          propNounType      `json:"type"`
	Translations  map[string]string `json:"translations,omitempty"`
	TargetDisplay string            `json:"targetDisplay,omitempty"`
}

// romajiKataMap maps romanized syllables (longest-first priority) to katakana.
var romajiKataMap = map[string]string{
	// 3-char sequences (try before 2-char to avoid wrong splits)
	"sha": "シャ", "shi": "シ", "shu": "シュ", "sho": "ショ",
	"chi": "チ", "cha": "チャ", "chu": "チュ", "cho": "チョ",
	"tsu": "ツ",
	"kya": "キャ", "kyu": "キュ", "kyo": "キョ",
	"nya": "ニャ", "nyu": "ニュ", "nyo": "ニョ",
	"hya": "ヒャ", "hyu": "ヒュ", "hyo": "ヒョ",
	"mya": "ミャ", "myu": "ミュ", "myo": "ミョ",
	"rya": "リャ", "ryu": "リュ", "ryo": "リョ",
	"gya": "ギャ", "gyu": "ギュ", "gyo": "ギョ",
	"bya": "ビャ", "byu": "ビュ", "byo": "ビョ",
	"pya": "ピャ", "pyu": "ピュ", "pyo": "ピョ",
	// 2-char sequences
	"ka": "カ", "ki": "キ", "ku": "ク", "ke": "ケ", "ko": "コ",
	"sa": "サ", "si": "シ", "su": "ス", "se": "セ", "so": "ソ",
	"ta": "タ", "ti": "チ", "tu": "ツ", "te": "テ", "to": "ト",
	"na": "ナ", "ni": "ニ", "nu": "ヌ", "ne": "ネ", "no": "ノ",
	"ha": "ハ", "hi": "ヒ", "hu": "フ", "fu": "フ", "he": "ヘ", "ho": "ホ",
	"ma": "マ", "mi": "ミ", "mu": "ム", "me": "メ", "mo": "モ",
	"ya": "ヤ", "yu": "ユ", "yo": "ヨ",
	"ra": "ラ", "ri": "リ", "ru": "ル", "re": "レ", "ro": "ロ",
	"wa": "ワ", "wo": "ヲ",
	"ga": "ガ", "gi": "ギ", "gu": "グ", "ge": "ゲ", "go": "ゴ",
	"za": "ザ", "zi": "ジ", "zu": "ズ", "ze": "ゼ", "zo": "ゾ",
	"ji": "ジ",
	"da": "ダ", "di": "ヂ", "du": "ヅ", "de": "デ", "do": "ド",
	"ba": "バ", "bi": "ビ", "bu": "ブ", "be": "ベ", "bo": "ボ",
	"pa": "パ", "pi": "ピ", "pu": "プ", "pe": "ペ", "po": "ポ",
	"fa": "ファ", "fi": "フィ", "fe": "フェ", "fo": "フォ",
	"ja": "ジャ", "ju": "ジュ", "jo": "ジョ",
	"va": "ヴァ", "vi": "ヴィ", "vu": "ヴ", "ve": "ヴェ", "vo": "ヴォ",
	// vowels
	"a": "ア", "i": "イ", "u": "ウ", "e": "エ", "o": "オ",
	// standalone n
	"n": "ン",
}

// romajiToKatakana converts a single lowercase romanized name word to katakana.
// Tries 3-char, 2-char, then 1-char segments in order. Returns ("", false) if any
// segment cannot be matched.
func romajiToKatakana(s string) (string, bool) {
	s = strings.ToLower(s)
	var sb strings.Builder
	i := 0
	for i < len(s) {
		matched := false
		for _, l := range []int{3, 2, 1} {
			if i+l > len(s) {
				continue
			}
			chunk := s[i : i+l]
			if kata, ok := romajiKataMap[chunk]; ok {
				sb.WriteString(kata)
				i += l
				matched = true
				break
			}
		}
		if !matched {
			return "", false
		}
	}
	return sb.String(), true
}

// englishNameToKatakana converts an English name (given-name family-name order) to
// Japanese katakana display form (family-name given-name order).
// Returns ("", false) if any word cannot be converted.
func englishNameToKatakana(name string) (string, bool) {
	words := strings.Fields(name)
	if len(words) == 0 {
		return "", false
	}
	for i, j := 0, len(words)-1; i < j; i, j = i+1, j-1 {
		words[i], words[j] = words[j], words[i]
	}
	parts := make([]string, 0, len(words))
	for _, w := range words {
		kata, ok := romajiToKatakana(w)
		if !ok {
			return "", false
		}
		parts = append(parts, kata)
	}
	return strings.Join(parts, " "), true
}

// kataToRomaji converts a katakana string to ASCII Hepburn romanization.
// Long vowels are collapsed (uu→u, ou→o, oo→o, etc.). Returns ("", false) on failure.
func kataToRomaji(kata string) (string, bool) {
	runes := []rune(kata)
	var sb strings.Builder
	i := 0
	for i < len(runes) {
		ch := runes[i]

		// Long vowel mark: drop
		if ch == 'ー' {
			i++
			continue
		}

		// Small tsu: double next consonant
		if ch == 'ッ' {
			if i+1 >= len(runes) {
				return "", false
			}
			// Get next character's romaji to find its first consonant
			next, ok := singleKataMap(runes[i+1])
			if !ok || len(next) == 0 {
				return "", false
			}
			sb.WriteByte(next[0])
			i++
			continue
		}

		// Try two-rune compound first
		if i+1 < len(runes) {
			if r, ok := compoundKataMap(runes[i], runes[i+1]); ok {
				sb.WriteString(r)
				i += 2
				continue
			}
		}

		// Single rune
		r, ok := singleKataMap(ch)
		if !ok {
			return "", false
		}
		sb.WriteString(r)
		i++
	}

	raw := sb.String()
	// Collapse long vowel sequences
	raw = collapseLongVowels(raw)
	return raw, true
}

func collapseLongVowels(s string) string {
	pairs := []string{"aa", "ii", "uu", "ee", "oo", "ou"}
	replacements := []string{"a", "i", "u", "e", "o", "o"}
	changed := true
	for changed {
		changed = false
		for j, p := range pairs {
			if strings.Contains(s, p) {
				s = strings.ReplaceAll(s, p, replacements[j])
				changed = true
			}
		}
	}
	return s
}

func compoundKataMap(a, b rune) (string, bool) {
	key := string([]rune{a, b})
	m := map[string]string{
		"キャ": "kya", "キュ": "kyu", "キョ": "kyo",
		"シャ": "sha", "シュ": "shu", "ショ": "sho",
		"チャ": "cha", "チュ": "chu", "チョ": "cho",
		"ニャ": "nya", "ニュ": "nyu", "ニョ": "nyo",
		"ヒャ": "hya", "ヒュ": "hyu", "ヒョ": "hyo",
		"ミャ": "mya", "ミュ": "myu", "ミョ": "myo",
		"リャ": "rya", "リュ": "ryu", "リョ": "ryo",
		"ギャ": "gya", "ギュ": "gyu", "ギョ": "gyo",
		"ジャ": "ja",  "ジュ": "ju",  "ジョ": "jo",
		"ビャ": "bya", "ビュ": "byu", "ビョ": "byo",
		"ピャ": "pya", "ピュ": "pyu", "ピョ": "pyo",
		"ファ": "fa",  "フィ": "fi",  "フェ": "fe",  "フォ": "fo",
		"ウィ": "wi",  "ウェ": "we",  "ウォ": "wo",
		"ヴァ": "va",  "ヴィ": "vi",  "ヴェ": "ve",  "ヴォ": "vo",
	}
	r, ok := m[key]
	return r, ok
}

func singleKataMap(ch rune) (string, bool) {
	m := map[rune]string{
		'ア': "a",   'イ': "i",   'ウ': "u",   'エ': "e",   'オ': "o",
		'カ': "ka",  'キ': "ki",  'ク': "ku",  'ケ': "ke",  'コ': "ko",
		'サ': "sa",  'シ': "shi", 'ス': "su",  'セ': "se",  'ソ': "so",
		'タ': "ta",  'チ': "chi", 'ツ': "tsu", 'テ': "te",  'ト': "to",
		'ナ': "na",  'ニ': "ni",  'ヌ': "nu",  'ネ': "ne",  'ノ': "no",
		'ハ': "ha",  'ヒ': "hi",  'フ': "fu",  'ヘ': "he",  'ホ': "ho",
		'マ': "ma",  'ミ': "mi",  'ム': "mu",  'メ': "me",  'モ': "mo",
		'ヤ': "ya",  'ユ': "yu",  'ヨ': "yo",
		'ラ': "ra",  'リ': "ri",  'ル': "ru",  'レ': "re",  'ロ': "ro",
		'ワ': "wa",  'ヲ': "o",   'ン': "n",
		'ガ': "ga",  'ギ': "gi",  'グ': "gu",  'ゲ': "ge",  'ゴ': "go",
		'ザ': "za",  'ジ': "ji",  'ズ': "zu",  'ゼ': "ze",  'ゾ': "zo",
		'ダ': "da",  'ヂ': "ji",  'ヅ': "zu",  'デ': "de",  'ド': "do",
		'バ': "ba",  'ビ': "bi",  'ブ': "bu",  'ベ': "be",  'ボ': "bo",
		'パ': "pa",  'ピ': "pi",  'プ': "pu",  'ペ': "pe",  'ポ': "po",
		'ヴ': "vu",
	}
	r, ok := m[ch]
	return r, ok
}

// capitalize returns the string with its first rune uppercased.
func capitalize(s string) string {
	if s == "" {
		return ""
	}
	runes := []rune(s)
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

// tokenReading returns the reading from features[7], or ("", false) if unavailable.
func tokenReading(features []string) (string, bool) {
	if len(features) < 8 || features[7] == "*" {
		return "", false
	}
	return features[7], true
}

// romanizeReading converts a katakana reading to capitalized ASCII Hepburn.
// Returns ("", false) on failure.
func romanizeReading(reading string) (string, bool) {
	r, ok := kataToRomaji(reading)
	if !ok || r == "" {
		return "", false
	}
	return capitalize(r), true
}

var kagomeTok *tokenizer.Tokenizer

func getTokenizer() (*tokenizer.Tokenizer, error) {
	if kagomeTok != nil {
		return kagomeTok, nil
	}
	t, err := tokenizer.New(ipa.Dict(), tokenizer.OmitBosEos())
	if err != nil {
		return nil, err
	}
	kagomeTok = t
	return t, nil
}

// isPureKatakana returns true if every rune in s is a katakana character.
func isPureKatakana(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '゠' || r > 'ヿ' {
			return false
		}
	}
	return true
}

// isProperNoun returns true if the token features indicate 名詞・固有名詞.
func isProperNounFeatures(features []string) bool {
	return len(features) >= 2 && features[0] == "名詞" && features[1] == "固有名詞"
}

// propNounTypeFromFeatures maps features[2] to propNounType.
func propNounTypeFromFeatures(features []string) propNounType {
	if len(features) < 3 {
		return propNounUnknown
	}
	switch features[2] {
	case "人名":
		return propNounPerson
	case "地域":
		return propNounPlace
	case "組織":
		return propNounOrganization
	default:
		return propNounUnknown
	}
}

// extractEnglishIntroNames detects person names following self-introduction patterns
// ("my name is", "I am", "I'm") in the text. Returns raw name surface strings.
// Works regardless of casing, so speech-recognition output like "shin arita" is captured.
// Stops collecting name words at sentence punctuation or stop words.
func extractEnglishIntroNames(text string) []string {
	seen := map[string]bool{}
	var names []string

	for _, def := range introPatternDefs {
		locs := def.re.FindAllStringIndex(text, -1)
		for _, loc := range locs {
			rest := text[loc[1]:]
			if len(rest) == 0 {
				continue
			}
			// Skip if rest doesn't start with a letter (e.g. digit, placeholder underscore)
			if !unicode.IsLetter([]rune(rest)[0]) {
				continue
			}
			// Collect name words, stopping at sentence punctuation between words
			wordMatches := englishNameWordRe.FindAllStringIndex(rest, -1)
			var nameParts []string
			prevEnd := 0
			for _, wm := range wordMatches {
				between := rest[prevEnd:wm[0]]
				// Stop if punctuation or placeholder boundary appears between words
				if strings.ContainsAny(between, ".!?,;:_") {
					break
				}
				w := rest[wm[0]:wm[1]]
				if nameStopWords[strings.ToLower(w)] {
					break
				}
				nameParts = append(nameParts, w)
				if len(nameParts) >= 3 {
					break
				}
				prevEnd = wm[1]
			}
			if len(nameParts) < def.minWords {
				continue
			}
			name := strings.Join(nameParts, " ")
			lower := strings.ToLower(name)
			if seen[lower] {
				continue
			}
			seen[lower] = true
			names = append(names, name)
		}
	}
	return names
}

// hasIntroPatterns reports whether text contains a self-introduction pattern.
// Used as a cheap pre-check before running full proper noun protection.
func hasIntroPatterns(text string) bool {
	for _, pat := range introNamePatterns {
		if pat.MatchString(text) {
			return true
		}
	}
	return false
}

// extractAllProperNouns merges Kagome-based Japanese proper noun extraction with
// English self-introduction name detection into a single numbered entry list.
// Kagome is only invoked when the text contains Japanese characters, avoiding
// unexpected matches on ASCII text.
func extractAllProperNouns(text string) ([]propNounEntry, error) {
	var entries []propNounEntry

	if hasJapaneseChars(text) {
		var err error
		entries, err = extractProperNouns(text)
		if err != nil {
			return nil, err
		}
	}

	known := make(map[string]bool, len(entries))
	for _, e := range entries {
		known[strings.ToLower(e.Surface)] = true
	}

	offset := len(entries)
	for _, name := range extractEnglishIntroNames(text) {
		lower := strings.ToLower(name)
		if known[lower] {
			continue
		}
		known[lower] = true
		entry := propNounEntry{
			Placeholder:  fmt.Sprintf("__GT_PROPN_%03d__", offset),
			Surface:      name,
			Type:         propNounPerson,
			Translations: map[string]string{"en": name},
		}
		if td, ok := englishNameToKatakana(name); ok {
			entry.TargetDisplay = td
		}
		entries = append(entries, entry)
		offset++
	}

	return entries, nil
}

// extractProperNouns tokenizes text and extracts proper nouns with compound facility merging.
// Returns nil entries and a warning-logged error on tokenizer failure.
func extractProperNouns(text string) ([]propNounEntry, error) {
	t, err := getTokenizer()
	if err != nil {
		return nil, fmt.Errorf("kagome tokenizer init failed: %w", err)
	}

	tokens := t.Tokenize(text)

	type rawEntry struct {
		surface  string
		readings []string // per-token readings for compound
		ptype    propNounType
	}

	var raws []rawEntry
	surfaceIndex := map[string]int{} // surface → index in raws

	for i := 0; i < len(tokens); i++ {
		tok := tokens[i]
		features := tok.Features()
		if !isProperNounFeatures(features) {
			continue
		}

		surface := tok.Surface
		ptype := propNounTypeFromFeatures(features)

		// Collect readings for this base token
		var readings []string
		if r, ok := tokenReading(features); ok {
			readings = append(readings, r)
		}

		// Compound: person name (surname + given name).
		// Merges when next token is also 固有名詞・人名, OR is a short (≤3 chars) katakana
		// sequence immediately following the surname — katakana given names (e.g. シン, ケン)
		// are often absent from the IPA dictionary and would otherwise reach the AI untranslated.
		if ptype == propNounPerson && i+1 < len(tokens) {
			next := tokens[i+1]
			nextFeatures := next.Features()
			isNextPersonName := len(nextFeatures) >= 3 && nextFeatures[0] == "名詞" && nextFeatures[1] == "固有名詞" && nextFeatures[2] == "人名"
			isNextShortKatakana := isPureKatakana(next.Surface) && len([]rune(next.Surface)) <= 3
			if isNextPersonName || isNextShortKatakana {
				surface += next.Surface
				if r, ok := tokenReading(nextFeatures); ok {
					readings = append(readings, r)
				} else if isNextShortKatakana {
					readings = append(readings, next.Surface)
				}
				i++ // consume given name token
			}
		}

		if idx, exists := surfaceIndex[surface]; exists {
			_ = idx // already recorded; same placeholder will be reused
			continue
		}
		surfaceIndex[surface] = len(raws)
		raws = append(raws, rawEntry{surface: surface, readings: readings, ptype: ptype})
	}

	// Build entries with placeholders
	entries := make([]propNounEntry, len(raws))
	for i, raw := range raws {
		placeholder := fmt.Sprintf("__GT_PROPN_%03d__", i)
		var romanizedText *string
		if len(raw.readings) > 0 {
			// Romanize each reading separately, capitalize each, join with space
			var parts []string
			allOK := true
			for _, r := range raw.readings {
				rom, ok := romanizeReading(r)
				if !ok {
					allOK = false
					break
				}
				parts = append(parts, rom)
			}
			if allOK && len(parts) > 0 {
				joined := strings.Join(parts, " ")
				romanizedText = &joined
			}
		}
		translations := map[string]string{"ja": raw.surface}
		entries[i] = propNounEntry{
			Placeholder:   placeholder,
			Surface:       raw.surface,
			RomanizedText: romanizedText,
			Type:          raw.ptype,
			Translations:  translations,
		}
	}
	return entries, nil
}

// replacePlaceholders replaces proper noun surfaces in text with their placeholders.
// Longer surfaces are replaced first (longest match).
func replacePlaceholders(text string, entries []propNounEntry) string {
	sorted := make([]propNounEntry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool {
		return len(sorted[i].Surface) > len(sorted[j].Surface)
	})
	for _, e := range sorted {
		text = strings.ReplaceAll(text, e.Surface, e.Placeholder)
	}
	return text
}

// expectedCounts returns a map of placeholder → expected occurrence count in placeholderText.
func expectedCounts(placeholderText string, entries []propNounEntry) map[string]int {
	counts := make(map[string]int, len(entries))
	for _, e := range entries {
		counts[e.Placeholder] = strings.Count(placeholderText, e.Placeholder)
	}
	return counts
}

// validatePlaceholders verifies that each placeholder in expected appears the correct number of times
// in output, and that no unknown placeholders exist.
func validatePlaceholders(output string, entries []propNounEntry, expected map[string]int) error {
	knownSet := make(map[string]struct{}, len(entries))
	for _, e := range entries {
		knownSet[e.Placeholder] = struct{}{}
	}

	// Check all expected placeholders appear the right number of times
	for ph, count := range expected {
		got := strings.Count(output, ph)
		if got != count {
			return fmt.Errorf("placeholder %s: expected %d occurrences, got %d", ph, count, got)
		}
	}

	// Check no unexpected placeholders appear
	// Scan for __GT_PROPN_NNN__ patterns
	s := output
	for {
		start := strings.Index(s, "__GT_PROPN_")
		if start < 0 {
			break
		}
		rest := s[start:]
		end := strings.Index(rest, "__")
		if end < 2 {
			break
		}
		ph := rest[:end+2]
		if _, ok := knownSet[ph]; !ok {
			return fmt.Errorf("unknown placeholder %s in output", ph)
		}
		s = rest[end+2:]
	}
	return nil
}

// restoreForLang replaces placeholders with the most appropriate form for langID.
// Priority: Translations[langID] → TargetDisplay → RomanizedText → Surface.
func restoreForLang(text string, entries []propNounEntry, langID string) string {
	for _, e := range entries {
		var form string
		if t, ok := e.Translations[langID]; ok {
			form = t
		} else if e.TargetDisplay != "" {
			form = e.TargetDisplay
		} else if e.RomanizedText != nil {
			form = *e.RomanizedText
		} else {
			form = e.Surface
		}
		text = strings.ReplaceAll(text, e.Placeholder, form)
	}
	return text
}

// restoreWithRomanized replaces placeholders in text with romanizedText (or surface if null).
func restoreWithRomanized(text string, entries []propNounEntry) string {
	for _, e := range entries {
		var restore string
		if e.RomanizedText != nil {
			restore = *e.RomanizedText
		} else {
			restore = e.Surface
		}
		text = strings.ReplaceAll(text, e.Placeholder, restore)
	}
	return text
}

// hasJapaneseChars returns true if s contains at least one hiragana, katakana, or CJK character.
func hasJapaneseChars(s string) bool {
	for _, r := range s {
		if (r >= '぀' && r <= 'ゟ') || // Hiragana
			(r >= '゠' && r <= 'ヿ') || // Katakana
			(r >= '一' && r <= '鿿') || // CJK unified
			(r >= '㐀' && r <= '䶿') { // CJK extension A
			return true
		}
	}
	return false
}

// collectMissingPlaceholders returns placeholders that appear fewer times than expected in output.
func collectMissingPlaceholders(output string, expected map[string]int) []string {
	var missing []string
	for ph, count := range expected {
		if strings.Count(output, ph) < count {
			missing = append(missing, ph)
		}
	}
	sort.Strings(missing)
	return missing
}

// buildRetryPrompt appends a critical reminder about dropped placeholders to basePrompt.
func buildRetryPrompt(basePrompt string, missingPlaceholders []string) string {
	var sb strings.Builder
	sb.WriteString(basePrompt)
	sb.WriteString("\n\n[CRITICAL RETRY] Your previous response omitted the following placeholder(s). You MUST include each one verbatim — do NOT translate, modify, split, or omit:\n")
	for _, ph := range missingPlaceholders {
		sb.WriteString("  " + ph + "\n")
	}
	return sb.String()
}

// applyProperNounProtection runs the full protection pipeline:
// 1. Extract proper nouns
// 2. Replace with placeholders
// 3. Call translate
// 4. Validate
// 5. Call back-translate
// 6. Validate
// Returns translatedRaw (with placeholders), backTranslationRaw (with placeholders), entries, error.
// On tokenizer failure: returns ("", "", nil, err) — caller should fall back to unprotected translation.
// On placeholder validation failure: returns ("", "", nil, err) with a protection-failed sentinel.
func runProtectedTranslation(
	apiKey, model string,
	text string,
	translatePromptFn func(placeholderText string) string,
	backTranslatePromptFn func(translatedRaw string) string,
) (translatedRaw, backTranslationRaw string, entries []propNounEntry, err error) {

	entries, err = extractAllProperNouns(text)
	if err != nil {
		log.Printf("WARN: proper noun extraction failed: %v", err)
		return "", "", nil, err
	}

	if len(entries) == 0 {
		return "", "", nil, nil // caller uses normal translation
	}

	placeholderText := replacePlaceholders(text, entries)
	expected := expectedCounts(placeholderText, entries)

	debugLog("固有名詞保護前テキスト: %q", text)
	debugLog("固有名詞保護後テキスト: %q", placeholderText)
	for _, e := range entries {
		rom := "(なし)"
		if e.RomanizedText != nil {
			rom = *e.RomanizedText
		}
		debugLog("保護マップ: %s → %q [romanized: %s] [targetDisplay: %q]", e.Placeholder, e.Surface, rom, e.TargetDisplay)
	}

	// Step 1: translate
	txPrompt := translatePromptFn(placeholderText)
	debugLog("翻訳プロンプト:\n%s", txPrompt)
	debugLog("OpenAI 翻訳対象テキスト: %q", placeholderText)
	translatedRaw, err = callOpenAI(apiKey, model, txPrompt)
	if err != nil {
		return "", "", entries, fmt.Errorf("translation failed: %w", err)
	}
	debugLog("OpenAI 翻訳 生レスポンス: %q", translatedRaw)
	if valErr := validatePlaceholders(translatedRaw, entries, expected); valErr != nil {
		missing := collectMissingPlaceholders(translatedRaw, expected)
		debugLog("プレースホルダ欠落 (翻訳): %v — 再翻訳します", missing)
		retryPrompt := buildRetryPrompt(txPrompt, missing)
		translatedRaw, err = callOpenAI(apiKey, model, retryPrompt)
		if err != nil {
			return "", "", entries, fmt.Errorf("translation retry failed: %w", err)
		}
		debugLog("OpenAI 再翻訳 生レスポンス: %q", translatedRaw)
		if err = validatePlaceholders(translatedRaw, entries, expected); err != nil {
			debugLog("プレースホルダ欠落 再試行後も失敗 (翻訳): %v", err)
			return "", "", entries, fmt.Errorf("proper_noun_protection_failed: translation: %w", err)
		}
	}

	// Step 2: back-translate
	debugLog("バックトランスレーション入力: %q", translatedRaw)
	btPrompt := backTranslatePromptFn(translatedRaw)
	debugLog("バックトランスレーション プロンプト:\n%s", btPrompt)
	backTranslationRaw, err = callOpenAI(apiKey, model, btPrompt)
	if err != nil {
		return "", "", entries, fmt.Errorf("back-translation failed: %w", err)
	}
	debugLog("バックトランスレーション 生レスポンス: %q", backTranslationRaw)
	if valErr := validatePlaceholders(backTranslationRaw, entries, expected); valErr != nil {
		missing := collectMissingPlaceholders(backTranslationRaw, expected)
		debugLog("プレースホルダ欠落 (バックトランスレーション): %v — 再翻訳します", missing)
		retryBtPrompt := buildRetryPrompt(btPrompt, missing)
		backTranslationRaw, err = callOpenAI(apiKey, model, retryBtPrompt)
		if err != nil {
			return "", "", entries, fmt.Errorf("back-translation retry failed: %w", err)
		}
		debugLog("OpenAI 再バックトランスレーション 生レスポンス: %q", backTranslationRaw)
		if err = validatePlaceholders(backTranslationRaw, entries, expected); err != nil {
			debugLog("プレースホルダ欠落 再試行後も失敗 (バックトランスレーション): %v", err)
			return "", "", entries, fmt.Errorf("proper_noun_protection_failed: back-translation: %w", err)
		}
	}

	return translatedRaw, backTranslationRaw, entries, nil
}
