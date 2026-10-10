package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// ─── helpers ─────────────────────────────────────────────────────────────────

// errorBody decodes an error response body.
func errorBody(t *testing.T, rec *httptest.ResponseRecorder) ErrorResponse {
	t.Helper()
	var resp ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("error body is not JSON: %q", rec.Body.String())
	}
	return resp
}

// assertErrorCode checks the status and the "code" field of an error response.
func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, status, rec.Body.String())
	}
	if got := errorBody(t, rec); got.Code != code || got.Error == "" {
		t.Fatalf("body=%+v want code %q and a message", got, code)
	}
}

// failOnOpenAICall makes any OpenAI call fail the test.
func failOnOpenAICall(t *testing.T) {
	t.Helper()
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		t.Error("OpenAI must not be called")
		return nil, errors.New("unexpected call")
	})
}

// responsesRequest is the JSON body sent to the Responses API.
type responsesRequest struct {
	Model           string `json:"model"`
	Input           string `json:"input"`
	MaxOutputTokens *int   `json:"max_output_tokens"`
}

// recordingMock records every OpenAI request and answers with replies[i] (the last reply repeats).
type recordingMock struct {
	urls   []string
	inputs []responsesRequest
}

func newRecordingMock(t *testing.T, replies ...string) *recordingMock {
	t.Helper()
	m := &recordingMock{}
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		m.urls = append(m.urls, r.URL.String())
		if r.URL.String() == openAIResponsesURL {
			var body responsesRequest
			b, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(b, &body); err != nil {
				t.Errorf("Responses request is not JSON: %v", err)
			}
			m.inputs = append(m.inputs, body)
		}
		i := len(m.urls) - 1
		if i >= len(replies) {
			i = len(replies) - 1
		}
		return fakeHTTPResponse(http.StatusOK, replies[i]), nil
	})
	return m
}

