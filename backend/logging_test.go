package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"
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
			replies:  []string{`{"error":{"message":"SECRETBODY the secret plan is ready","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}`},
			status:   http.StatusTooManyRequests,
			wantCode: http.StatusBadGateway,
			wantLog:  "OpenAI error: OpenAI API returned status 429 (type=insufficient_quota code=insufficient_quota, body ",
			secrets:  []string{"secret plan", "SECRETBODY"},
		},
		{
			name:     "OpenAI response is not JSON",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{"SECRETRAW this is not json"},
			wantCode: http.StatusBadGateway,
			wantLog:  "OpenAI error: decode OpenAI response: json syntax error at offset",
			secrets:  []string{"secret plan", "SECRETRAW"},
		},
		{
			name:     "OpenAI response has the wrong type",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{`{"output":"SECRETRAW 秘密の応答"}`},
			wantCode: http.StatusBadGateway,
			wantLog:  "OpenAI error: decode OpenAI response: json type error at offset",
			secrets:  []string{"secret plan", "SECRETRAW", "秘密の応答"},
		},
		{
			name:     "OpenAI response is truncated",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{`{"output":[{"content":[{"type":"text","text":"SECRETRAW`},
			wantCode: http.StatusBadGateway,
			wantLog:  "OpenAI error: decode OpenAI response: json decode error: unexpected EOF",
			secrets:  []string{"secret plan", "SECRETRAW"},
		},
		{
			name:     "OpenAI response is empty",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{""},
			wantCode: http.StatusBadGateway,
			wantLog:  "OpenAI error: decode OpenAI response: json decode error: EOF",
			secrets:  []string{"secret plan"},
		},
		{
			name:     "translation JSON has the wrong type",
			text:     "the secret plan is ready",
			langs:    `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`,
			replies:  []string{openAITextResponse(`{"sourceLanguage":123,"targetLanguage":"ko","translatedText":"SECRETOUT"}`)},
			wantCode: http.StatusBadGateway,
			wantLog:  "JSON parse error: json type error at offset",
			secrets:  []string{"secret plan", "SECRETOUT"},
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
			return fakeHTTPResponse(http.StatusBadRequest, `{"error":{"message":"SECRETBODY","type":"invalid_request_error","param":null,"code":null}}`), nil
		})
		req := buildInterpretRequestFull(t, "recording.webm", map[string]string{"myLanguage": ja, "theirLanguage": en})
		rec := httptest.NewRecorder()
		interpretHandler(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		got := logs.String()
		assertLogIncludes(t, got, "Whisper API status 400 (type=invalid_request_error code=none, body ")
		assertLogExcludes(t, got, "SECRETBODY")
	})
}

// Whisper responses that cannot be decoded must not leak their body into the logs.
func TestLogging_InterpretWhisperDecodeErrors(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("DEBUG_TRANSLATION", "")
	tests := []struct {
		name    string
		reply   string
		wantLog string
	}{
		{"not JSON", "SECRETWHISPER 秘密の音声", "Whisper (lang detection) error: decode Whisper response: json syntax error at offset"},
		{"wrong type", `{"language":["SECRETLANG"],"text":"SECRETWHISPER 秘密の音声"}`, "Whisper (lang detection) error: decode Whisper response: json type error at offset"},
		{"truncated", `{"language":"japanese","text":"SECRETWHISPER 秘密の音声`, "Whisper (lang detection) error: decode Whisper response: json decode error: unexpected EOF"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logs := captureLog(t)
			setMockTransport(t, func(r *http.Request) (*http.Response, error) {
				return fakeHTTPResponse(http.StatusOK, tt.reply), nil
			})
			req := buildInterpretRequestFull(t, "recording.webm", map[string]string{
				"myLanguage": `{"id":"ja","label":"Japanese"}`, "theirLanguage": `{"id":"en","label":"English"}`,
			})
			rec := httptest.NewRecorder()
			interpretHandler(rec, req)
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			got := logs.String()
			assertLogIncludes(t, got, tt.wantLog)
			assertLogExcludes(t, got, "SECRETWHISPER", "SECRETLANG", "秘密の音声")
		})
	}
}

