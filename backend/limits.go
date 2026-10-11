package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"
)

// Per-request cost limits (docs/rate-limit-design.md 5.1, 5.3, 5.4) and the deadlines for
// cancellation (5.11).

const (
	// maxInterpretBodyBytes is the most bytes accepted for a whole /api/interpret request body.
	maxInterpretBodyBytes = 3 << 19 // 1.5 MiB
	// maxAudioBytes is the most bytes accepted for the audio part of /api/interpret.
	maxAudioBytes = 1 << 20 // 1 MiB
	// maxJSONBodyBytes is the most bytes accepted for a /api/translate or /api/tts request body.
	maxJSONBodyBytes = 16 << 10 // 16 KiB
	// maxTextRunes is the most characters (runes) accepted for the text to translate or read aloud,
	// and for the transcript sent to /api/interpret.
	maxTextRunes = 500

	// maxOutputTokens is set on every Responses API call.
	maxOutputTokens = 1024

	// maxTranslationRetries is the number of retries for each of the translation and the
	// back-translation on the proper noun protection path (see runProtectedTranslation).
	maxTranslationRetries = 1

	// Maximum OpenAI calls for one request (docs/rate-limit-design.md 5.4).
	//   - translation: protected path = translation + retry + back-translation + retry; unprotected
	//     path = translation (with language detection) + back-translation. The protected path
	//     falls back to the unprotected one only before its first OpenAI call, so the maximum is
	//     the larger of the two, not their sum.
	//   - /api/interpret without a transcript adds language detection and transcription.
	maxTranslationCalls       = 2 * (1 + maxTranslationRetries)
	maxTranslateRequestCalls  = maxTranslationCalls
	maxInterpretRequestCalls  = 2 + maxTranslationCalls
	maxTTSRequestCalls        = 1
	openAIClientTimeout       = 120 * time.Second
	maxUpstreamRetryAfterSecs = 60
)

// Processing deadlines for each endpoint (docs/rate-limit-design.md 5.11). They are variables so
// that tests can shorten them.
var (
	interpretDeadline = 55 * time.Second
	translateDeadline = 25 * time.Second
	ttsDeadline       = 25 * time.Second
)

// openAIClient is the HTTP client for every OpenAI request. Its timeout is a safety net longer
// than the request deadlines; requests are normally ended by their context.
// http.DefaultClient is not used.
var openAIClient = &http.Client{Timeout: openAIClientTimeout}

// Error codes in the "code" field of error responses.
const (
	codeInvalidRequest     = "invalid_request"
	codeInputTooLarge      = "input_too_large"
	codeServiceUnavailable = "service_unavailable"
	codeUpstreamBusy       = "upstream_busy"
	codeTimeout            = "timeout"
	codeUpstreamError      = "upstream_error"
	codeInternalError      = "internal_error"
	codeLanguageMismatch   = "language_mismatch"
	codeProtectionFailed   = "proper_noun_protection_failed"
)

// logLimit logs a request stopped by a limit, a cancellation, or an OpenAI error that was
// converted for the client. It never includes the request content or the client's IP address.
// status is 0 when no response is written (the client has gone).
func logLimit(endpoint, limitType string, status int) {
	if status == 0 {
		log.Printf("limit: endpoint=%s limit_type=%s status=none", endpoint, limitType)
		return
	}
	log.Printf("limit: endpoint=%s limit_type=%s status=%d", endpoint, limitType, status)
}

// errTrailingData is returned by decodeJSONBody when another value follows the first one.
var errTrailingData = errors.New("unexpected data after the JSON value")

// decodeJSONBody decodes exactly one JSON value from r.Body into dst, rejecting unknown fields
// and any data after the value. r.Body must already be limited with http.MaxBytesReader.
func decodeJSONBody(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return err
		}
		return errTrailingData
	}
	return nil
}

// isMaxBytesError reports whether err comes from a body over its http.MaxBytesReader limit.
func isMaxBytesError(err error) bool {
	var maxErr *http.MaxBytesError
	return errors.As(err, &maxErr)
}

// writeBodyTooLarge writes 413 input_too_large and logs it.
func writeBodyTooLarge(w http.ResponseWriter, endpoint string) {
	logLimit(endpoint, "input_size", http.StatusRequestEntityTooLarge)
	writeError(w, http.StatusRequestEntityTooLarge, codeInputTooLarge, "request body too large")
}

// writeTextTooLong writes 400 input_too_large and logs it.
func writeTextTooLong(w http.ResponseWriter, endpoint string) {
	logLimit(endpoint, "input_size", http.StatusBadRequest)
	writeError(w, http.StatusBadRequest, codeInputTooLarge, fmt.Sprintf("text must be at most %d characters", maxTextRunes))
}

// textTooLong reports whether s is longer than maxTextRunes characters.
func textTooLong(s string) bool {
	return utf8.RuneCountInString(s) > maxTextRunes
}

// ─── OpenAI errors ───────────────────────────────────────────────────────────

// openAIStatusError is a non-200 response from OpenAI. Error() is "<prefix> <status> (<detail>)",
// where detail contains only the error type and code and the body size (see readOpenAIError).
type openAIStatusError struct {
	prefix     string
	status     int
	detail     string
	errType    string
	errCode    string
	retryAfter int // seconds from the Retry-After header; 0 when absent or unusable
}

func (e *openAIStatusError) Error() string {
	return fmt.Sprintf("%s %d (%s)", e.prefix, e.status, e.detail)
}