func postJSON(handler http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func translateBody(text string) string {
	b, _ := json.Marshal(map[string]any{"text": text, "languages": json.RawMessage(jaEn)})
	return string(b)
}

const enKo = `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`

func translateBodyLangs(text, langs string) string {
	b, _ := json.Marshal(map[string]any{"text": text, "languages": json.RawMessage(langs)})
	return string(b)
}

// buildInterpret builds a multipart /api/interpret request.
func buildInterpret(t *testing.T, audio []byte, fields map[string]string) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("audio", "recording.webm")
	if err != nil {
		t.Fatal(err)
	}
	part.Write(audio)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/interpret", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

const (
	jaLang = `{"id":"ja","label":"Japanese"}`
	enLang = `{"id":"en","label":"English"}`
)

// ─── 5.1 body and input size limits ──────────────────────────────────────────

func TestInputLimits_JSONEndpoints(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	handlers := map[string]http.HandlerFunc{"/api/translate": translateHandler, "/api/tts": ttsHandler}
	for path, h := range handlers {
		t.Run(path, func(t *testing.T) {
			body := func(text string) string {
				if path == "/api/tts" {
					b, _ := json.Marshal(map[string]string{"text": text})
					return string(b)
				}
				return translateBody(text)
			}

			t.Run("501 characters is 400 input_too_large", func(t *testing.T) {
				logs := captureLog(t)
				failOnOpenAICall(t)
				rec := postJSON(h, path, body(strings.Repeat("あ", maxTextRunes+1)))
				assertErrorCode(t, rec, http.StatusBadRequest, codeInputTooLarge)
				assertLogIncludes(t, logs.String(), "limit: endpoint="+path+" limit_type=input_size status=400")
			})

			t.Run("500 characters is accepted", func(t *testing.T) {
				newRecordingMock(t, openAITextResponse(`{"sourceLanguage":"ja","targetLanguage":"en","translatedText":"x"}`))
				rec := postJSON(h, path, body(strings.Repeat("あ", maxTextRunes)))
				if rec.Code == http.StatusBadRequest || rec.Code == http.StatusRequestEntityTooLarge {
					t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
				}
			})

			t.Run("body over 16 KiB is 413", func(t *testing.T) {
				logs := captureLog(t)
				failOnOpenAICall(t)
				// Valid JSON with a long unknown-to-the-limit padding, so that only the size matters.
				big := `{"text":"a","pad":"` + strings.Repeat("x", maxJSONBodyBytes) + `"}`
				rec := postJSON(h, path, big)
				assertErrorCode(t, rec, http.StatusRequestEntityTooLarge, codeInputTooLarge)
				assertLogIncludes(t, logs.String(), "limit: endpoint="+path+" limit_type=input_size status=413")
			})

			t.Run("whitespace after the text keeps the body under 16 KiB", func(t *testing.T) {
				newRecordingMock(t, openAITextResponse(`{"sourceLanguage":"ja","targetLanguage":"en","translatedText":"x"}`))
				b := body("あ")
				b += strings.Repeat(" ", maxJSONBodyBytes-len(b))
				rec := postJSON(h, path, b)
				if rec.Code == http.StatusRequestEntityTooLarge || rec.Code == http.StatusBadRequest {
					t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
				}
			})

			for name, b := range map[string]string{
				"unknown field":        `{"text":"a","speed":2}`,
				"second JSON value":    body("a") + `{"text":"b"}`,
				"trailing garbage":     body("a") + ` x`,
				"not an object":        `"a"`,
				"truncated":            `{"text":"a"`,
				"empty body":           ``,
				"instructions for tts": `{"text":"a","instructions":"shout"}`,
			} {
				t.Run(name+" is 400", func(t *testing.T) {
					failOnOpenAICall(t)
					rec := postJSON(h, path, b)
					assertErrorCode(t, rec, http.StatusBadRequest, codeInvalidRequest)
				})
			}
		})
	}
}

// The frontend sends exactly these fields (frontend/src/pages/InterpreterPage.tsx; the frontend
// tests check the same field lists), and the request structs must accept them with
// DisallowUnknownFields.
func TestInputLimits_FrontendFieldsMatchStructs(t *testing.T) {
	t.Run("translate", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/translate",
			strings.NewReader(`{"text":"こんにちは","languages":[{"id":"ja","label":"Japanese"},{"id":"en","label":"English"}]}`))
		var got TranslateRequest
		if err := decodeJSONBody(req, &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.Text != "こんにちは" || len(got.Languages) != 2 || got.Languages[1].Label != "English" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("tts", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"Konnichiwa"}`))
		var got TTSRequest
		if err := decodeJSONBody(req, &got); err != nil || got.Text != "Konnichiwa" {
			t.Fatalf("got %+v err=%v", got, err)
		}
	})
	t.Run("interpret language fields", func(t *testing.T) {
		var got LangInfo
		dec := json.NewDecoder(strings.NewReader(`{"id":"ja","label":"Japanese"}`))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&got); err != nil || got.ID != "ja" {
			t.Fatalf("got %+v err=%v", got, err)
		}
	})
}

func TestInputLimits_Interpret(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")

	t.Run("body over 1.5 MiB is 413", func(t *testing.T) {
		failOnOpenAICall(t)
		req := buildInterpret(t, bytes.Repeat([]byte{1}, maxInterpretBodyBytes), map[string]string{"myLanguage": jaLang, "theirLanguage": enLang})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		assertErrorCode(t, rec, http.StatusRequestEntityTooLarge, codeInputTooLarge)
	})

	t.Run("audio over 1 MiB is 413", func(t *testing.T) {
		logs := captureLog(t)
		failOnOpenAICall(t)
		req := buildInterpret(t, bytes.Repeat([]byte{1}, maxAudioBytes+1), map[string]string{"myLanguage": jaLang, "theirLanguage": enLang})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		assertErrorCode(t, rec, http.StatusRequestEntityTooLarge, codeInputTooLarge)
		assertLogIncludes(t, logs.String(), "limit: endpoint=/api/interpret limit_type=input_size status=413")
	})

	t.Run("audio of exactly 1 MiB is accepted", func(t *testing.T) {
		newRecordingMock(t, openAITextResponse("x"))
		req := buildInterpret(t, bytes.Repeat([]byte{1}, maxAudioBytes), map[string]string{
			"myLanguage": jaLang, "theirLanguage": enLang, "speaker": "ja", "transcript": "hello",
		})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("transcript over 500 characters is 400", func(t *testing.T) {
		failOnOpenAICall(t)
		req := buildInterpret(t, []byte("audio"), map[string]string{
			"myLanguage": jaLang, "theirLanguage": enLang, "speaker": "ja", "transcript": strings.Repeat("あ", maxTextRunes+1),
		})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		assertErrorCode(t, rec, http.StatusBadRequest, codeInputTooLarge)
	})

	t.Run("transcript of 500 characters with surrounding spaces is accepted", func(t *testing.T) {
		newRecordingMock(t, openAITextResponse("x"))
		req := buildInterpret(t, []byte("audio"), map[string]string{
			"myLanguage": jaLang, "theirLanguage": enLang, "speaker": "en", "transcript": "  " + strings.Repeat("a", maxTextRunes) + "  ",
		})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})
}

// ─── 5.3 max_output_tokens and incomplete responses ─────────────────────────

func TestResponsesAPI_MaxOutputTokensOnEveryCall(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	tests := []struct {
		name    string
		run     func() *httptest.ResponseRecorder
		replies []string
		want    int
	}{
		{"translate unprotected", func() *httptest.ResponseRecorder {
			return postJSON(translateHandler, "/api/translate", translateBodyLangs("hello there", enKo))
		}, []string{openAITextResponse(`{"sourceLanguage":"en","targetLanguage":"ko","translatedText":"x"}`), openAITextResponse("y")}, 2},
		{"translate protected with retries", func() *httptest.ResponseRecorder {
			return postJSON(translateHandler, "/api/translate", translateBody("博多駅に行きます"))
		}, []string{
			openAITextResponse("I go to the station"), openAITextResponse("I go to __GT_PROPN_000__ Station"),
			openAITextResponse("駅に行きます"), openAITextResponse("__GT_PROPN_000__駅に行きます"),
		}, 4},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newRecordingMock(t, tt.replies...)
			rec := tt.run()
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if len(m.inputs) != tt.want {
				t.Fatalf("Responses calls=%d want=%d", len(m.inputs), tt.want)
			}
			for i, in := range m.inputs {
				if in.MaxOutputTokens == nil || *in.MaxOutputTokens != 1024 {
					t.Errorf("call %d: max_output_tokens=%v want 1024", i, in.MaxOutputTokens)
				}
			}
		})
	}
}

func TestCallOpenAI_IncompleteIsFailure(t *testing.T) {
	tests := []struct {
		name, body, want string
	}{
		{"max_output_tokens", `{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"content":[{"type":"output_text","text":"SECRET partial"}]}]}`, "status=incomplete reason=max_output_tokens"},
		{"content_filter", `{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[]}`, "status=incomplete reason=content_filter"},
		{"failed", `{"status":"failed","output":[]}`, "status=failed reason=none"},
		{"odd status", `{"status":"SECRET status","output":[]}`, "status=invalid reason=none"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setMockTransport(t, func(r *http.Request) (*http.Response, error) {
				return fakeHTTPResponse(http.StatusOK, tt.body), nil
			})
			_, err := callOpenAI(context.Background(), "test-key", "m", "prompt")
			if !errors.Is(err, errResponseIncomplete) {
				t.Fatalf("err=%v want errResponseIncomplete", err)
			}
			if !strings.Contains(err.Error(), tt.want) || strings.Contains(err.Error(), "SECRET") {
				t.Fatalf("err=%q want %q and no response content", err, tt.want)
			}
		})
	}

	t.Run("completed is accepted", func(t *testing.T) {
		setMockTransport(t, func(r *http.Request) (*http.Response, error) {
			return fakeHTTPResponse(http.StatusOK, `{"status":"completed","output":[{"content":[{"type":"output_text","text":"ok"}]}]}`), nil
		})
		if got, err := callOpenAI(context.Background(), "test-key", "m", "prompt"); err != nil || got != "ok" {
			t.Fatalf("got %q err=%v", got, err)
		}
	})

	t.Run("translate returns 502 for an incomplete response", func(t *testing.T) {
		t.Setenv("OPENAI_API_KEY", "test-key")
		setMockTransport(t, func(r *http.Request) (*http.Response, error) {
			return fakeHTTPResponse(http.StatusOK, `{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}`), nil
		})
		rec := postJSON(translateHandler, "/api/translate", translateBodyLangs("hello", enKo))
		assertErrorCode(t, rec, http.StatusBadGateway, codeUpstreamError)
	})
}

// The whole Responses input for a 500-character text is measured here (docs/rate-limit-design.md 5.3).
// Token counts are bounded by UTF-8 bytes: the GPT-4o tokenizer (o200k_base) is a byte-level BPE,
// so a text never takes more tokens than bytes. The test fails if a prompt grows past the bound.
func TestResponsesAPI_InputSizeFor500Characters(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	const maxInputBytes = 9000

	// The worst cases for the escaping (%q) and for the proper noun placeholders.
	texts := map[string]string{
		"japanese":                    strings.Repeat("あ", maxTextRunes),
		"thai":                        strings.Repeat("ก", maxTextRunes),
		"non-printable (escaped)":     strings.Repeat("\U0010FFFF", maxTextRunes),
		"quotes (escaped)":            strings.Repeat(`"`, maxTextRunes),
		"proper nouns (placeholders)": strings.Repeat("博多と", maxTextRunes/3) + "博多",
	}
	for name, text := range texts {
		t.Run(name, func(t *testing.T) {
			if n := utf8.RuneCountInString(text); n > maxTextRunes {
				t.Fatalf("test text has %d runes", n)
			}
			// Every reply drops the placeholders, so the protected path makes both retries.
			m := newRecordingMock(t, openAITextResponse(`{"sourceLanguage":"ja","targetLanguage":"en","translatedText":"x"}`))
			postJSON(translateHandler, "/api/translate", translateBody(text))
			if len(m.inputs) == 0 {
				t.Fatal("no Responses call")
			}
			maxBytes, maxRunes := 0, 0
			for _, in := range m.inputs {
				maxBytes = max(maxBytes, len(in.Input))
				maxRunes = max(maxRunes, utf8.RuneCountInString(in.Input))
			}
			t.Logf("%s: calls=%d max input bytes=%d runes=%d", name, len(m.inputs), maxBytes, maxRunes)
			if maxBytes > maxInputBytes {
				t.Errorf("input %d bytes > %d", maxBytes, maxInputBytes)
			}
		})
	}
}