func TestOpenAIErrorDetail(t *testing.T) {
	long := strings.Repeat("a", 65)
	tests := []struct {
		name string
		body string
		want string
	}{
		{"type and code", `{"error":{"message":"SECRET input","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}`, "type=insufficient_quota code=insufficient_quota, body "},
		{"code null", `{"error":{"message":"SECRET","type":"invalid_request_error","param":null,"code":null}}`, "type=invalid_request_error code=none, body "},
		{"code missing", `{"error":{"message":"SECRET","type":"server_error"}}`, "type=server_error code=none, body "},
		{"japanese value", `{"error":{"message":"SECRET","type":"秘密","code":"rate_limit_exceeded"}}`, "type=invalid code=rate_limit_exceeded, body "},
		{"value with space", `{"error":{"message":"SECRET","type":"invalid request","code":"x"}}`, "type=invalid code=x, body "},
		{"value too long", `{"error":{"message":"SECRET","type":"` + long + `","code":"x"}}`, "type=invalid code=x, body "},
		{"uppercase value", `{"error":{"message":"SECRET","type":"Invalid","code":"X"}}`, "type=invalid code=invalid, body "},
		{"numeric code", `{"error":{"message":"SECRET","type":"server_error","code":500}}`, "type=server_error code=invalid, body "},
		{"not an error object", `SECRET not json`, "body 15 bytes"},
		{"error is a string", `{"error":"SECRET"}`, "body 18 bytes"},
		{"empty body", ``, "body 0 bytes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := openAIErrorDetail([]byte(tt.body))
			if !strings.HasPrefix(got, tt.want) {
				t.Errorf("got %q want prefix %q", got, tt.want)
			}
			for _, s := range []string{"SECRET", "秘密", "invalid request", long} {
				if strings.Contains(got, s) {
					t.Errorf("must not include %q: %q", s, got)
				}
			}
		})
	}
}

// The TTS handler must not log the OpenAI error response body.
func TestLogging_TTSErrorDoesNotLogBody(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	logs := captureLog(t)
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		return fakeHTTPResponse(http.StatusBadRequest, `{"error":{"message":"SECRETBODY secret text","type":"invalid_request_error","code":"string_above_max_length"}}`), nil
	})
	req := httptest.NewRequest(http.MethodPost, "/api/tts", strings.NewReader(`{"text":"secret text to speak"}`))
	rec := httptest.NewRecorder()
	ttsHandler(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d", rec.Code)
	}
	got := logs.String()
	assertLogIncludes(t, got, "OpenAI TTS API returned status 400 (type=invalid_request_error code=string_above_max_length, body ")
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
	var m map[string]string
	var typed struct {
		SourceLanguage string `json:"sourceLanguage"`
	}
	decode := func(s string) error {
		var v map[string]string
		return json.NewDecoder(strings.NewReader(s)).Decode(&v)
	}
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"syntax error", json.Unmarshal([]byte("秘"), &m), "json syntax error at offset"},
		{"type error", json.Unmarshal([]byte(`{"sourceLanguage":["秘"]}`), &typed), `json type error at offset`},
		{"unexpected EOF", decode(`{"a":"秘`), "json decode error: unexpected EOF"},
		{"EOF", decode(``), "json decode error: EOF"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.err == nil {
				t.Fatal("expected error")
			}
			got := jsonErrSummary(tt.err)
			if !strings.HasPrefix(got, tt.want) {
				t.Errorf("got %q want prefix %q", got, tt.want)
			}
			if strings.Contains(got, "秘") {
				t.Errorf("jsonErrSummary must not include the input: %q", got)
			}
		})
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
		{logDetectedLang("秘密 text"), "other"},
		{logDetectedLang("secretpassword"), "other"},
		{logDetectedLang("ja"), "ja"},
		{logDetectedLang("haitian creole"), "haitian creole"},
		{logDetectedLang("Japanese"), "other"},
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

// countingReader serves size bytes (an error JSON prefix containing a secret, then padding)
// and records how many bytes were read, so tests can check that error bodies are read only
// up to maxErrorBodyBytes.
type countingReader struct {
	data []byte
	pos  int
	read int
}

func newCountingReader(size int) *countingReader {
	prefix := `{"error":{"message":"SECRETBIG","type":"server_error","code":null},"pad":"`
	data := make([]byte, size)
	copy(data, prefix)
	for i := len(prefix); i < size; i++ {
		data[i] = 'x'
	}
	return &countingReader{data: data}
}

func (c *countingReader) Read(p []byte) (int, error) {
	if c.pos >= len(c.data) {
		return 0, io.EOF
	}
	n := copy(p, c.data[c.pos:])
	c.pos += n
	c.read += n
	return n, nil
}

func (c *countingReader) Close() error { return nil }

