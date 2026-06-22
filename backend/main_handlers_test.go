package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// mockTransport intercepts http.DefaultClient calls without modifying main.go.
type mockTransport struct {
	fn func(*http.Request) (*http.Response, error)
}

func (m *mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return m.fn(req)
}

func setMockTransport(t *testing.T, fn func(*http.Request) (*http.Response, error)) {
	t.Helper()
	orig := http.DefaultClient.Transport
	http.DefaultClient.Transport = &mockTransport{fn: fn}
	t.Cleanup(func() { http.DefaultClient.Transport = orig })
}

func fakeHTTPResponse(statusCode int, body string) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func openAITextResponse(text string) string {
	return fmt.Sprintf(`{"output":[{"content":[{"type":"text","text":%s}]}]}`, jsonString(text))
}

func buildInterpretRequest(audioData []byte, includeAudio bool, myLang, theirLang string) (*http.Request, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if includeAudio {
		part, err := mw.CreateFormFile("audio", "test.webm")
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(audioData); err != nil {
			return nil, err
		}
	}
	if myLang != "" {
		if err := mw.WriteField("myLanguage", myLang); err != nil {
			return nil, err
		}
	}
	if theirLang != "" {
		if err := mw.WriteField("theirLanguage", theirLang); err != nil {
			return nil, err
		}
	}
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/interpret", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req, nil
}

// ─── ttsHandler ──────────────────────────────────────────────────────────────

func TestTTSHandler_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/tts", nil)
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestTTSHandler_NoAPIKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusInternalServerError)
	}
}

func TestTTSHandler_InvalidJSON(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`not json`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestTTSHandler_EmptyText(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"  "}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestTTSHandler_OpenAIError(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("network error")
	})
	req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadGateway)
	}
}

func TestTTSHandler_OpenAINonOKStatus(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusUnauthorized, `{"error":"unauthorized"}`), nil
	})
	req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadGateway)
	}
}

func TestTTSHandler_Success(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	audioBytes := []byte("fake mp3 audio data")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		resp := fakeHTTPResponse(http.StatusOK, string(audioBytes))
		resp.Header.Set("Content-Type", "audio/mpeg")
		return resp, nil
	})
	req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/mpeg" {
		t.Fatalf("Content-Type=%q want=%q", ct, "audio/mpeg")
	}
	if !bytes.Equal(rec.Body.Bytes(), audioBytes) {
		t.Fatal("unexpected audio body")
	}
}

// ─── callOpenAITTS ───────────────────────────────────────────────────────────

func TestCallOpenAITTS_Success(t *testing.T) {
	audioBytes := []byte("fake audio data")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, string(audioBytes)), nil
	})
	got, err := callOpenAITTS("test-key", "gpt-4o-mini-tts", "marin", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, audioBytes) {
		t.Fatal("unexpected audio data")
	}
}

func TestCallOpenAITTS_TransportError(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("network error")
	})
	_, err := callOpenAITTS("test-key", "gpt-4o-mini-tts", "marin", "hello")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCallOpenAITTS_NonOKStatus(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusUnauthorized, `{"error":"unauthorized"}`), nil
	})
	_, err := callOpenAITTS("test-key", "gpt-4o-mini-tts", "marin", "hello")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

// ─── translateHandler ────────────────────────────────────────────────────────

func TestTranslateHandler_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/translate", nil)
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestTranslateHandler_NoAPIKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusInternalServerError)
	}
}