// ─── 5.4 maximum OpenAI calls per request ────────────────────────────────────

func TestMaxOpenAICalls(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	if maxTranslateRequestCalls != 4 || maxInterpretRequestCalls != 6 || maxTTSRequestCalls != 1 || maxTranslationRetries != 1 {
		t.Fatalf("limits changed: translate=%d interpret=%d tts=%d retries=%d",
			maxTranslateRequestCalls, maxInterpretRequestCalls, maxTTSRequestCalls, maxTranslationRetries)
	}
	// The worst case of the protected path: the translation and the back-translation both need their retry.
	protectedReplies := []string{
		openAITextResponse("I go to the station"), openAITextResponse("I go to __GT_PROPN_000__ Station"),
		openAITextResponse("駅に行きます"), openAITextResponse("__GT_PROPN_000__駅に行きます"),
	}

	t.Run("translate worst case", func(t *testing.T) {
		m := newRecordingMock(t, protectedReplies...)
		rec := postJSON(translateHandler, "/api/translate", translateBody("博多駅に行きます"))
		if rec.Code != http.StatusOK || len(m.urls) != maxTranslateRequestCalls {
			t.Fatalf("status=%d calls=%d want %d", rec.Code, len(m.urls), maxTranslateRequestCalls)
		}
	})

	t.Run("translate unprotected path", func(t *testing.T) {
		m := newRecordingMock(t, openAITextResponse(`{"sourceLanguage":"en","targetLanguage":"ko","translatedText":"x"}`), openAITextResponse("y"))
		rec := postJSON(translateHandler, "/api/translate", translateBodyLangs("hello", enKo))
		if rec.Code != http.StatusOK || len(m.urls) != 2 {
			t.Fatalf("status=%d calls=%d want 2", rec.Code, len(m.urls))
		}
	})

	t.Run("interpret without transcript worst case", func(t *testing.T) {
		replies := append([]string{`{"language":"japanese","text":"x"}`, `{"text":"博多駅に行きます"}`}, protectedReplies...)
		m := newRecordingMock(t, replies...)
		req := buildInterpret(t, []byte("audio"), map[string]string{"myLanguage": jaLang, "theirLanguage": enLang})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusOK || len(m.urls) != maxInterpretRequestCalls {
			t.Fatalf("status=%d calls=%d want %d body=%s", rec.Code, len(m.urls), maxInterpretRequestCalls, rec.Body.String())
		}
	})

	t.Run("interpret with transcript worst case", func(t *testing.T) {
		m := newRecordingMock(t, protectedReplies...)
		req := buildInterpret(t, []byte("audio"), map[string]string{
			"myLanguage": jaLang, "theirLanguage": enLang, "speaker": "ja", "transcript": "博多駅に行きます",
		})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusOK || len(m.urls) != maxTranslationCalls {
			t.Fatalf("status=%d calls=%d want %d", rec.Code, len(m.urls), maxTranslationCalls)
		}
	})

	t.Run("tts", func(t *testing.T) {
		m := newRecordingMock(t, "audio")
		rec := postJSON(ttsHandler, "/api/tts", `{"text":"hello"}`)
		if rec.Code != http.StatusOK || len(m.urls) != maxTTSRequestCalls {
			t.Fatalf("status=%d calls=%d", rec.Code, len(m.urls))
		}
	})

	t.Run("the budget stops further calls", func(t *testing.T) {
		m := newRecordingMock(t, openAITextResponse("x"))
		ctx := withCallBudget(context.Background(), 2)
		for i := 0; i < 2; i++ {
			if _, err := callOpenAI(ctx, "k", "m", "p"); err != nil {
				t.Fatalf("call %d: %v", i, err)
			}
		}
		if _, err := callOpenAI(ctx, "k", "m", "p"); !errors.Is(err, errCallLimit) {
			t.Fatalf("err=%v want errCallLimit", err)
		}
		if _, _, err := callWhisper(ctx, "k", "whisper-1", []byte("a"), "a.webm", "", ""); !errors.Is(err, errCallLimit) {
			t.Fatalf("err=%v want errCallLimit", err)
		}
		if _, err := callOpenAITTS(ctx, "k", "m", "v", "t"); !errors.Is(err, errCallLimit) {
			t.Fatalf("err=%v want errCallLimit", err)
		}
		if len(m.urls) != 2 {
			t.Fatalf("calls=%d want 2", len(m.urls))
		}
	})
}

