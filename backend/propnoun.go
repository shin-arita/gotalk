package main

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"unicode"

	"github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

type propNounType string

const (
	propNounPerson       propNounType = "person"
	propNounPlace        propNounType = "place"
	propNounOrganization propNounType = "organization"
	propNounFacility     propNounType = "facility"
	propNounUnknown      propNounType = "unknown"
)

var facilitySuffixes = []string{
	"駅", "空港", "港", "ホテル", "病院", "大学", "高校", "中学校", "小学校", "神社", "寺", "城",
}

type propNounEntry struct {
	Placeholder  string       `json:"placeholder"`
	Surface      string       `json:"surface"`
	RomanizedText *string     `json:"romanizedText"`
	Type         propNounType `json:"type"`
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

// isFacilitySuffix returns true if the token surface exactly matches a facility suffix.
func isFacilitySuffix(surface string) bool {
	for _, s := range facilitySuffixes {
		if surface == s {
			return true
		}
	}
	return false
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

		// Check if next token is a facility suffix
		if i+1 < len(tokens) {
			next := tokens[i+1]
			if isFacilitySuffix(next.Surface) {
				surface += next.Surface
				ptype = propNounFacility
				if r, ok := tokenReading(next.Features()); ok {
					readings = append(readings, r)
				}
				i++ // consume suffix token
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
		entries[i] = propNounEntry{
			Placeholder:   placeholder,
			Surface:       raw.surface,
			RomanizedText: romanizedText,
			Type:          raw.ptype,
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

// restoreWithSurface replaces placeholders in text with their surface forms.
func restoreWithSurface(text string, entries []propNounEntry) string {
	for _, e := range entries {
		text = strings.ReplaceAll(text, e.Placeholder, e.Surface)
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

	entries, err = extractProperNouns(text)
	if err != nil {
		log.Printf("WARN: proper noun extraction failed: %v", err)
		return "", "", nil, err
	}

	if len(entries) == 0 {
		return "", "", nil, nil // caller uses normal translation
	}

	placeholderText := replacePlaceholders(text, entries)
	expected := expectedCounts(placeholderText, entries)

	// Step 1: translate
	translatedRaw, err = callOpenAI(apiKey, model, translatePromptFn(placeholderText))
	if err != nil {
		return "", "", entries, fmt.Errorf("translation failed: %w", err)
	}
	if err = validatePlaceholders(translatedRaw, entries, expected); err != nil {
		return "", "", entries, fmt.Errorf("proper_noun_protection_failed: translation: %w", err)
	}

	// Step 2: back-translate
	backTranslationRaw, err = callOpenAI(apiKey, model, backTranslatePromptFn(translatedRaw))
	if err != nil {
		return "", "", entries, fmt.Errorf("back-translation failed: %w", err)
	}
	if err = validatePlaceholders(backTranslationRaw, entries, expected); err != nil {
		return "", "", entries, fmt.Errorf("proper_noun_protection_failed: back-translation: %w", err)
	}

	return translatedRaw, backTranslationRaw, entries, nil
}