func TestTranslateHandler_InvalidJSON(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(`not json`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestTranslateHandler_EmptyText(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	body := `{"text":"  ","languages":[{"id":"ja","label":"Japanese"},{"id":"en","label":"English"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestTranslateHandler_TooFewLanguages(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	body := `{"text":"hello","languages":[{"id":"ja","label":"Japanese"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestTranslateHandler_CallOpenAIError(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("network error")
	})
	body := `{"text":"こんにちは","languages":[{"id":"ja","label":"Japanese"},{"id":"en","label":"English"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadGateway)
	}
}

func TestTranslateHandler_InvalidTranslationJSON(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, openAITextResponse("not valid json at all")), nil
	})
	body := `{"text":"こんにちは","languages":[{"id":"ja","label":"Japanese"},{"id":"en","label":"English"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadGateway)
	}
}

func TestTranslateHandler_LanguageMismatch_Unknown(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		result := `{"sourceLanguage":"unknown","targetLanguage":"","translatedText":"","backTranslation":""}`
		return fakeHTTPResponse(http.StatusOK, openAITextResponse(result)), nil
	})
	body := `{"text":"hello","languages":[{"id":"ja","label":"Japanese"},{"id":"en","label":"English"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusUnprocessableEntity)
	}
}

func TestTranslateHandler_LanguageMismatch_NotInLangs(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		result := `{"sourceLanguage":"zh","targetLanguage":"en","translatedText":"Hello","backTranslation":"你好"}`
		return fakeHTTPResponse(http.StatusOK, openAITextResponse(result)), nil
	})
	body := `{"text":"你好","languages":[{"id":"ja","label":"Japanese"},{"id":"en","label":"English"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusUnprocessableEntity)
	}
}

func TestTranslateHandler_Success(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		result := `{"sourceLanguage":"ja","targetLanguage":"en","translatedText":"Hello","backTranslation":"こんにちは"}`
		return fakeHTTPResponse(http.StatusOK, openAITextResponse(result)), nil
	})
	body := `{"text":"こんにちは","languages":[{"id":"ja","label":"Japanese"},{"id":"en","label":"English"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var resp TranslateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.SourceLanguage != "ja" || resp.TranslatedText != "Hello" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

// ─── interpretHandler ─────────────────────────────────────────────────────────

func TestInterpretHandler_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/interpret", nil)
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestInterpretHandler_NoAPIKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	req := httptest.NewRequest(http.MethodPost, "/api/interpret", nil)
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusInternalServerError)
	}
}

func TestInterpretHandler_InvalidMultipart(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req := httptest.NewRequest(http.MethodPost, "/api/interpret", strings.NewReader("not multipart"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestInterpretHandler_NoAudio(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req, err := buildInterpretRequest(nil, false, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestInterpretHandler_InvalidMyLanguage(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req, err := buildInterpretRequest([]byte("audio"), true, "not-json", `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestInterpretHandler_EmptyMyLanguageID(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestInterpretHandler_InvalidTheirLanguage(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, "not-json")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestInterpretHandler_EmptyTheirLanguageID(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestInterpretHandler_WhisperLangDetectionError(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("network error")
	})
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadGateway, rec.Body.String())
	}
}

func TestInterpretHandler_WhisperEmptyLang(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, `{"language":"","text":"こんにちは"}`), nil
	})
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadGateway, rec.Body.String())
	}
}

func TestInterpretHandler_LanguageMismatch(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, `{"language":"chinese","text":"你好"}`), nil
	})
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusUnprocessableEntity, rec.Body.String())
	}
}

func TestInterpretHandler_TranscriptionError(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	callCount := 0
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		callCount++
		if callCount == 1 {
			return fakeHTTPResponse(http.StatusOK, `{"language":"japanese","text":"こんにちは"}`), nil
		}
		return nil, fmt.Errorf("transcription error")
	})
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadGateway, rec.Body.String())
	}
}

func TestInterpretHandler_TranslationError(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	callCount := 0
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		callCount++
		switch callCount {
		case 1:
			return fakeHTTPResponse(http.StatusOK, `{"language":"japanese","text":"こんにちは"}`), nil
		case 2:
			return fakeHTTPResponse(http.StatusOK, `{"language":"","text":"こんにちは"}`), nil
		default:
			return nil, fmt.Errorf("openai error")
		}
	})
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadGateway, rec.Body.String())
	}
}

func TestInterpretHandler_InvalidTranslationJSON(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	callCount := 0
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		callCount++
		switch callCount {
		case 1:
			return fakeHTTPResponse(http.StatusOK, `{"language":"japanese","text":"こんにちは"}`), nil
		case 2:
			return fakeHTTPResponse(http.StatusOK, `{"language":"","text":"こんにちは"}`), nil
		default:
			return fakeHTTPResponse(http.StatusOK, openAITextResponse("not valid json")), nil
		}
	})
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusBadGateway, rec.Body.String())
	}
}

