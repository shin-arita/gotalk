package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	defaultModel        = "gpt-4o-mini"
	defaultWhisperModel = "gpt-4o-transcribe"
	defaultTTSModel     = "gpt-4o-mini-tts"
	defaultTTSVoice     = "marin"
	langDetectionModel  = "whisper-1"
	openAIResponsesURL  = "https://api.openai.com/v1/responses"
	openAITTSURL        = "https://api.openai.com/v1/audio/speech"
	whisperURL          = "https://api.openai.com/v1/audio/transcriptions"
)

type LangInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type TranslateRequest struct {
	Text      string     `json:"text"`
	Languages []LangInfo `json:"languages"`
}

type TranslateResponse struct {
	SourceLanguage  string `json:"sourceLanguage"`
	TargetLanguage  string `json:"targetLanguage"`
	TranslatedText  string `json:"translatedText"`
	BackTranslation string `json:"backTranslation"`
	TtsText         string `json:"ttsText"`
}

type InterpretResponse struct {
	Text            string `json:"text"`
	SourceLanguage  string `json:"sourceLanguage"`
	TargetLanguage  string `json:"targetLanguage"`
	TranslatedText  string `json:"translatedText"`
	BackTranslation string `json:"backTranslation"`
	TtsText         string `json:"ttsText"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

type TTSRequest struct {
	Text string `json:"text"`
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorResponse{Error: msg})
}

func debugLog(format string, args ...interface{}) {
	if os.Getenv("DEBUG_TRANSLATION") == "true" {
		log.Printf("[DEBUG_TRANSLATION] "+format, args...)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// callOpenAITTS calls the OpenAI Speech API and returns raw audio bytes (audio/mpeg).
func callOpenAITTS(apiKey, model, voice, text string) ([]byte, error) {
	type reqBody struct {
		Model string `json:"model"`
		Input string `json:"input"`
		Voice string `json:"voice"`
	}
	payload, err := json.Marshal(reqBody{Model: model, Input: text, Voice: voice})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, openAITTSURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("OpenAI TTS API returned status %d: %s", resp.StatusCode, string(body))
	}

	return io.ReadAll(resp.Body)
}

func ttsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		writeError(w, http.StatusInternalServerError, "service unavailable")
		return
	}

	model := os.Getenv("OPENAI_TTS_MODEL")
	if model == "" {
		model = defaultTTSModel
	}
	voice := os.Getenv("OPENAI_TTS_VOICE")
	if voice == "" {
		voice = defaultTTSVoice
	}

	var req TTSRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if strings.TrimSpace(req.Text) == "" {
		writeError(w, http.StatusBadRequest, "text is required")
		return
	}

	audio, err := callOpenAITTS(apiKey, model, voice, req.Text)
	if err != nil {
		log.Printf("TTS error: %v", err)
		writeError(w, http.StatusBadGateway, "tts failed")
		return
	}

	w.Header().Set("Content-Type", "audio/mpeg")
	w.Write(audio)
}

// callOpenAI sends a single prompt to the OpenAI Responses API and returns the text output.
func callOpenAI(apiKey, model, prompt string) (string, error) {
	type reqBody struct {
		Model string `json:"model"`
		Input string `json:"input"`
	}
	type contentItem struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	type outputItem struct {
		Content []contentItem `json:"content"`
	}
	type respBody struct {
		Output []outputItem `json:"output"`
	}

	payload, err := json.Marshal(reqBody{Model: model, Input: prompt})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest(http.MethodPost, openAIResponsesURL, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("OpenAI API returned status %d", resp.StatusCode)
	}

	var result respBody
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}

	if len(result.Output) == 0 || len(result.Output[0].Content) == 0 {
		return "", fmt.Errorf("empty response from OpenAI")
	}

	return strings.TrimSpace(result.Output[0].Content[0].Text), nil
}

// extractJSON strips markdown code fences if OpenAI wraps the JSON in them.
func extractJSON(s string) string {
	idx := strings.Index(s, "{")
	if idx < 0 {
		return s
	}
	end := strings.LastIndex(s, "}")
	if end < idx {
		return s
	}
	return s[idx : end+1]
}

// whisperLangCode converts an app language ID to the ISO 639-1 code Whisper expects.
func whisperLangCode(id string) string {
	return strings.SplitN(id, "-", 2)[0]
}

// whisperPrompts holds language-specific transcription hints to improve proper-noun recognition.
var whisperPrompts = map[string]string{
	"ja": "日本語の会話です。固有名詞（地名・駅名・施設名・店名・会社名・人名・ブランド名）はカタカナや漢字で正確に認識してください。",
	"en": "English conversation. Transcribe proper nouns—people, places, stations, shops, companies, brands—accurately.",
	"zh": "这是中文对话。请准确识别专有名词，包括人名、地名、站名、设施名、店铺名、公司名和品牌名。",
	"ko": "한국어 대화입니다. 인명, 지명, 역명, 시설명, 상호명, 회사명, 브랜드명 등 고유명사를 정확하게 인식해주세요.",
	"th": "การสนทนาภาษาไทย โปรดถอดเสียงคำนามเฉพาะ เช่น ชื่อบุคคล สถานที่ สถานี ร้านค้า บริษัท และแบรนด์ให้ถูกต้อง",
	"vi": "Cuộc hội thoại tiếng Việt. Hãy nhận dạng chính xác các danh từ riêng như tên người, địa danh, tên ga, cửa hàng, công ty và thương hiệu.",
}

// callWhisper transcribes audio via OpenAI and returns the text and detected language.
// whisper-1 supports verbose_json (includes language); gpt-4o-transcribe only supports json (no language field).
// Pass language (ISO 639-1, e.g. "ja") and prompt to improve accuracy; empty string skips the field.
func callWhisper(apiKey, model string, audioData []byte, filename, language, prompt string) (text, lang string, err error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return "", "", err
	}
	if _, err = part.Write(audioData); err != nil {
		return "", "", err
	}
	if err = mw.WriteField("model", model); err != nil {
		return "", "", err
	}
	responseFormat := "json"
	if strings.HasPrefix(strings.ToLower(model), "whisper-1") {
		responseFormat = "verbose_json"
	}
	if err = mw.WriteField("response_format", responseFormat); err != nil {
		return "", "", err
	}
	if language != "" {
		if err = mw.WriteField("language", language); err != nil {
			return "", "", err
		}
	}
	if prompt != "" {
		if err = mw.WriteField("prompt", prompt); err != nil {
			return "", "", err
		}
	}
	mw.Close()

	req, err := http.NewRequest(http.MethodPost, whisperURL, &buf)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("Whisper API status %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Language string `json:"language"`
		Text     string `json:"text"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", err
	}

	return strings.TrimSpace(result.Text), strings.ToLower(strings.TrimSpace(result.Language)), nil
}