// ─── 5.7 OpenAI errors ───────────────────────────────────────────────────────

func TestOpenAIErrors_Conversion(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	billing := []string{"insufficient_quota", "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
		"credit_balance_exhausted", "organization_usage_limit_exceeded"}

	type endpointCase struct {
		name string
		run  func() *httptest.ResponseRecorder
	}
	endpoints := []endpointCase{
		{"translate", func() *httptest.ResponseRecorder {
			return postJSON(translateHandler, "/api/translate", translateBodyLangs("the SECRET plan", enKo))
		}},
		{"translate protected", func() *httptest.ResponseRecorder {
			return postJSON(translateHandler, "/api/translate", translateBody("博多駅で秘密の会議"))
		}},
		{"tts", func() *httptest.ResponseRecorder {
			return postJSON(ttsHandler, "/api/tts", `{"text":"the SECRET plan"}`)
		}},
		{"interpret whisper", func() *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			interpretHandler(rec, buildInterpret(t, []byte("audio"), map[string]string{"myLanguage": jaLang, "theirLanguage": enLang}))
			return rec
		}},
		{"interpret transcript", func() *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			interpretHandler(rec, buildInterpret(t, []byte("audio"), map[string]string{
				"myLanguage": enLang, "theirLanguage": jaLang, "speaker": "en", "transcript": "the SECRET plan",
			}))
			return rec
		}},
	}

	for _, ep := range endpoints {
		for _, code := range billing {
			t.Run(ep.name+"/"+code, func(t *testing.T) {
				logs := captureLog(t)
				calls := 0
				setMockTransport(t, func(r *http.Request) (*http.Response, error) {
					calls++
					resp := fakeHTTPResponse(http.StatusTooManyRequests,
						`{"error":{"message":"SECRETMSG You exceeded your $10 limit","type":"`+code+`","param":null,"code":"`+code+`"}}`)
					resp.Header.Set("Retry-After", "5")
					return resp, nil
				})
				rec := ep.run()
				assertErrorCode(t, rec, http.StatusServiceUnavailable, codeServiceUnavailable)
				if rec.Header().Get("Retry-After") != "" {
					t.Errorf("Retry-After must not be set for %s", code)
				}
				if strings.Contains(rec.Body.String(), "$") || strings.Contains(rec.Body.String(), code) {
					t.Errorf("body must not show the amount or the OpenAI code: %s", rec.Body.String())
				}
				if calls != 1 {
					t.Errorf("calls=%d want 1 (no retry)", calls)
				}
				assertLogIncludes(t, logs.String(), "limit_type=service_unavailable status=503")
				assertLogExcludes(t, logs.String(), "SECRETMSG", "SECRET plan", "秘密")
			})
		}

		for _, tc := range []struct {
			retryAfter, want string
		}{{"20", "20"}, {"60", "60"}, {"61", ""}, {"", ""}, {"0", ""}, {"soon", ""}} {
			t.Run(fmt.Sprintf("%s/rate limit Retry-After %q", ep.name, tc.retryAfter), func(t *testing.T) {
				logs := captureLog(t)
				calls := 0
				setMockTransport(t, func(r *http.Request) (*http.Response, error) {
					calls++
					resp := fakeHTTPResponse(http.StatusTooManyRequests,
						`{"error":{"message":"SECRETMSG","type":"requests","param":null,"code":"rate_limit_exceeded"}}`)
					if tc.retryAfter != "" {
						resp.Header.Set("Retry-After", tc.retryAfter)
					}
					return resp, nil
				})
				rec := ep.run()
				assertErrorCode(t, rec, http.StatusServiceUnavailable, codeUpstreamBusy)
				if got := rec.Header().Get("Retry-After"); got != tc.want {
					t.Errorf("Retry-After=%q want %q", got, tc.want)
				}
				if calls != 1 {
					t.Errorf("calls=%d want 1 (OpenAI 429 is not retried)", calls)
				}
				assertLogIncludes(t, logs.String(), "limit_type=upstream_busy status=503")
				assertLogExcludes(t, logs.String(), "SECRETMSG")
			})
		}

		t.Run(ep.name+"/other OpenAI error stays 502", func(t *testing.T) {
			setMockTransport(t, func(r *http.Request) (*http.Response, error) {
				return fakeHTTPResponse(http.StatusInternalServerError, `{"error":{"message":"x","type":"server_error","code":null}}`), nil
			})
			rec := ep.run()
			assertErrorCode(t, rec, http.StatusBadGateway, codeUpstreamError)
		})
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	tests := map[string]int{
		"":    0,
		"1":   1,
		"60":  60,
		"61":  0,
		"0":   0,
		"-5":  0,
		"1.2": 2,
		"0.4": 1,
		"abc": 0,
		now.Add(30 * time.Second).Format(http.TimeFormat): 30,
		now.Add(2 * time.Minute).Format(http.TimeFormat):  0,
		now.Add(-time.Minute).Format(http.TimeFormat):     0,
	}
	for in, want := range tests {
		if got := parseRetryAfter(in, now); got != want {
			t.Errorf("parseRetryAfter(%q)=%d want %d", in, got, want)
		}
	}
}