func TestInterpretHandler_Success_MyLangMatch(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	callCount := 0
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		callCount++
		switch callCount {
		case 1:
			return fakeHTTPResponse(http.StatusOK, `{"language":"japanese","text":"こんにちは"}`), nil
		case 2:
			return fakeHTTPResponse(http.StatusOK, `{"language":"","text":"こんにちは"}`), nil
		default:
			result := `{"translatedText":"Hello","backTranslation":"こんにちは"}`
			return fakeHTTPResponse(http.StatusOK, openAITextResponse(result)), nil
		}
	})
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var resp InterpretResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.SourceLanguage != "ja" || resp.TargetLanguage != "en" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestInterpretHandler_Success_TheirLangMatch(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	callCount := 0
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		callCount++
		switch callCount {
		case 1:
			return fakeHTTPResponse(http.StatusOK, `{"language":"english","text":"Hello"}`), nil
		case 2:
			return fakeHTTPResponse(http.StatusOK, `{"language":"","text":"Hello"}`), nil
		default:
			result := `{"translatedText":"こんにちは","backTranslation":"Hello"}`
			return fakeHTTPResponse(http.StatusOK, openAITextResponse(result)), nil
		}
	})
	req, err := buildInterpretRequest([]byte("audio"), true, `{"id":"ja","label":"Japanese"}`, `{"id":"en","label":"English"}`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	interpretHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var resp InterpretResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.SourceLanguage != "en" || resp.TargetLanguage != "ja" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

// ─── callOpenAI ──────────────────────────────────────────────────────────────

func TestCallOpenAI_TransportError(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("connection refused")
	})
	_, err := callOpenAI("test-key", "gpt-4o-mini", "hello")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCallOpenAI_NonOKStatus(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusUnauthorized, `{"error":"unauthorized"}`), nil
	})
	_, err := callOpenAI("test-key", "gpt-4o-mini", "hello")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCallOpenAI_InvalidJSON(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, `not json`), nil
	})
	_, err := callOpenAI("test-key", "gpt-4o-mini", "hello")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCallOpenAI_EmptyOutput(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, `{"output":[]}`), nil
	})
	_, err := callOpenAI("test-key", "gpt-4o-mini", "hello")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCallOpenAI_EmptyContent(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, `{"output":[{"content":[]}]}`), nil
	})
	_, err := callOpenAI("test-key", "gpt-4o-mini", "hello")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCallOpenAI_Success(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, openAITextResponse("  hello world  ")), nil
	})
	got, err := callOpenAI("test-key", "gpt-4o-mini", "translate this")
	if err != nil {
		t.Fatal(err)
	}
	if got != "hello world" {
		t.Fatalf("got=%q want=%q", got, "hello world")
	}
}

// ─── callWhisper ─────────────────────────────────────────────────────────────

func TestCallWhisper_Whisper1_Success(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, `{"language":"japanese","text":"こんにちは"}`), nil
	})
	text, lang, err := callWhisper("test-key", "whisper-1", []byte("fake audio"), "test.webm")
	if err != nil {
		t.Fatal(err)
	}
	if text != "こんにちは" || lang != "japanese" {
		t.Fatalf("text=%q lang=%q", text, lang)
	}
}

func TestCallWhisper_GPT4oTranscribe_Success(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, `{"text":"hello","language":""}`), nil
	})
	text, _, err := callWhisper("test-key", "gpt-4o-transcribe", []byte("fake audio"), "test.webm")
	if err != nil {
		t.Fatal(err)
	}
	if text != "hello" {
		t.Fatalf("text=%q", text)
	}
}

func TestCallWhisper_NonOKStatus(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusUnauthorized, `{"error":"unauthorized"}`), nil
	})
	_, _, err := callWhisper("test-key", "whisper-1", []byte("fake audio"), "test.webm")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCallWhisper_InvalidJSON(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusOK, `not json`), nil
	})
	_, _, err := callWhisper("test-key", "whisper-1", []byte("fake audio"), "test.webm")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCallWhisper_TransportError(t *testing.T) {
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("network error")
	})
	_, _, err := callWhisper("test-key", "whisper-1", []byte("fake audio"), "test.webm")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}
