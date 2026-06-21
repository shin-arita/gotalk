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
