package main

import (
	"bytes"
	"encoding/json"
	"log"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captureLog redirects the standard logger to a buffer for the duration of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(orig) })
	return &buf
}

// assertLogExcludes fails when the captured log contains any of the given strings.
func assertLogExcludes(t *testing.T, logs string, secrets ...string) {
	t.Helper()
	for _, s := range secrets {
		if strings.Contains(logs, s) {
			t.Errorf("log must not contain %q; log:\n%s", s, logs)
		}
	}
}

// assertLogIncludes fails when the captured log does not contain the given string.
func assertLogIncludes(t *testing.T, logs, want string) {
	t.Helper()
	if !strings.Contains(logs, want) {
		t.Errorf("log should contain %q; log:\n%s", want, logs)
	}
}

func postTranslate(t *testing.T, text string, langs string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"text": text, "languages": json.RawMessage(langs)})
	req := httptest.NewRequest(http.MethodPost, "/api/translate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	translateHandler(rec, req)
	return rec
}

const jaEn = `[{"id":"ja","label":"Japanese"},{"id":"en","label":"English"}]`

// The translate handler must not log the text to translate, the translation, the back-translation,
// or OpenAI response bodies, on any path.
func TestLogging_TranslateDoesNotLogUtterance(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("DEBUG_TRANSLATION", "")

	tests := []struct {
		name     string
		text     string
		langs    string
		replies  []string
		status   int
		wantCode int
		wantLog  string
		secrets  []string
	}{
		{
			name:     "protected path success",
			text:     "博多駅で秘密の会議をします",
			langs:    jaEn,
			replies:  []string{openAITextResponse("SECRETOUT at __GT_PROPN_000__ Station"), openAITextResponse("__GT_PROPN_000__駅で SECRETBT")},
			wantCode: http.StatusOK,
			wantLog:  "translate result: ja -> en",
			secrets:  []string{"博多", "秘密の会議", "SECRETOUT", "SECRETBT", "Hakata"},
		},
		{
			name:     "unprotected path success",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{openAITextResponse(`{"sourceLanguage":"en","targetLanguage":"ko","translatedText":"SECRETOUT"}`), openAITextResponse("SECRETBT")},
			wantCode: http.StatusOK,
			wantLog:  "translate result: en -> ko",
			secrets:  []string{"secret plan", "SECRETOUT", "SECRETBT"},
		},
		{
			name:     "JSON parse error",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{openAITextResponse("SECRETOUT is not json {")},
			wantCode: http.StatusBadGateway,
			wantLog:  "JSON parse error: json syntax error",
			secrets:  []string{"secret plan", "SECRETOUT"},
		},
		{
			name:     "language mismatch",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{openAITextResponse(`{"sourceLanguage":"fr","targetLanguage":"en","translatedText":"SECRETOUT"}`)},
			wantCode: http.StatusUnprocessableEntity,
			wantLog:  "language_mismatch: text runes=24",
			secrets:  []string{"secret plan", "SECRETOUT"},
		},
		{
			name:     "OpenAI error body",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{`{"error":{"message":"SECRETBODY the secret plan is ready"}}`},
			status:   http.StatusInternalServerError,
			wantCode: http.StatusBadGateway,
			wantLog:  "OpenAI error: OpenAI API returned status 500",
			secrets:  []string{"secret plan", "SECRETBODY"},
		},
		{
			name:     "unknown language IDs from the client",
			text:     "the secret plan is ready",
			langs:    `[{"id":"EVILLANG","label":"x"},{"id":"en","label":"English"}]`,
			replies:  []string{openAITextResponse(`{"sourceLanguage":"en","targetLanguage":"EVILLANG","translatedText":"SECRETOUT"}`), openAITextResponse("SECRETBT")},
			wantCode: http.StatusOK,
			wantLog:  "lang0=other lang1=en",
			secrets:  []string{"secret plan", "SECRETOUT", "SECRETBT", "EVILLANG"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logs := captureLog(t)
			calls := 0
			setMockTransport(t, func(r *http.Request) (*http.Response, error) {
				reply := tt.replies[len(tt.replies)-1]
				if calls < len(tt.replies) {
					reply = tt.replies[calls]
				}
				calls++
				status := http.StatusOK
				if tt.status != 0 {
					status = tt.status
				}
				return fakeHTTPResponse(status, reply), nil
			})
			rec := postTranslate(t, tt.text, tt.langs)
			if rec.Code != tt.wantCode {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, tt.wantCode, rec.Body.String())
			}
			assertLogIncludes(t, logs.String(), tt.wantLog)
			assertLogExcludes(t, logs.String(), append(tt.secrets, tt.text)...)
		})
	}
}

// buildInterpretRequestFull builds a multipart /api/interpret request with a chosen file name.
func buildInterpretRequestFull(t *testing.T, filename string, fields map[string]string) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("audio", filename)
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("audio"))
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