// ─── 5.11 cancellation and deadlines ─────────────────────────────────────────

// cancelOnFirstCall returns a request context and a mock that cancels it during the first OpenAI
// call, and counts the calls.
func cancelOnFirstCall(t *testing.T, reply string) (context.Context, *int) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	calls := 0
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		calls++
		cancel()
		return fakeHTTPResponse(http.StatusOK, reply), nil
	})
	return ctx, &calls
}

func TestCancellation_StopsFurtherOpenAICalls(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	tests := []struct {
		name  string
		reply string
		req   func(t *testing.T) *http.Request
		h     http.HandlerFunc
	}{
		{"translate unprotected", openAITextResponse(`{"sourceLanguage":"en","targetLanguage":"ko","translatedText":"x"}`), func(t *testing.T) *http.Request {
			return httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(translateBodyLangs("hello", enKo)))
		}, translateHandler},
		{"translate protected", openAITextResponse("I go to the station"), func(t *testing.T) *http.Request {
			return httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(translateBody("博多駅に行きます")))
		}, translateHandler},
		{"interpret after language detection", `{"language":"japanese","text":"x"}`, func(t *testing.T) *http.Request {
			return buildInterpret(t, []byte("audio"), map[string]string{"myLanguage": jaLang, "theirLanguage": enLang})
		}, interpretHandler},
		{"interpret transcript", openAITextResponse("x"), func(t *testing.T) *http.Request {
			return buildInterpret(t, []byte("audio"), map[string]string{"myLanguage": enLang, "theirLanguage": jaLang, "speaker": "en", "transcript": "hello"})
		}, interpretHandler},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logs := captureLog(t)
			ctx, calls := cancelOnFirstCall(t, tt.reply)
			req := tt.req(t).WithContext(ctx)
			if req.Header.Get("Content-Type") == "" {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			tt.h(rec, req)
			if *calls != 1 {
				t.Fatalf("OpenAI calls=%d want 1 (no call after the cancellation)", *calls)
			}
			if rec.Body.Len() != 0 {
				t.Errorf("no response should be written for a canceled request, got %d %s", rec.Code, rec.Body.String())
			}
			assertLogIncludes(t, logs.String(), "limit_type=canceled status=none")
		})
	}

	t.Run("already canceled before the first call", func(t *testing.T) {
		failOnOpenAICall(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"hello"}`)).WithContext(ctx)
		rec := httptest.NewRecorder()
		ttsHandler(rec, req)
		if rec.Body.Len() != 0 {
			t.Errorf("got %d %s", rec.Code, rec.Body.String())
		}
	})
}

// blockUntilCanceled makes every OpenAI call wait until its request context ends.
func blockUntilCanceled(t *testing.T) *int {
	t.Helper()
	calls := 0
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		calls++
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	return &calls
}

func TestDeadline_Returns504(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	for _, d := range []*time.Duration{&interpretDeadline, &translateDeadline, &ttsDeadline} {
		orig := *d
		*d = 50 * time.Millisecond
		t.Cleanup(func() { *d = orig })
	}
	tests := map[string]func() *httptest.ResponseRecorder{
		"translate": func() *httptest.ResponseRecorder {
			return postJSON(translateHandler, "/api/translate", translateBodyLangs("hello", enKo))
		},
		"tts": func() *httptest.ResponseRecorder { return postJSON(ttsHandler, "/api/tts", `{"text":"hello"}`) },
		"interpret": func() *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			interpretHandler(rec, buildInterpret(t, []byte("audio"), map[string]string{"myLanguage": jaLang, "theirLanguage": enLang}))
			return rec
		},
	}
	for name, run := range tests {
		t.Run(name, func(t *testing.T) {
			logs := captureLog(t)
			calls := blockUntilCanceled(t)
			rec := run()
			assertErrorCode(t, rec, http.StatusGatewayTimeout, codeTimeout)
			if *calls != 1 {
				t.Errorf("calls=%d want 1", *calls)
			}
			assertLogIncludes(t, logs.String(), "limit_type=timeout status=504")
		})
	}
}

func TestDeadlines(t *testing.T) {
	if interpretDeadline != 55*time.Second || translateDeadline != 25*time.Second || ttsDeadline != 25*time.Second {
		t.Fatalf("deadlines: interpret=%v translate=%v tts=%v", interpretDeadline, translateDeadline, ttsDeadline)
	}
	// Backend < nginx (60s) < frontend, and the write timeout covers the longest deadline.
	if interpretDeadline >= 60*time.Second || serverWriteTimeout <= interpretDeadline {
		t.Fatalf("interpretDeadline=%v serverWriteTimeout=%v", interpretDeadline, serverWriteTimeout)
	}
}

// The OpenAI requests carry the handler's deadline and go through openAIClient, not http.DefaultClient.
func TestOpenAIClient(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	if openAIClient == http.DefaultClient || openAIClient.Timeout != 120*time.Second {
		t.Fatalf("openAIClient must be a dedicated client with a 120s timeout")
	}
	orig := http.DefaultClient.Transport
	http.DefaultClient.Transport = &mockTransport{fn: func(r *http.Request) (*http.Response, error) {
		t.Error("http.DefaultClient must not be used")
		return nil, errors.New("default client")
	}}
	t.Cleanup(func() { http.DefaultClient.Transport = orig })

	var deadlines []time.Duration
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		dl, ok := r.Context().Deadline()
		if !ok {
			t.Error("OpenAI request has no deadline")
		}
		deadlines = append(deadlines, time.Until(dl))
		if r.URL.String() == openAITTSURL {
			return fakeHTTPResponse(http.StatusOK, "audio"), nil
		}
		return fakeHTTPResponse(http.StatusOK, openAITextResponse(`{"sourceLanguage":"en","targetLanguage":"ko","translatedText":"x"}`)), nil
	})
	postJSON(translateHandler, "/api/translate", translateBodyLangs("hello", enKo))
	postJSON(ttsHandler, "/api/tts", `{"text":"hello"}`)
	if len(deadlines) != 3 {
		t.Fatalf("calls=%d want 3", len(deadlines))
	}
	for _, d := range deadlines {
		if d <= 0 || d > 25*time.Second {
			t.Errorf("deadline in %v, want within 25s", d)
		}
	}
}

// ─── 5.9 CORS and 5.10 the HTTP server ───────────────────────────────────────

func TestNoCORSHeaders(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	mux := newMux()
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{http.MethodGet, "/health", http.StatusOK},
		{http.MethodPost, "/api/translate", http.StatusInternalServerError},
		{http.MethodOptions, "/api/translate", http.StatusMethodNotAllowed},
		{http.MethodOptions, "/api/interpret", http.StatusMethodNotAllowed},
		{http.MethodOptions, "/api/tts", http.StatusMethodNotAllowed},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
		req.Header.Set("Origin", "https://evil.example")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != tc.status {
			t.Errorf("%s %s: status=%d want %d", tc.method, tc.path, rec.Code, tc.status)
		}
		for k := range rec.Header() {
			if strings.HasPrefix(k, "Access-Control-") {
				t.Errorf("%s %s: unexpected header %s", tc.method, tc.path, k)
			}
		}
	}
}

func TestNewServer(t *testing.T) {
	srv := newServer(":8080", newMux())
	if srv.ReadHeaderTimeout != 10*time.Second || srv.ReadTimeout != 30*time.Second ||
		srv.WriteTimeout != 90*time.Second || srv.IdleTimeout != 60*time.Second || srv.MaxHeaderBytes != 16<<10 {
		t.Fatalf("server settings: %+v", srv)
	}
	if shutdownTimeout != 25*time.Second {
		t.Fatalf("shutdownTimeout=%v", shutdownTimeout)
	}
}

func TestRunServer_GracefulShutdown(t *testing.T) {
	for _, tc := range []struct {
		name        string
		handlerWait time.Duration
		timeout     time.Duration
		wantOK      bool // the in-flight request completes
	}{
		{"in-flight request finishes", 200 * time.Millisecond, 5 * time.Second, true},
		{"connections closed after the timeout", 5 * time.Second, 200 * time.Millisecond, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			release := make(chan struct{})
			t.Cleanup(func() { close(release) })
			srv := newServer("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				select {
				case <-time.After(tc.handlerWait):
				case <-release:
				}
				io.WriteString(w, "done")
			}))
			ctx, stop := context.WithCancel(context.Background())
			runErr := make(chan error, 1)
			go func() { runErr <- runServer(ctx, srv, func() error { return srv.Serve(ln) }, tc.timeout) }()

			type result struct {
				body string
				err  error
			}
			resCh := make(chan result, 1)
			go func() {
				resp, err := http.Get("http://" + ln.Addr().String() + "/")
				if err != nil {
					resCh <- result{err: err}
					return
				}
				defer resp.Body.Close()
				b, err := io.ReadAll(resp.Body)
				resCh <- result{string(b), err}
			}()
			<-started
			stop()

			select {
			case err := <-runErr:
				if err != nil {
					t.Fatalf("runServer: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("runServer did not return")
			}
			res := <-resCh
			if tc.wantOK && (res.err != nil || res.body != "done") {
				t.Fatalf("in-flight request: body=%q err=%v", res.body, res.err)
			}
			if !tc.wantOK && res.err == nil && res.body == "done" {
				t.Fatal("the request should have been cut off")
			}
		})
	}
}

// ─── logging ─────────────────────────────────────────────────────────────────

// The new limit logs never contain the request content.
func TestLogging_LimitsDoNotLogContent(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	logs := captureLog(t)
	failOnOpenAICall(t)
	secret := "SECRETTEXT" + strings.Repeat("秘", maxTextRunes)
	postJSON(translateHandler, "/api/translate", translateBody(secret))
	postJSON(ttsHandler, "/api/tts", `{"text":"`+secret+`"}`)
	rec := httptest.NewRecorder()
	interpretHandler(rec, buildInterpret(t, []byte("SECRETAUDIO"), map[string]string{
		"myLanguage": jaLang, "theirLanguage": enLang, "speaker": "ja", "transcript": secret,
	}))
	assertLogIncludes(t, logs.String(), "limit: endpoint=/api/interpret limit_type=input_size status=400")
	assertLogExcludes(t, logs.String(), "SECRETTEXT", "秘", "SECRETAUDIO")
}
