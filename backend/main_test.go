package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWhisperLangMatches(t *testing.T) {
	tests := []struct {
		name string
		wl   string
		app  string
		want bool
	}{
		{"ja exact", "ja", "ja", true},
		{"japanese name", "japanese", "ja", true},
		{"thai name", "thai", "th", true},
		{"zh tw", "zh", "zh-TW", true},
		{"zh cn", "zh", "zh-CN", true},
		{"vietnamese name", "vietnamese", "vi", true},
		{"vi exact", "vi", "vi", true},
		{"english mismatch", "en", "ja", false},
		{"empty whisper", "", "ja", false},
		{"empty app", "ja", "", false},
		{"both empty", "", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := whisperLangMatches(tt.wl, tt.app)
			if got != tt.want {
				t.Fatalf("got=%v want=%v", got, tt.want)
			}
		})
	}
}

func TestExtractJSON(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "json only",
			in:   `{"text":"hello"}`,
			want: `{"text":"hello"}`,
		},
		{
			name: "markdown code fence",
			in:   "```json\n{\"text\":\"hello\"}\n```",
			want: `{"text":"hello"}`,
		},
		{
			name: "text before and after json",
			in:   "result: {\"text\":\"hello\"} done",
			want: `{"text":"hello"}`,
		},
		{
			name: "no json",
			in:   "hello",
			want: "hello",
		},
		{
			name: "missing closing brace",
			in:   "hello {",
			want: "hello {",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractJSON(tt.in)
			if got != tt.want {
				t.Fatalf("got=%q want=%q", got, tt.want)
			}
		})
	}
}

func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	healthHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("Content-Type=%q want application/json", ct)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"status":"ok"}` {
		t.Fatalf("body=%q want=%q", got, `{"status":"ok"}`)
	}
}

func TestWriteError(t *testing.T) {
	rec := httptest.NewRecorder()

	writeError(rec, http.StatusBadRequest, "bad request")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusBadRequest)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type=%q want=%q", got, "application/json")
	}
	if !strings.Contains(rec.Body.String(), `"error":"bad request"`) {
		t.Fatalf("body=%q", rec.Body.String())
	}
}

func TestCorsMiddleware(t *testing.T) {
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusCreated)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()

	corsMiddleware(next).ServeHTTP(rec, req)

	if !nextCalled {
		t.Fatal("next handler was not called")
	}
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusCreated)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("allow-origin=%q want=%q", got, "*")
	}
}

// TestExtractProperNouns_KatakanaPersonName verifies that a katakana given name immediately
// following a kanji surname is protected. Kagome often does not classify short katakana names
// (e.g. シン) as 固有名詞, so the compound logic must merge them with the preceding surname.
func TestExtractProperNouns_KatakanaPersonName(t *testing.T) {
	entries, err := extractProperNouns("有田シンです")
	if err != nil {
		t.Fatalf("extractProperNouns error: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Surface, "シン") {
			return // シン is protected — either merged into 有田シン or as its own entry
		}
	}
	t.Errorf("シン not in any protected entry; got %v", entries)
}

func TestExtractEnglishIntroNames(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		// "my name is" (min=1 word)
		{"my name is lowercase", "my name is shin arita", []string{"shin arita"}},
		{"My Name Is mixed case", "My name is Shin Arita", []string{"Shin Arita"}},
		{"MY NAME IS uppercase", "MY NAME IS SHIN ARITA", []string{"SHIN ARITA"}},
		{"speech recognition variant", "my name is sing arita", []string{"sing arita"}},
		{"three-word name", "my name is alice mary johnson", []string{"alice mary johnson"}},
		{"my name is single word", "my name is alice", []string{"alice"}},
		// "I am" and "I'm" (min=2 words to reduce false positives)
		{"I am two-word name", "I am taro suzuki", []string{"taro suzuki"}},
		{"I'm two-word name", "I'm john smith", []string{"john smith"}},
		{"i'm lowercase", "i'm alice johnson", []string{"alice johnson"}},
		// stops at sentence punctuation
		{"stops at period", "my name is shin arita. Nice to meet you.", []string{"shin arita"}},
		{"stops at comma", "my name is alice, nice to meet you", []string{"alice"}},
		// stops at stop words
		{"stops at and", "my name is alice and here we go", []string{"alice"}},
		{"I am stops at and", "my name is alice and I am japanese", []string{"alice"}},
		{"stops at from", "I am bob smith from japan", []string{"bob smith"}},
		// single word after "I am" / "I'm" → skipped (min=2)
		{"I am single word skipped", "I am going to the store", []string{}},
		{"I am article skipped", "I am a developer", []string{}},
		{"I am single non-stop skipped", "I am japanese", []string{}},
		{"I'm stop word", "I'm not sure", []string{}},
		{"digit after pattern", "I am 30 years old", []string{}},
		// no intro pattern
		{"no intro pattern japanese", "こんにちは", []string{}},
		{"no intro pattern english", "hello world", []string{}},
		// deduplication
		{"dedup same pattern", "my name is john smith. my name is john smith.", []string{"john smith"}},
		{"dedup different pattern", "my name is john smith. I am john smith.", []string{"john smith"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractEnglishIntroNames(tt.text)
			if len(got) != len(tt.want) {
				t.Fatalf("got=%v want=%v", got, tt.want)
			}
			for i, g := range got {
				if g != tt.want[i] {
					t.Errorf("[%d] got=%q want=%q", i, g, tt.want[i])
				}
			}
		})
	}
}

func TestHasIntroPatterns(t *testing.T) {
	tests := []struct {
		text string
		want bool
	}{
		{"my name is shin", true},
		{"My Name Is Shin", true},
		{"MY NAME IS SHIN", true},
		{"I am taro", true},
		{"i am taro", true},
		{"I'm alice", true},
		{"i'm alice", true},
		{"こんにちは", false},
		{"hello world", false},
		{"私は有田シンです", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.text, func(t *testing.T) {
			if got := hasIntroPatterns(tt.text); got != tt.want {
				t.Fatalf("hasIntroPatterns(%q)=%v want=%v", tt.text, got, tt.want)
			}
		})
	}
}

func TestCorsMiddlewareOptions(t *testing.T) {
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
	})

	req := httptest.NewRequest(http.MethodOptions, "/test", nil)
	rec := httptest.NewRecorder()

	corsMiddleware(next).ServeHTTP(rec, req)

	if nextCalled {
		t.Fatal("next handler should not be called")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusNoContent)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "GET, POST, OPTIONS" {
		t.Fatalf("allow-methods=%q", got)
	}
}