// OpenAI error bodies larger than maxErrorBodyBytes must be read only up to the limit,
// reported as truncated, and never logged.
func TestErrorBodyReadIsLimited(t *testing.T) {
	const size = 2 << 20 // 2 MiB
	calls := map[string]func() error{
		"callOpenAI": func() error {
			_, err := callOpenAI("test-key", "test-model", "prompt")
			return err
		},
		"callOpenAITTS": func() error {
			_, err := callOpenAITTS("test-key", "test-model", "voice", "text")
			return err
		},
		"callWhisper": func() error {
			_, _, err := callWhisper("test-key", "whisper-1", []byte("audio"), "recording.webm", "", "")
			return err
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			body := newCountingReader(size)
			setMockTransport(t, func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusInternalServerError, Body: body, Header: make(http.Header)}, nil
			})
			err := call()
			if err == nil {
				t.Fatal("expected error")
			}
			if body.read > maxErrorBodyBytes+1 {
				t.Errorf("read %d bytes, want at most %d", body.read, maxErrorBodyBytes+1)
			}
			msg := err.Error()
			if !strings.Contains(msg, fmt.Sprintf("body over %d bytes (truncated)", maxErrorBodyBytes)) {
				t.Errorf("error should report truncation: %q", msg)
			}
			if strings.Contains(msg, "SECRETBIG") || strings.Contains(msg, "server_error") {
				t.Errorf("error must not include the body: %q", msg)
			}
		})
	}
}

func TestReadOpenAIErrorDetail_AtLimit(t *testing.T) {
	// A body of exactly maxErrorBodyBytes is read whole and reported with its size.
	body := newCountingReader(maxErrorBodyBytes)
	got := readOpenAIErrorDetail(body)
	if want := fmt.Sprintf("body %d bytes", maxErrorBodyBytes); got != want {
		t.Errorf("got %q want %q", got, want)
	}
	// A small error body is decoded as before.
	got = readOpenAIErrorDetail(strings.NewReader(`{"error":{"message":"SECRET","type":"server_error","code":null}}`))
	if !strings.HasPrefix(got, "type=server_error code=none, body ") || strings.Contains(got, "SECRET") {
		t.Errorf("unexpected detail: %q", got)
	}
}

// failingReader returns data and then fails, like a connection reset while reading an error body.
type failingReader struct {
	data []byte
	err  error
}

func (f *failingReader) Read(p []byte) (int, error) {
	if len(f.data) == 0 {
		return 0, f.err
	}
	n := copy(p, f.data)
	f.data = f.data[n:]
	return n, nil
}

func (f *failingReader) Close() error { return nil }

// A read error part way through an OpenAI error body is reported as a fixed string with the
// number of bytes read and the error type, without decoding the partial body.
func TestReadOpenAIErrorDetail_ReadError(t *testing.T) {
	partial := `{"error":{"message":"SECRETPART`
	got := readOpenAIErrorDetail(&failingReader{data: []byte(partial), err: syscall.ECONNRESET})
	want := fmt.Sprintf("body read error after %d bytes (syscall.Errno)", len(partial))
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
	if strings.Contains(got, "SECRETPART") || strings.Contains(got, "connection reset") {
		t.Errorf("must not include the body or the error message: %q", got)
	}

	// The same through a handler: the log reports the read error and not the body.
	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("DEBUG_TRANSLATION", "")
	logs := captureLog(t)
	setMockTransport(t, func(r *http.Request) (*http.Response, error) {
		body := &failingReader{data: []byte(`{"error":{"message":"SECRETPART","type":"server_error"`), err: syscall.ECONNRESET}
		return &http.Response{StatusCode: http.StatusInternalServerError, Body: body, Header: make(http.Header)}, nil
	})
	rec := postTranslate(t, "the secret plan is ready", `[{"id":"en","label":"English"},{"id":"ko","label":"Korean"}]`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d", rec.Code)
	}
	assertLogIncludes(t, logs.String(), "OpenAI error: OpenAI API returned status 500 (body read error after ")
	assertLogExcludes(t, logs.String(), "SECRETPART", "server_error", "secret plan")
}

// timeoutErr is a net.Error whose Timeout() is true, wrapped like errors from net/http.
type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout SECRETERR" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

