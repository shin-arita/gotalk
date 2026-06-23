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
}

type InterpretResponse struct {
	Text            string `json:"text"`
	SourceLanguage  string `json:"sourceLanguage"`
	TargetLanguage  string `json:"targetLanguage"`
	TranslatedText  string `json:"translatedText"`
	BackTranslation string `json:"backTranslation"`
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

// callWhisper transcribes audio via OpenAI and returns the text and detected language.
// whisper-1 supports verbose_json (includes language); gpt-4o-transcribe only supports json (no language field).
func callWhisper(apiKey, model string, audioData []byte, filename string) (text, lang string, err error) {
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
	log.Printf("interpret: myLang=%s theirLang=%s speaker=%q file=%s size=%d",
		myLang.ID, theirLang.ID, speaker, fileHeader.Filename, len(audioData))

	// Step 1: language detection via whisper-1 (audio-based, sequential).
	_, detectedLang, err := callWhisper(apiKey, langDetectionModel, audioData, fileHeader.Filename)
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

	// Step 2: match against selected languages. Bail out early on mismatch.
	var srcLang, tgtLang LangInfo
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

	// Step 3: transcription via gpt-4o-transcribe (called only when language matched).
	txModel := os.Getenv("WHISPER_MODEL")
	if txModel == "" {
		txModel = defaultWhisperModel
	}
	transcribedText, _, err := callWhisper(apiKey, txModel, audioData, fileHeader.Filename)
	if err != nil {
		log.Printf("Whisper (transcription) error: %v", err)
		writeError(w, http.StatusBadGateway, "transcription failed")
		return
	}
	log.Printf("Whisper: detectedLang=%q text=%q", detectedLang, transcribedText)

	prompt := fmt.Sprintf(
		"Translate the following %s text into %s (%s).\n"+
			"Also back-translate the result into %s (%s).\n\n"+
			"Text: %q\n\n"+
			"Rules:\n"+
			"- Return ONLY a single-line JSON object. No markdown, no code block, no explanation.\n\n"+
			`Output: {"translatedText":"","backTranslation":""}`,
		srcLang.Label,
		tgtLang.Label, tgtLang.ID,
		srcLang.Label, srcLang.ID,
		transcribedText,
	)

	raw, err := callOpenAI(apiKey, model, prompt)
	if err != nil {
		log.Printf("OpenAI error: %v", err)
		writeError(w, http.StatusBadGateway, "translation failed")
		return
	}

	var result struct {
		TranslatedText  string `json:"translatedText"`
		BackTranslation string `json:"backTranslation"`
	}
	if err := json.Unmarshal([]byte(extractJSON(raw)), &result); err != nil {
		log.Printf("JSON parse error: %v | raw: %s", err, raw)
		writeError(w, http.StatusBadGateway, "translation failed")
		return
	}

	log.Printf("interpret result: %s -> %s", srcLang.ID, tgtLang.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(InterpretResponse{
		Text:            transcribedText,
		SourceLanguage:  srcLang.ID,
		TargetLanguage:  tgtLang.ID,
		TranslatedText:  result.TranslatedText,
		BackTranslation: result.BackTranslation,
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

	prompt := fmt.Sprintf(
		"You are a translation assistant.\n\n"+
			"Input text: %q\n"+
			"Candidate languages: %q (%s) and %q (%s)\n\n"+
			"Instructions:\n"+
			"1. Determine whether the input text is written in one of the two candidate languages.\n"+
			"   - If yes, assign that language ID to sourceLanguage.\n"+
			"   - If no (the text is in a different language or unrecognisable), set sourceLanguage to \"unknown\" and leave the other fields empty.\n"+
			"2. If sourceLanguage is known, translate the input to the other candidate language. Assign to translatedText.\n"+
			"3. If sourceLanguage is known, back-translate translatedText into sourceLanguage. Assign to backTranslation.\n\n"+
			"Rules:\n"+
			"- Do NOT force the input into a candidate language if it clearly belongs to neither.\n"+
			"- Use language IDs (not labels) for sourceLanguage and targetLanguage.\n"+
			"- Return ONLY a single-line JSON object. No markdown, no code block, no explanation.\n\n"+
			`Output: {"sourceLanguage":"","targetLanguage":"","translatedText":"","backTranslation":""}`,
		req.Text,
		lang0.ID, lang0.Label,
		lang1.ID, lang1.Label,
	)

	raw, err := callOpenAI(apiKey, model, prompt)
	if err != nil {
		log.Printf("OpenAI error: %v", err)
		writeError(w, http.StatusBadGateway, "translation failed")
		return
	}

	type translationResult struct {
		SourceLanguage  string `json:"sourceLanguage"`
		TargetLanguage  string `json:"targetLanguage"`
		TranslatedText  string `json:"translatedText"`
		BackTranslation string `json:"backTranslation"`
	}

	var result translationResult
	if err := json.Unmarshal([]byte(extractJSON(raw)), &result); err != nil {
		log.Printf("JSON parse error: %v | raw: %s", err, raw)
		writeError(w, http.StatusBadGateway, "translation failed")
		return
	}

	log.Printf("result: %s -> %s", result.SourceLanguage, result.TargetLanguage)

	if result.SourceLanguage == "unknown" || (result.SourceLanguage != lang0.ID && result.SourceLanguage != lang1.ID) {
		log.Printf("language_mismatch: text=%q lang0=%s lang1=%s detected=%q", req.Text, lang0.ID, lang1.ID, result.SourceLanguage)
		writeError(w, http.StatusUnprocessableEntity, "language_mismatch")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(TranslateResponse{
		SourceLanguage:  result.SourceLanguage,
		TargetLanguage:  result.TargetLanguage,
		TranslatedText:  result.TranslatedText,
		BackTranslation: result.BackTranslation,
	})
}

func main() {
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
