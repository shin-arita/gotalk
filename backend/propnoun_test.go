package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestValidatePlaceholders(t *testing.T) {
	entries := []propNounEntry{
		{Placeholder: "__GT_PROPN_000__"},
		{Placeholder: "__GT_PROPN_001__"},
	}
	expected := map[string]int{
		"__GT_PROPN_000__": 1,
		"__GT_PROPN_001__": 1,
	}
	tests := []struct {
		name    string
		output  string
		wantErr string
	}{
		{name: "valid", output: "__GT_PROPN_000__ met __GT_PROPN_001__.", wantErr: ""},
		{name: "valid adjacent", output: "__GT_PROPN_000____GT_PROPN_001__", wantErr: ""},
		{name: "concatenated sharing underscores", output: "__GT_PROPN_000___GT_PROPN_001__", wantErr: "overlapping placeholder"},
		{name: "missing", output: "__GT_PROPN_000__ met someone.", wantErr: "expected 1 occurrences, got 0"},
		{name: "too many", output: "__GT_PROPN_000__ met __GT_PROPN_001__ and __GT_PROPN_001__.", wantErr: "expected 1 occurrences, got 2"},
		{name: "unknown placeholder", output: "__GT_PROPN_000__ met __GT_PROPN_001__ at __GT_PROPN_002__.", wantErr: "unknown placeholder __GT_PROPN_002__ at byte"},
		{name: "unknown non-numeric placeholder", output: "__GT_PROPN_000__ met __GT_PROPN_001__ at __GT_PROPN_X__.", wantErr: "unknown placeholder at byte"},
		{name: "malformed placeholder without closing", output: "__GT_PROPN_000__ met __GT_PROPN_001__ at __GT_PROPN_002", wantErr: "malformed placeholder at byte"},
		{name: "malformed placeholder broken in the middle", output: "__GT_PROPN_000__ met __GT_PROPN_001__ at __GT_PROPN_0 02__.", wantErr: "unknown placeholder at byte"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePlaceholders(tt.output, entries, expected)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error=%q want substring %q", err.Error(), tt.wantErr)
			}
			// The error is written to logs, so it must not contain the translated text.
			if strings.Contains(err.Error(), " met ") {
				t.Errorf("error must not include the output text: %q", err.Error())
			}
		})
	}
}

func TestBuildRetryPrompt(t *testing.T) {
	t.Run("missing placeholders are listed", func(t *testing.T) {
		got := buildRetryPrompt("base", []string{"__GT_PROPN_000__"})
		if !strings.HasPrefix(got, "base") {
			t.Errorf("prompt should start with base prompt: %q", got)
		}
		if !strings.Contains(got, "omitted the following placeholder(s)") || !strings.Contains(got, "  __GT_PROPN_000__\n") {
			t.Errorf("prompt should list omitted placeholders: %q", got)
		}
		if !strings.Contains(got, "Do NOT invent placeholders that are not in the input") ||
			!strings.Contains(got, "exactly as many times as it appears in the input") {
			t.Errorf("prompt should forbid inventing placeholders and require exact counts: %q", got)
		}
	})
	t.Run("no missing placeholders", func(t *testing.T) {
		got := buildRetryPrompt("base", nil)
		if !strings.HasPrefix(got, "base") {
			t.Errorf("prompt should start with base prompt: %q", got)
		}
		if strings.Contains(got, "omitted") {
			t.Errorf("prompt should not claim placeholders were omitted: %q", got)
		}
		if !strings.Contains(got, "exactly as many times as it appears in the input") {
			t.Errorf("prompt should ask to keep placeholders exactly: %q", got)
		}
	})
}

// TestRunProtectedTranslation_PlaceholderTextFailsValidation verifies that when replacing proper
// nouns with placeholders produces text that itself fails validation (the placeholder joins the
// surrounding characters), protection is skipped without calling OpenAI and the caller falls back
// to the unprotected path. A normal input is still protected.
func TestRunProtectedTranslation_PlaceholderTextFailsValidation(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	inputs := []string{
		"博多GT_PROPN_1__に行く",    // → __GT_PROPN_000__GT_PROPN_1__に行く (overlapping)
		"__GT_PROPN博多に行く",      // → __GT_PROPN__GT_PROPN_000__に行く (unknown)
		"博多_GT_PROPN_000__に行く", // → __GT_PROPN_000___GT_PROPN_000__に行く (overlapping)
	}
	for _, in := range inputs {
		t.Run(in, func(t *testing.T) {
			calls := 0
			setMockTransport(t, func(r *http.Request) (*http.Response, error) {
				calls++
				return fakeHTTPResponse(http.StatusOK, openAITextResponse("unused")), nil
			})
			translatedRaw, backTranslationRaw, entries, err := runProtectedTranslation(
				"test-key", "test-model", in,
				func(placeholderText string) string { return placeholderText },
				func(translatedRaw string) string { return translatedRaw },
			)
			if err != nil || entries != nil || translatedRaw != "" || backTranslationRaw != "" {
				t.Fatalf("want (\"\", \"\", nil, nil), got (%q, %q, %v, %v)", translatedRaw, backTranslationRaw, entries, err)
			}
			if calls != 0 {
				t.Errorf("OpenAI should not be called, got %d calls", calls)
			}
		})
	}

	t.Run("normal input stays protected", func(t *testing.T) {
		var prompts []string
		setMockTransport(t, func(r *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(r.Body)
			prompts = append(prompts, string(b))
			if len(prompts) == 1 {
				return fakeHTTPResponse(http.StatusOK, openAITextResponse("Where is __GT_PROPN_000__ Station?")), nil
			}
			return fakeHTTPResponse(http.StatusOK, openAITextResponse("__GT_PROPN_000__駅はどこですか。")), nil
		})
		translatedRaw, _, entries, err := runProtectedTranslation(
			"test-key", "test-model", "博多駅はどこですか",
			func(placeholderText string) string { return placeholderText },
			func(translatedRaw string) string { return translatedRaw },
		)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(entries) == 0 {
			t.Fatal("expected proper noun entries for a normal input")
		}
		if len(prompts) == 0 || !strings.Contains(prompts[0], "__GT_PROPN_000__駅はどこですか") {
			t.Errorf("translate prompt should contain the placeholder text, got %v", prompts)
		}
		if translatedRaw != "Where is __GT_PROPN_000__ Station?" {
			t.Errorf("translatedRaw=%q", translatedRaw)
		}
	})
}