// Read errors are reported with a fixed cause, and type/code are added only when the bytes read
// before the error form a complete OpenAI error object.
func TestReadOpenAIErrorDetail_ReadErrorCauses(t *testing.T) {
	complete := `{"error":{"message":"SECRETMSG","type":"server_error","param":null,"code":null}}`
	partial := `{"error":{"message":"SECRETMSG","type":"server_error"`
	tests := []struct {
		name string
		data string
		err  error
		want string
	}{
		{"unexpected EOF after partial JSON", partial, io.ErrUnexpectedEOF,
			fmt.Sprintf("body read error after %d bytes (unexpected EOF)", len(partial))},
		{"wrapped unexpected EOF", partial, fmt.Errorf("read body: %w", io.ErrUnexpectedEOF),
			fmt.Sprintf("body read error after %d bytes (unexpected EOF)", len(partial))},
		{"timeout", partial, fmt.Errorf("wrapped: %w", timeoutErr{}),
			fmt.Sprintf("body read error after %d bytes (timeout)", len(partial))},
		{"connection reset", partial, syscall.ECONNRESET,
			fmt.Sprintf("body read error after %d bytes (syscall.Errno)", len(partial))},
		{"unexpected EOF after complete JSON", complete, io.ErrUnexpectedEOF,
			fmt.Sprintf("type=server_error code=none, body read error after %d bytes (unexpected EOF)", len(complete))},
		{"timeout after complete JSON", complete, timeoutErr{},
			fmt.Sprintf("type=server_error code=none, body read error after %d bytes (timeout)", len(complete))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := readOpenAIErrorDetail(&failingReader{data: []byte(tt.data), err: tt.err})
			if got != tt.want {
				t.Errorf("got %q want %q", got, tt.want)
			}
			for _, s := range []string{"SECRETMSG", "SECRETERR", "connection reset", "read body"} {
				if strings.Contains(got, s) {
					t.Errorf("must not include %q: %q", s, got)
				}
			}
		})
	}
}

// With a real net/http client, an error body cut off part way (Content-Length short, or a chunked
// body without the final chunk) is reported as "unexpected EOF", and a client timeout as "timeout".
func TestReadOpenAIErrorDetail_RealConnectionErrors(t *testing.T) {
	complete := `{"error":{"message":"SECRETMSG","type":"server_error","param":null,"code":null}}`
	partial := `{"error":{"message":"SECRETMSG","type":"server_`
	tests := []struct {
		name    string
		raw     string
		wait    time.Duration // how long the server keeps the connection open after writing raw
		timeout time.Duration // http.Client.Timeout (0 = none)
		want    string
	}{
		{"content-length short", "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n" + partial, 0, 0,
			fmt.Sprintf("body read error after %d bytes (unexpected EOF)", len(partial))},
		{"chunked cut after complete JSON", "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n" +
			fmt.Sprintf("%x\r\n%s\r\n", len(complete), complete), 0, 0,
			fmt.Sprintf("type=server_error code=none, body read error after %d bytes (unexpected EOF)", len(complete))},
		// The client timeout covers the whole request including the response headers, so it is 1s
		// to leave room for a slow environment, and the server keeps the connection open for 3s,
		// well beyond the timeout. The server stops waiting as soon as the subtest ends (see below),
		// so the longer wait does not make the test slower.
		{"client timeout", "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n" + partial, 3 * time.Second, time.Second,
			fmt.Sprintf("body read error after %d bytes (timeout)", len(partial))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// done is closed when the subtest ends, so the handler stops waiting; started is closed
			// when the handler runs, and exited when it has returned and closed the hijacked connection.
			done := make(chan struct{})
			started := make(chan struct{})
			exited := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				defer close(exited)
				conn, buf, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Errorf("hijack: %v", err)
					return
				}
				defer conn.Close()
				buf.WriteString(tt.raw)
				buf.Flush()
				select {
				case <-done:
				case <-time.After(tt.wait):
				}
			}))
			transport := &http.Transport{}
			// t.Cleanup runs after the subtest function returns. httptest.Server.Close does not
			// wait for handlers of hijacked connections, so the handler is released and awaited first.
			t.Cleanup(func() {
				close(done)
				select {
				case <-started:
					// The handler ran; wait until it has returned.
					select {
					case <-exited:
					case <-time.After(5 * time.Second):
						t.Error("server handler did not return")
					}
				default:
					// The request never reached the handler (for example, client.Get failed early).
				}
				srv.Close()
				transport.CloseIdleConnections()
			})

			client := &http.Client{Timeout: tt.timeout, Transport: transport}
			resp, err := client.Get(srv.URL)
			if err != nil {
				t.Fatalf("client.Get failed before the response body was read "+
					"(the response headers were not received; client timeout %v): %v", tt.timeout, err)
			}
			defer resp.Body.Close()
			got := readOpenAIErrorDetail(resp.Body)
			if got != tt.want {
				t.Errorf("got %q want %q", got, tt.want)
			}
			if strings.Contains(got, "SECRETMSG") {
				t.Errorf("must not include the message: %q", got)
			}
		})
	}
}