// newOpenAIStatusError reads the error body of resp (bounded, see readOpenAIError).
func newOpenAIStatusError(prefix string, resp *http.Response) *openAIStatusError {
	detail, errType, errCode := readOpenAIError(resp.Body)
	return &openAIStatusError{
		prefix:     prefix,
		status:     resp.StatusCode,
		detail:     detail,
		errType:    errType,
		errCode:    errCode,
		retryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), time.Now()),
	}
}

// openAIBillingCodes are OpenAI error types or codes for spend limits and exhausted credit or
// quota. Retrying does not help, so they become 503 service_unavailable.
var openAIBillingCodes = map[string]struct{}{
	"insufficient_quota":                {},
	"organization_spend_limit_exceeded": {},
	"project_spend_limit_exceeded":      {},
	"credit_balance_exhausted":          {},
	"organization_usage_limit_exceeded": {},
	"billing_hard_limit_reached":        {},
}

// isBilling reports whether the error is a spend limit or exhausted credit or quota.
func (e *openAIStatusError) isBilling() bool {
	if _, ok := openAIBillingCodes[e.errType]; ok {
		return true
	}
	_, ok := openAIBillingCodes[e.errCode]
	return ok
}

// parseRetryAfter returns the Retry-After header in whole seconds (rounded up) when it is
// between 1 and maxUpstreamRetryAfterSecs, otherwise 0.
func parseRetryAfter(v string, now time.Time) int {
	if v == "" {
		return 0
	}
	var secs int
	if n, err := strconv.Atoi(v); err == nil {
		secs = n
	} else if f, err := strconv.ParseFloat(v, 64); err == nil {
		secs = int(f)
		if float64(secs) < f {
			secs++
		}
	} else if t, err := http.ParseTime(v); err == nil {
		d := t.Sub(now)
		secs = int(d / time.Second)
		if d%time.Second > 0 {
			secs++
		}
	} else {
		return 0
	}
	if secs < 1 || secs > maxUpstreamRetryAfterSecs {
		return 0
	}
	return secs
}

// errResponseIncomplete is returned when a Responses API output was cut off, for example by
// max_output_tokens. The translation is treated as failed.
var errResponseIncomplete = errors.New("OpenAI response incomplete")

// errCallLimit is returned when a request would exceed its maximum number of OpenAI calls.
var errCallLimit = errors.New("OpenAI call limit for the request reached")

// ─── per-request OpenAI call budget ──────────────────────────────────────────

type callBudgetKey struct{}

// callBudget counts the OpenAI calls made for one request. Handlers run the calls of one request
// one after another, so no locking is needed.
type callBudget struct {
	max  int
	used int
}

// withCallBudget returns a context that allows at most max OpenAI calls.
func withCallBudget(ctx context.Context, max int) context.Context {
	return context.WithValue(ctx, callBudgetKey{}, &callBudget{max: max})
}

// beginOpenAICall is called right before each OpenAI request. It stops the request when its
// context has ended (canceled or past its deadline) or its call budget is used up, so no further
// OpenAI call is made.
func beginOpenAICall(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if b, ok := ctx.Value(callBudgetKey{}).(*callBudget); ok {
		if b.used >= b.max {
			return fmt.Errorf("%w (max %d)", errCallLimit, b.max)
		}
		b.used++
	}
	return nil
}

// ─── error responses for OpenAI calls ────────────────────────────────────────

// writeUpstreamError writes the response for a failed OpenAI call (docs/rate-limit-design.md 5.7, 5.11).
//   - The request context was canceled (the client has gone): nothing is written.
//   - The request deadline passed: 504 timeout.
//   - A spend limit or exhausted credit: 503 service_unavailable.
//   - Another 429 from OpenAI (a temporary rate limit): 503 upstream_busy, with OpenAI's
//     Retry-After when it is at most 60 seconds. It is not retried here.
//   - Anything else: 502 upstream_error with fallbackMsg as before.
//
// The caller logs err itself; err.Error() contains only the error type and code.
func writeUpstreamError(w http.ResponseWriter, ctx context.Context, endpoint string, err error, fallbackMsg string) {
	ctxErr := ctx.Err()
	if ctxErr == nil {
		ctxErr = err
	}
	switch {
	case errors.Is(ctxErr, context.Canceled):
		logLimit(endpoint, "canceled", 0)
		return
	case errors.Is(ctxErr, context.DeadlineExceeded):
		logLimit(endpoint, "timeout", http.StatusGatewayTimeout)
		writeError(w, http.StatusGatewayTimeout, codeTimeout, "request timed out")
		return
	}
	var se *openAIStatusError
	if errors.As(err, &se) {
		if se.isBilling() {
			logLimit(endpoint, "service_unavailable", http.StatusServiceUnavailable)
			writeError(w, http.StatusServiceUnavailable, codeServiceUnavailable, "service unavailable")
			return
		}
		if se.status == http.StatusTooManyRequests {
			logLimit(endpoint, "upstream_busy", http.StatusServiceUnavailable)
			if se.retryAfter > 0 {
				w.Header().Set("Retry-After", strconv.Itoa(se.retryAfter))
			}
			writeError(w, http.StatusServiceUnavailable, codeUpstreamBusy, "upstream busy")
			return
		}
	}
	writeError(w, http.StatusBadGateway, codeUpstreamError, fallbackMsg)
}
