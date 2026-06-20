package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
)

const (
	defaultModel       = "gpt-4o-mini"
	openAIResponsesURL = "https://api.openai.com/v1/responses"
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

type ErrorResponse struct {
	Error string `json:"error"`
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
			"1. Detect which candidate language the input text is written in. Assign it to sourceLanguage.\n"+
			"2. Translate the input to the other candidate language. Assign to translatedText.\n"+
			"3. Back-translate translatedText into sourceLanguage. Assign to backTranslation.\n\n"+
			"Rules:\n"+
			"- Always assign the input to one of the two candidate languages only.\n"+
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
	mux.HandleFunc("/api/translate", translateHandler)

	log.Println("Starting server on :8080")
	if err := http.ListenAndServe(":8080", corsMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}