// The interpret handler must not log the transcript, translations, OpenAI response bodies,
// the file name, or arbitrary speaker / language values sent by the client.
func TestLogging_InterpretDoesNotLogUtterance(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("DEBUG_TRANSLATION", "")
	const ja = `{"id":"ja","label":"Japanese"}`
	const en = `{"id":"en","label":"English"}`

	t.Run("transcript path success", func(t *testing.T) {
		logs := captureLog(t)
		calls := 0
		setMockTransport(t, func(r *http.Request) (*http.Response, error) {
			calls++
			if calls == 1 {
				return fakeHTTPResponse(http.StatusOK, openAITextResponse("SECRETOUT at __GT_PROPN_000__ Station")), nil
			}
			return fakeHTTPResponse(http.StatusOK, openAITextResponse("__GT_PROPN_000__駅で SECRETBT")), nil
		})
		req := buildInterpretRequestFull(t, "secret-file-name.webm", map[string]string{
			"myLanguage": ja, "theirLanguage": en, "speaker": "ja", "transcript": "博多駅で秘密の会議をします",
		})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		got := logs.String()
		assertLogIncludes(t, got, "speaker=ja fileExt=.webm")
		assertLogIncludes(t, got, "interpret: transcript runes=13 src=ja tgt=en")
		assertLogExcludes(t, got, "博多", "秘密の会議", "SECRETOUT", "SECRETBT", "Hakata", "secret-file-name")
	})

	t.Run("invalid speaker and unknown file extension", func(t *testing.T) {
		logs := captureLog(t)
		setMockTransport(t, func(r *http.Request) (*http.Response, error) {
			t.Fatal("OpenAI must not be called")
			return nil, nil
		})
		req := buildInterpretRequestFull(t, "SECRETNAME.exe", map[string]string{
			"myLanguage": ja, "theirLanguage": en, "speaker": "EVILSPEAKER", "transcript": "秘密の会議",
		})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		got := logs.String()
		assertLogIncludes(t, got, "speaker=invalid fileExt=other")
		assertLogExcludes(t, got, "EVILSPEAKER", "SECRETNAME", "秘密の会議")
	})

	t.Run("whisper path success", func(t *testing.T) {
		logs := captureLog(t)
		calls := 0
		setMockTransport(t, func(r *http.Request) (*http.Response, error) {
			calls++
			switch calls {
			case 1:
				return fakeHTTPResponse(http.StatusOK, `{"language":"japanese","text":"SECRETWHISPER1"}`), nil
			case 2:
				return fakeHTTPResponse(http.StatusOK, `{"text":"秘密の音声 SECRETWHISPER2"}`), nil
			case 3:
				return fakeHTTPResponse(http.StatusOK, openAITextResponse("SECRETOUT")), nil
			default:
				return fakeHTTPResponse(http.StatusOK, openAITextResponse("SECRETBT")), nil
			}
		})
		req := buildInterpretRequestFull(t, "recording.webm", map[string]string{"myLanguage": ja, "theirLanguage": en})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		got := logs.String()
		assertLogIncludes(t, got, "Whisper: detectedLang=japanese text runes=")
		assertLogExcludes(t, got, "SECRETWHISPER1", "SECRETWHISPER2", "秘密の音声", "SECRETOUT", "SECRETBT")
	})

	t.Run("whisper error body", func(t *testing.T) {
		logs := captureLog(t)
		setMockTransport(t, func(r *http.Request) (*http.Response, error) {
			return fakeHTTPResponse(http.StatusBadRequest, `{"error":{"message":"SECRETBODY"}}`), nil
		})
		req := buildInterpretRequestFull(t, "recording.webm", map[string]string{"myLanguage": ja, "theirLanguage": en})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		got := logs.String()
		assertLogIncludes(t, got, "Whisper API status 400 (body ")
		assertLogExcludes(t, got, "SECRETBODY")
	})
}

// The TTS handler must not log the OpenAI error response body.
func TestLogging_TTSErrorDoesNotLogBody(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	logs := captureLog(t)
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusBadRequest, `{"error":{"message":"SECRETBODY secret text"}}`), nil
	})
	req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"secret text to speak"}`))
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d", rec.Code)
	}
	got := logs.String()
	assertLogIncludes(t, got, "OpenAI TTS API returned status 400 (body ")
	assertLogExcludes(t, got, "SECRETBODY", "secret text")
}

func TestDebugLog_DisabledUnlessTrue(t *testing.T) {
	for _, v := range []string{"", "false", "1", "TRUE"} {
		t.Run("DEBUG_TRANSLATION="+v, func(t *testing.T) {
			t.Setenv("DEBUG_TRANSLATION", v)
			logs := captureLog(t)
			debugLog("受信テキスト: %q", "秘密の会議")
			if logs.Len() != 0 {
				t.Errorf("debugLog must not output when DEBUG_TRANSLATION=%q; got %q", v, logs.String())
			}
		})
	}
	t.Run("DEBUG_TRANSLATION=true", func(t *testing.T) {
		t.Setenv("DEBUG_TRANSLATION", "true")
		logs := captureLog(t)
		debugLog("受信テキスト: %q", "秘密の会議")
		assertLogIncludes(t, logs.String(), "[DEBUG_TRANSLATION]")
	})
}

func TestJSONErrSummary_DoesNotIncludeInput(t *testing.T) {
	var v map[string]string
	err := json.Unmarshal([]byte("秘"), &v)
	if err == nil {
		t.Fatal("expected error")
	}
	if got := jsonErrSummary(err); strings.Contains(got, "秘") {
		t.Errorf("jsonErrSummary must not include the input: %q", got)
	}
}

func TestLogHelpers(t *testing.T) {
	my := LangInfo{ID: "ja"}
	their := LangInfo{ID: "en"}
	cases := []struct{ got, want string }{
		{logLang("zh-TW"), "zh-TW"},
		{logLang("unknown"), "unknown"},
		{logLang("秘密"), "other"},
		{logSpeaker("en", my, their), "en"},
		{logSpeaker("ko", my, their), "invalid"},
		{logSpeaker("", my, their), "invalid"},
		{logSpeaker("x", LangInfo{ID: "x"}, their), "other"},
		{logDetectedLang("japanese"), "japanese"},
		{logDetectedLang("秘密 text"), "invalid"},
		{logFileExt("recording.MP4"), ".mp4"},
		{logFileExt("secret.txt"), "other"},
		{logFileExt("noext"), "other"},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Errorf("case %d: got %q want %q", i, c.got, c.want)
		}
	}
	if n := logRunes("秘密の会議"); n != 5 {
		t.Errorf("logRunes=%d want 5", n)
	}
}