// whisperLangMatches reports whether a transcription language tag matches an app language ID.
// Handles both full names ("english", "japanese") from whisper-1 and
// ISO 639-1 codes ("en", "ja") from gpt-4o-transcribe.
func whisperLangMatches(whisperLang, appLangID string) bool {
	wl := strings.ToLower(strings.TrimSpace(whisperLang))
	id := strings.ToLower(strings.TrimSpace(appLangID))

	if wl == "" || id == "" {
		return false
	}

	// ISO code: exact match or prefix match for zh-CN / zh-TW
	if wl == id || strings.HasPrefix(id, wl+"-") {
		return true
	}

	// Full language name → ISO code (whisper-1 style)
	fullToISO := map[string]string{
		"japanese":   "ja",
		"english":    "en",
		"chinese":    "zh",
		"korean":     "ko",
		"thai":       "th",
		"vietnamese": "vi",
	}
	if iso, ok := fullToISO[wl]; ok {
		return iso == id || strings.HasPrefix(id, iso+"-")
	}

	return false
}

func interpretHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		writeError(w, http.StatusInternalServerError, "service unavailable")
		return
	}
	model := os.Getenv("OPENAI_MODEL")
	if model == "" {
		model = defaultModel
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	file, fileHeader, err := r.FormFile("audio")
	if err != nil {
		writeError(w, http.StatusBadRequest, "audio is required")
		return
	}
	defer file.Close()

	audioData, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read audio")
		return
	}

	var myLang, theirLang LangInfo
	if err := json.Unmarshal([]byte(r.FormValue("myLanguage")), &myLang); err != nil || myLang.ID == "" {
		writeError(w, http.StatusBadRequest, "invalid myLanguage")
		return
	}
	if err := json.Unmarshal([]byte(r.FormValue("theirLanguage")), &theirLang); err != nil || theirLang.ID == "" {
		writeError(w, http.StatusBadRequest, "invalid theirLanguage")
		return
	}
	speaker := r.FormValue("speaker")
	clientTranscript := strings.TrimSpace(r.FormValue("transcript"))
	log.Printf("interpret: myLang=%s theirLang=%s speaker=%q file=%s size=%d hasTranscript=%v",
		myLang.ID, theirLang.ID, speaker, fileHeader.Filename, len(audioData), clientTranscript != "")

	var srcLang, tgtLang LangInfo
	var transcribedText string

	if clientTranscript != "" {
		// Fast path: Web Speech API transcript is available — Whisper not needed.
		// Language direction is determined by the speaker field sent from the client.
		switch speaker {
		case myLang.ID:
			srcLang, tgtLang = myLang, theirLang
		case theirLang.ID:
			srcLang, tgtLang = theirLang, myLang
		default:
			writeError(w, http.StatusBadRequest, "invalid speaker")
			return
		}
		transcribedText = clientTranscript
		log.Printf("interpret: transcript=%q src=%s tgt=%s", transcribedText, srcLang.ID, tgtLang.ID)
	} else {
		// Fallback path: no transcript (Web Speech API unavailable) — use Whisper.

		// Step 1: language detection via whisper-1.
		_, detectedLang, err := callWhisper(apiKey, langDetectionModel, audioData, fileHeader.Filename, "", "")
		if err != nil {
			log.Printf("Whisper (lang detection) error: %v", err)
			writeError(w, http.StatusBadGateway, "language detection failed")
			return
		}
		if detectedLang == "" {
			log.Printf("language detection failed: empty language from %s", langDetectionModel)
			writeError(w, http.StatusBadGateway, "language detection failed")
			return
		}

		// Step 2: match against selected languages.
		switch {
		case whisperLangMatches(detectedLang, myLang.ID):
			srcLang, tgtLang = myLang, theirLang
		case whisperLangMatches(detectedLang, theirLang.ID):
			srcLang, tgtLang = theirLang, myLang
		default:
			log.Printf("language_mismatch: detected=%q myLang=%s theirLang=%s", detectedLang, myLang.ID, theirLang.ID)
			writeError(w, http.StatusUnprocessableEntity, "language_mismatch")
			return
		}

		// Step 3: transcription via gpt-4o-transcribe.
		txModel := os.Getenv("WHISPER_MODEL")
		if txModel == "" {
			txModel = defaultWhisperModel
		}
		langCode := whisperLangCode(srcLang.ID)
		transcribedText, _, err = callWhisper(apiKey, txModel, audioData, fileHeader.Filename, langCode, whisperPrompts[langCode])
		if err != nil {
			log.Printf("Whisper (transcription) error: %v", err)
			writeError(w, http.StatusBadGateway, "transcription failed")
			return
		}
		log.Printf("Whisper: detectedLang=%q text=%q", detectedLang, transcribedText)
	}

	translatePrompt := func(srcLabel, tgtLabel, tgtID, text string) string {
		return fmt.Sprintf(
			"You are translating the exact text confirmed by the user on screen.\n"+
				"Do NOT correct, normalize, infer, or rewrite the input — even if it looks like a speech recognition error.\n\n"+
				"Translate the following %s text into %s (%s).\n"+
				"Return ONLY the translated text. No JSON, no markdown, no explanation.\n\n"+
				"Rules:\n"+
				"- STRICT: Translate the input text exactly as written. Do NOT fix typos, garbled text, or apparent speech recognition mistakes.\n"+
				"- NEVER generate proper nouns (names, places, etc.) not explicitly present in the input.\n"+
				"- If the input is unnatural or garbled, translate it as-is without attempting to repair it.\n"+
				"- Proper nouns that DO appear in the input must NOT be semantically translated; keep the original form or romanize phonetically.\n"+
				"- Placeholder は変更・削除・分割・翻訳せず、完全一致で保持すること。\n\n"+
				"Text: %q",
			srcLabel, tgtLabel, tgtID, text,
		)
	}

	backTranslatePrompt := func(tgtLabel, srcLabel, srcID, text string) string {
		return fmt.Sprintf(
			"Back-translate the following %s text into %s (%s).\n"+
				"Return ONLY the back-translated text. No JSON, no markdown, no explanation.\n\n"+
				"- Placeholder は変更・削除・分割・翻訳せず、完全一致で保持すること。\n\n"+
				"Text: %q",
			tgtLabel, srcLabel, srcID, text,
		)
	}

	var translatedText, backTranslation, ttsText string

	debugLog("受信テキスト: %q", transcribedText)

	useProtection := (srcLang.ID == "ja" && hasJapaneseChars(transcribedText)) || (tgtLang.ID != "ja" && hasIntroPatterns(transcribedText))

	if useProtection {
		translatedRaw, backTranslationRaw, entries, perr := runProtectedTranslation(
			apiKey, model,
			transcribedText,
			func(placeholderText string) string {
				return translatePrompt(srcLang.Label, tgtLang.Label, tgtLang.ID, placeholderText)
			},
			func(translatedRaw string) string {
				return backTranslatePrompt(tgtLang.Label, srcLang.Label, srcLang.ID, translatedRaw)
			},
		)
		if perr != nil {
			if strings.Contains(perr.Error(), "proper_noun_protection_failed") {
				log.Printf("interpret: proper noun protection failed: %v", perr)
				writeError(w, http.StatusBadGateway, "proper_noun_protection_failed")
				return
			}
			if entries == nil {
				// Tokenizer failure: fall through to normal translation below
				log.Printf("WARN: interpret: kagome failed, falling back: %v", perr)
				useProtection = false
			} else {
				log.Printf("interpret: translation error: %v", perr)
				writeError(w, http.StatusBadGateway, "translation failed")
				return
			}
		} else if entries != nil {
			translatedText = restoreForLang(translatedRaw, entries, tgtLang.ID)
			backTranslation = restoreForLang(backTranslationRaw, entries, srcLang.ID)
			ttsText = restoreWithRomanized(translatedRaw, entries)
			debugLog("プレースホルダ復元後 翻訳結果: %q", translatedText)
			debugLog("プレースホルダ復元後 バックトランスレーション: %q", backTranslation)
		} else {
			// 0 proper nouns extracted — fall through to normal translation
			useProtection = false
		}
	}

	if !useProtection {
		debugLog("固有名詞保護前テキスト: %q", transcribedText)
		debugLog("OpenAI 翻訳対象テキスト: %q", transcribedText)
		translated, err := callOpenAI(apiKey, model, translatePrompt(srcLang.Label, tgtLang.Label, tgtLang.ID, transcribedText))
		if err != nil {
			log.Printf("OpenAI translation error: %v", err)
			writeError(w, http.StatusBadGateway, "translation failed")
			return
		}
		debugLog("OpenAI 翻訳 生レスポンス: %q", translated)
		debugLog("プレースホルダ復元後 翻訳結果: %q", translated)
		debugLog("バックトランスレーション入力: %q", translated)
		bt, err := callOpenAI(apiKey, model, backTranslatePrompt(tgtLang.Label, srcLang.Label, srcLang.ID, translated))
		if err != nil {
			log.Printf("OpenAI back-translation error: %v", err)
			writeError(w, http.StatusBadGateway, "translation failed")
			return
		}
		debugLog("バックトランスレーション 生レスポンス: %q", bt)
		debugLog("プレースホルダ復元後 バックトランスレーション: %q", bt)
		translatedText = translated
		backTranslation = bt
		ttsText = translatedText
	}

	log.Printf("interpret result: %s -> %s", srcLang.ID, tgtLang.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(InterpretResponse{
		Text:            transcribedText,
		SourceLanguage:  srcLang.ID,
		TargetLanguage:  tgtLang.ID,
		TranslatedText:  translatedText,
		BackTranslation: backTranslation,
		TtsText:         ttsText,
	})
}

func translateHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Println("OPENAI_API_KEY is not set")
		writeError(w, http.StatusInternalServerError, "translation service unavailable")
		return
	}

	model := os.Getenv("OPENAI_MODEL")
	if model == "" {
		model = defaultModel
	}

	var req TranslateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if strings.TrimSpace(req.Text) == "" {
		writeError(w, http.StatusBadRequest, "text is required")
		return
	}
	if len(req.Languages) < 2 {
		writeError(w, http.StatusBadRequest, "two languages are required")
		return
	}

	lang0 := req.Languages[0]
	lang1 := req.Languages[1]
	log.Printf("translate: text=%q lang0=%s lang1=%s", req.Text, lang0.ID, lang1.ID)
	debugLog("受信テキスト: %q", req.Text)

	translatePromptFn := func(srcLabel, tgtLabel, tgtID, text string) string {
		return fmt.Sprintf(
			"You are translating the exact text confirmed by the user on screen.\n"+
				"Do NOT correct, normalize, infer, or rewrite the input — even if it looks like a speech recognition error.\n\n"+
				"Translate the following %s text into %s (%s).\n"+
				"Return ONLY the translated text. No JSON, no markdown, no explanation.\n\n"+
				"Rules:\n"+
				"- STRICT: Translate the input text exactly as written. Do NOT fix typos, garbled text, or apparent speech recognition mistakes.\n"+
				"- NEVER generate proper nouns (names, places, etc.) not explicitly present in the input.\n"+
				"- If the input is unnatural or garbled, translate it as-is without attempting to repair it.\n"+
				"- Proper nouns that DO appear in the input must NOT be semantically translated; keep the original form or romanize phonetically.\n"+
				"- Placeholder は変更・削除・分割・翻訳せず、完全一致で保持すること。\n\n"+
				"Text: %q",
			srcLabel, tgtLabel, tgtID, text,
		)
	}

	backTranslatePromptFn := func(tgtLabel, srcLabel, srcID, text string) string {
		return fmt.Sprintf(
			"Back-translate the following %s text into %s (%s).\n"+
				"Return ONLY the back-translated text. No JSON, no markdown, no explanation.\n\n"+
				"- Placeholder は変更・削除・分割・翻訳せず、完全一致で保持すること。\n\n"+
				"Text: %q",
			tgtLabel, srcLabel, srcID, text,
		)
	}

	// Determine if protection path applies
	jaInCandidates := lang0.ID == "ja" || lang1.ID == "ja"
	hasJaChars := hasJapaneseChars(req.Text)
	useProtection := (jaInCandidates && hasJaChars) || (!jaInCandidates && hasIntroPatterns(req.Text))

	var srcLang, tgtLang LangInfo
	var translatedText, backTranslation, ttsText string

	if useProtection {
		// sourceLanguage determined here, not by OpenAI
		if hasJaChars {
			// Japanese text: Japanese is source
			if lang0.ID == "ja" {
				srcLang, tgtLang = lang0, lang1
			} else {
				srcLang, tgtLang = lang1, lang0
			}
		} else {
			// Non-Japanese text (intro patterns detected): non-Japanese language is source
			if lang0.ID == "ja" {
				srcLang, tgtLang = lang1, lang0
			} else if lang1.ID == "ja" {
				srcLang, tgtLang = lang0, lang1
			} else {
				srcLang, tgtLang = lang0, lang1
			}
		}

		translatedRaw, backTranslationRaw, entries, perr := runProtectedTranslation(
			apiKey, model,
			req.Text,
			func(placeholderText string) string {
				return translatePromptFn(srcLang.Label, tgtLang.Label, tgtLang.ID, placeholderText)
			},
			func(translatedRaw string) string {
				return backTranslatePromptFn(tgtLang.Label, srcLang.Label, srcLang.ID, translatedRaw)
			},
		)
		if perr != nil {
			if strings.Contains(perr.Error(), "proper_noun_protection_failed") {
				log.Printf("translate: proper noun protection failed: %v", perr)
				writeError(w, http.StatusBadGateway, "proper_noun_protection_failed")
				return
			}
			if entries == nil {
				// Tokenizer failure: fall through to normal translation
				log.Printf("WARN: translate: kagome failed, falling back: %v", perr)
				useProtection = false
			} else {
				log.Printf("translate: translation error: %v", perr)
				writeError(w, http.StatusBadGateway, "translation failed")
				return
			}
		} else if entries != nil {
			translatedText = restoreForLang(translatedRaw, entries, tgtLang.ID)
			backTranslation = restoreForLang(backTranslationRaw, entries, srcLang.ID)
			ttsText = restoreWithRomanized(translatedRaw, entries)
			debugLog("プレースホルダ復元後 翻訳結果: %q", translatedText)
			debugLog("プレースホルダ復元後 バックトランスレーション: %q", backTranslation)
		} else {
			// 0 proper nouns — fall through to normal translation
			useProtection = false
		}
	}

	if !useProtection {
		debugLog("固有名詞保護前テキスト: %q", req.Text)
		debugLog("OpenAI 翻訳対象テキスト: %q", req.Text)
		// Normal path: OpenAI detects language and translates
		detectPrompt := fmt.Sprintf(
			"You are translating the exact text confirmed by the user on screen.\n"+
				"Do NOT correct, normalize, infer, or rewrite the input — even if it looks like a speech recognition error.\n\n"+
				"Input text: %q\n"+
				"Candidate languages: %q (%s) and %q (%s)\n\n"+
				"Instructions:\n"+
				"1. Determine whether the input text is written in one of the two candidate languages.\n"+
				"   - If yes, assign that language ID to sourceLanguage.\n"+
				"   - If no (the text is in a different language or unrecognisable), set sourceLanguage to \"unknown\" and leave the other fields empty.\n"+
				"2. If sourceLanguage is known, translate the input to the other candidate language. Assign to translatedText.\n\n"+
				"Rules:\n"+
				"- STRICT: Translate the input text exactly as written. Do NOT fix typos, garbled text, or apparent speech recognition mistakes.\n"+
				"- NEVER generate proper nouns (names, places, etc.) not explicitly present in the input. Example: 'でありか新' must NOT become 'Arida Shin' — translate those exact characters as-is.\n"+
				"- If the input is unnatural or garbled, translate it as-is without attempting to repair it.\n"+
				"- Proper nouns that DO appear in the input must NOT be semantically translated; keep the original form or romanize phonetically.\n"+
				"- Do NOT force the input into a candidate language if it clearly belongs to neither.\n"+
				"- Use language IDs (not labels) for sourceLanguage and targetLanguage.\n"+
				"- Return ONLY a single-line JSON object. No markdown, no code block, no explanation.\n\n"+
				`Output: {"sourceLanguage":"","targetLanguage":"","translatedText":""}`,
			req.Text,
			lang0.ID, lang0.Label,
			lang1.ID, lang1.Label,
		)

		raw, err := callOpenAI(apiKey, model, detectPrompt)
		if err != nil {
			log.Printf("OpenAI error: %v", err)
			writeError(w, http.StatusBadGateway, "translation failed")
			return
		}
		debugLog("OpenAI 翻訳 生レスポンス: %q", raw)

		type detectResult struct {
			SourceLanguage string `json:"sourceLanguage"`
			TargetLanguage string `json:"targetLanguage"`
			TranslatedText string `json:"translatedText"`
		}
		var dr detectResult
		if err := json.Unmarshal([]byte(extractJSON(raw)), &dr); err != nil {
			log.Printf("JSON parse error: %v | raw: %s", err, raw)
			writeError(w, http.StatusBadGateway, "translation failed")
			return
		}

		log.Printf("detect result: %s -> %s", dr.SourceLanguage, dr.TargetLanguage)

		if dr.SourceLanguage == "unknown" || (dr.SourceLanguage != lang0.ID && dr.SourceLanguage != lang1.ID) {
			log.Printf("language_mismatch: text=%q lang0=%s lang1=%s detected=%q", req.Text, lang0.ID, lang1.ID, dr.SourceLanguage)
			writeError(w, http.StatusUnprocessableEntity, "language_mismatch")
			return
		}

		// Determine src/tgt from detected source
		if dr.SourceLanguage == lang0.ID {
			srcLang, tgtLang = lang0, lang1
		} else {
			srcLang, tgtLang = lang1, lang0
		}

		debugLog("プレースホルダ復元後 翻訳結果: %q", dr.TranslatedText)
		// Back-translate
		debugLog("バックトランスレーション入力: %q", dr.TranslatedText)
		bt, err := callOpenAI(apiKey, model, backTranslatePromptFn(tgtLang.Label, srcLang.Label, srcLang.ID, dr.TranslatedText))
		if err != nil {
			log.Printf("OpenAI back-translation error: %v", err)
			writeError(w, http.StatusBadGateway, "translation failed")
			return
		}
		debugLog("バックトランスレーション 生レスポンス: %q", bt)
		debugLog("プレースホルダ復元後 バックトランスレーション: %q", bt)

		translatedText = dr.TranslatedText
		backTranslation = bt
		ttsText = translatedText
	}

	log.Printf("translate result: %s -> %s", srcLang.ID, tgtLang.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(TranslateResponse{
		SourceLanguage:  srcLang.ID,
		TargetLanguage:  tgtLang.ID,
		TranslatedText:  translatedText,
		BackTranslation: backTranslation,
		TtsText:         ttsText,
	})
}

func main() {
	http.DefaultClient.Timeout = 120 * time.Second

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/api/tts", ttsHandler)
	mux.HandleFunc("/api/interpret", interpretHandler)
	mux.HandleFunc("/api/translate", translateHandler)

	log.Println("Starting server on :8080")
	if err := http.ListenAndServe(":8080", corsMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}
