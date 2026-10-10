package main

import (
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
		{name: "missing", output: "__GT_PROPN_000__ met someone.", wantErr: "expected 1 occurrences, got 0"},
		{name: "too many", output: "__GT_PROPN_000__ met __GT_PROPN_001__ and __GT_PROPN_001__.", wantErr: "expected 1 occurrences, got 2"},
		{name: "unknown placeholder", output: "__GT_PROPN_000__ met __GT_PROPN_001__ at __GT_PROPN_002__.", wantErr: `unknown placeholder "__GT_PROPN_002__"`},
		{name: "unknown non-numeric placeholder", output: "__GT_PROPN_000__ met __GT_PROPN_001__ at __GT_PROPN_X__.", wantErr: `unknown placeholder "__GT_PROPN_X__"`},
		{name: "malformed placeholder without closing", output: "__GT_PROPN_000__ met __GT_PROPN_001__ at __GT_PROPN_002", wantErr: `malformed placeholder "__GT_PROPN_002"`},
		{name: "malformed placeholder broken in the middle", output: "__GT_PROPN_000__ met __GT_PROPN_001__ at __GT_PROPN_0 02__.", wantErr: `unknown placeholder "__GT_PROPN_0 02__"`},
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
