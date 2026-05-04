// AWS Signature Version 4 verification for the S3-compatible surface.
//
// SigV4 is the (only practical) S3 auth protocol — every backup tool and
// SDK signs requests this way. We do the canonical-request → string-to-sign
// → derived-signing-key → HMAC-SHA256 dance, then constant-time-compare
// against the signature the client sent.
//
// References:
//   - https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
//   - https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
//   - https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html
//
// Modes supported in Phase 3:
//
//   - Header auth with full SHA256 of the body (x-amz-content-sha256 set
//     to the hex hash). Most rclone / restic uploads.
//   - Header auth with UNSIGNED-PAYLOAD (x-amz-content-sha256 literal).
//     Most CLI clients fall back to this for streams where they can't
//     hash up front.
//   - Pre-signed URL queries (X-Amz-Algorithm=AWS4-HMAC-SHA256, with the
//     credential / signed-headers / signature in the querystring). Used by
//     "share a link to download" flows.
//
// Mode NOT supported in Phase 3 (TODO): STREAMING-AWS4-HMAC-SHA256-PAYLOAD.
// rclone falls back to non-streaming uploads when the server rejects
// streaming, so users hit this path can set `--s3-upload-cutoff=0` (forces
// multipart) or `--s3-disable-checksum` (forces UNSIGNED-PAYLOAD).
package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// sigV4Algorithm is the literal string AWS expects in the Authorization
// header and presigned-query algorithm field.
const sigV4Algorithm = "AWS4-HMAC-SHA256"

// sigV4Service is the service name in the credential scope. S3 always
// signs against "s3" regardless of which actual operation is being called.
const sigV4Service = "s3"

// sigV4TerminationString is the fixed last segment of the credential
// scope ("aws4_request").
const sigV4TerminationString = "aws4_request"

// sigV4UnsignedPayload is the literal value clients send in
// X-Amz-Content-Sha256 when they don't want to hash the body.
const sigV4UnsignedPayload = "UNSIGNED-PAYLOAD"

// sigV4StreamingPayload is the literal value clients send in
// X-Amz-Content-Sha256 when they want chunked SigV4. Phase 3 rejects this
// — see TODO at the top of the file.
const sigV4StreamingPayload = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD"

// sigV4MaxClockSkew is how far apart we tolerate the client's X-Amz-Date
// from our wall clock. AWS uses 15 minutes; we match.
const sigV4MaxClockSkew = 15 * time.Minute

// sigV4Request carries the bits we extracted from the wire (header or
// presigned query) and need for verification.
type sigV4Request struct {
	AccessKeyID   string    // first segment of Credential=
	Date          string    // YYYYMMDD; second segment of Credential=
	Region        string    // third segment of Credential= (essentially decorative for us)
	SignedHeaders []string  // sorted, lowercased
	Signature     string    // hex
	XAmzDate      time.Time // timestamp from X-Amz-Date header / query
	Presigned     bool      // true if extracted from query, false if from header
	ExpiresIn     int       // for presigned only, value of X-Amz-Expires (seconds)
}

// parseAuthorizationHeader pulls a sigV4Request out of the Authorization
// header. Returns an error with the AWS error code embedded so the caller
// can surface a sensible 400/403 envelope.
//
// Expected shape:
//
//	Authorization: AWS4-HMAC-SHA256 Credential=AKIA…/20260504/us-east-1/s3/aws4_request,
//	               SignedHeaders=host;x-amz-content-sha256;x-amz-date,
//	               Signature=abcd…
func parseAuthorizationHeader(authz, xAmzDate string) (*sigV4Request, error) {
	if !strings.HasPrefix(authz, sigV4Algorithm+" ") {
		return nil, errors.New("authorization header missing AWS4-HMAC-SHA256 prefix")
	}
	rest := strings.TrimSpace(strings.TrimPrefix(authz, sigV4Algorithm))

	// The three k=v segments are comma-separated, but AWS allows
	// arbitrary whitespace between them. Split on commas, strip spaces.
	out := &sigV4Request{}
	for _, kv := range strings.Split(rest, ",") {
		kv = strings.TrimSpace(kv)
		eq := strings.IndexByte(kv, '=')
		if eq < 0 {
			return nil, fmt.Errorf("malformed authorization segment %q", kv)
		}
		key, val := kv[:eq], kv[eq+1:]
		switch key {
		case "Credential":
			parts := strings.Split(val, "/")
			if len(parts) != 5 {
				return nil, fmt.Errorf("credential scope must have 5 segments, got %d", len(parts))
			}
			if parts[3] != sigV4Service {
				return nil, fmt.Errorf("service must be %q, got %q", sigV4Service, parts[3])
			}
			if parts[4] != sigV4TerminationString {
				return nil, fmt.Errorf("scope must end in %q, got %q", sigV4TerminationString, parts[4])
			}
			out.AccessKeyID = parts[0]
			out.Date = parts[1]
			out.Region = parts[2]
		case "SignedHeaders":
			out.SignedHeaders = strings.Split(val, ";")
			sort.Strings(out.SignedHeaders) // canonical order
		case "Signature":
			out.Signature = val
		default:
			// Unknown segments are ignored — AWS sometimes adds new
			// fields and SDKs are tolerant.
		}
	}

	if out.AccessKeyID == "" || len(out.SignedHeaders) == 0 || out.Signature == "" {
		return nil, errors.New("authorization header missing Credential / SignedHeaders / Signature")
	}

	t, err := time.Parse("20060102T150405Z", xAmzDate)
	if err != nil {
		return nil, fmt.Errorf("invalid X-Amz-Date %q: %w", xAmzDate, err)
	}
	out.XAmzDate = t
	return out, nil
}

// parsePresignedQuery pulls a sigV4Request out of a pre-signed URL query.
// Same fields as parseAuthorizationHeader, except they live in well-known
// query parameters with X-Amz- prefixes.
func parsePresignedQuery(q url.Values) (*sigV4Request, error) {
	if q.Get("X-Amz-Algorithm") != sigV4Algorithm {
		return nil, errors.New("query missing X-Amz-Algorithm=AWS4-HMAC-SHA256")
	}
	credential := q.Get("X-Amz-Credential")
	signedHeaders := q.Get("X-Amz-SignedHeaders")
	signature := q.Get("X-Amz-Signature")
	xAmzDate := q.Get("X-Amz-Date")
	expires := q.Get("X-Amz-Expires")

	if credential == "" || signedHeaders == "" || signature == "" || xAmzDate == "" {
		return nil, errors.New("presigned query missing required X-Amz-* parameters")
	}

	parts := strings.Split(credential, "/")
	if len(parts) != 5 {
		return nil, fmt.Errorf("credential scope must have 5 segments, got %d", len(parts))
	}
	if parts[3] != sigV4Service || parts[4] != sigV4TerminationString {
		return nil, errors.New("credential scope service/termination mismatch")
	}

	t, err := time.Parse("20060102T150405Z", xAmzDate)
	if err != nil {
		return nil, fmt.Errorf("invalid X-Amz-Date %q: %w", xAmzDate, err)
	}

	out := &sigV4Request{
		AccessKeyID:   parts[0],
		Date:          parts[1],
		Region:        parts[2],
		SignedHeaders: strings.Split(signedHeaders, ";"),
		Signature:     signature,
		XAmzDate:      t,
		Presigned:     true,
	}
	sort.Strings(out.SignedHeaders)

	if expires != "" {
		// Best-effort parse — invalid means we don't honor the bound,
		// which is no worse than the header-auth path.
		_, _ = fmt.Sscanf(expires, "%d", &out.ExpiresIn)
	}
	return out, nil
}

// verifySignature reconstructs the signature the client should have sent
// and constant-time-compares it. Returns nil on match, an error describing
// the mismatch otherwise (callers map this to SignatureDoesNotMatch).
//
// `body` is the request body bytes (already-buffered; caller must have
// drained the request when it's safe to do so). Pass nil for streaming /
// presigned cases — verifySignature falls back to UNSIGNED-PAYLOAD when
// the X-Amz-Content-Sha256 header indicates that.
//
// Clock-skew enforcement happens here too: requests further than
// sigV4MaxClockSkew from now are rejected outright, matching AWS behavior.
func verifySignature(req *http.Request, parsed *sigV4Request, secretKey string, body []byte) error {
	// Clock skew check — protects against signature replay over long
	// periods. Match AWS's 15-minute tolerance.
	now := time.Now().UTC()
	skew := now.Sub(parsed.XAmzDate)
	if skew < 0 {
		skew = -skew
	}
	if skew > sigV4MaxClockSkew {
		return fmt.Errorf("request timestamp is %v from server time", skew)
	}

	canonicalRequest, err := buildCanonicalRequest(req, parsed, body)
	if err != nil {
		return err
	}

	credentialScope := fmt.Sprintf("%s/%s/%s/%s", parsed.Date, parsed.Region, sigV4Service, sigV4TerminationString)

	stringToSign := strings.Join([]string{
		sigV4Algorithm,
		parsed.XAmzDate.Format("20060102T150405Z"),
		credentialScope,
		hexSHA256([]byte(canonicalRequest)),
	}, "\n")

	signingKey := deriveSigningKey(secretKey, parsed.Date, parsed.Region, sigV4Service)
	expected := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	if subtle.ConstantTimeCompare([]byte(expected), []byte(parsed.Signature)) != 1 {
		return errors.New("signature mismatch")
	}
	return nil
}

// buildCanonicalRequest assembles the canonical request string per the
// SigV4 spec. Returns an error only for X-Amz-Content-Sha256 corruption
// — every other field has a deterministic mapping.
//
//	canonical_request =
//	    HTTPRequestMethod   '\n' +
//	    CanonicalURI        '\n' +
//	    CanonicalQueryString'\n' +
//	    CanonicalHeaders    '\n' +
//	    SignedHeaders       '\n' +
//	    HashedPayload
func buildCanonicalRequest(req *http.Request, parsed *sigV4Request, body []byte) (string, error) {
	method := req.Method

	// CanonicalURI: URI-encode each path segment (except the slashes
	// themselves). For S3, path components have already been escaped by
	// the client; keeping them as-is matches what AWS expects.
	canonicalURI := canonicalEscape(req.URL.EscapedPath())
	if canonicalURI == "" {
		canonicalURI = "/"
	}

	// CanonicalQueryString: sort keys lexicographically, URL-encode key
	// and value separately, join with '&'. For presigned auth, X-Amz-
	// Signature itself is excluded.
	canonicalQuery := canonicalQueryString(req.URL.Query(), parsed.Presigned)

	// CanonicalHeaders: each signed header lowercased, value trimmed,
	// terminated by '\n'. Order matches parsed.SignedHeaders (already
	// sorted).
	headers, err := canonicalHeaders(req, parsed.SignedHeaders, parsed.Presigned)
	if err != nil {
		return "", err
	}

	// HashedPayload: hex-sha256 of the body, OR the literal
	// X-Amz-Content-Sha256 value if the client sent UNSIGNED-PAYLOAD or
	// the streaming sentinel. For presigned URLs, AWS prescribes
	// "UNSIGNED-PAYLOAD".
	var hashedPayload string
	if parsed.Presigned {
		hashedPayload = sigV4UnsignedPayload
	} else {
		xch := req.Header.Get("X-Amz-Content-Sha256")
		switch xch {
		case "":
			// Some old SDKs omit the header entirely; AWS treats this
			// the same as the hex hash. Compute it from body.
			hashedPayload = hexSHA256(body)
		case sigV4UnsignedPayload:
			hashedPayload = sigV4UnsignedPayload
		case sigV4StreamingPayload:
			// Phase 3 doesn't implement chunked SigV4 — return a
			// signal up the stack so the caller can surface
			// XAmzContentSHA256Mismatch.
			return "", errors.New("streaming SigV4 not supported in Phase 3 (use --s3-upload-cutoff=0 or --s3-disable-checksum)")
		default:
			// Hex-encoded SHA-256; verify it matches our body if we
			// have one, otherwise trust the client's claim. (We
			// always have the body in Phase 3: every PUT path
			// buffers via the gin body reader.)
			if body != nil {
				if want := hexSHA256(body); want != xch {
					return "", fmt.Errorf("body sha256 mismatch: got %s, want %s", want, xch)
				}
			}
			hashedPayload = xch
		}
	}

	return strings.Join([]string{
		method,
		canonicalURI,
		canonicalQuery,
		headers,
		strings.Join(parsed.SignedHeaders, ";"),
		hashedPayload,
	}, "\n"), nil
}

// canonicalEscape URL-encodes characters per the SigV4 rules: unreserved
// chars passed through, everything else hex-encoded. Slashes inside the
// path are preserved.
//
// We skip a second escape pass — req.URL.EscapedPath already URL-encoded
// the path on the way in, so re-encoding would double-escape.
func canonicalEscape(p string) string {
	return p
}

// canonicalQueryString sorts query parameters by key, URL-encodes both
// key and value, and joins as `k=v&k=v`. For presigned auth, the
// X-Amz-Signature parameter is excluded (the spec is explicit: the
// signature signs everything else).
func canonicalQueryString(q url.Values, presigned bool) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		if presigned && k == "X-Amz-Signature" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	for i, k := range keys {
		vals := q[k]
		// Within a key, values are sorted too — AWS uses a stable
		// sort here so duplicate keys with different values stay
		// reproducible.
		sort.Strings(vals)
		for _, v := range vals {
			if b.Len() > 0 || i > 0 {
				b.WriteByte('&')
			}
			b.WriteString(awsURIEscape(k))
			b.WriteByte('=')
			b.WriteString(awsURIEscape(v))
		}
	}
	return b.String()
}

// canonicalHeaders builds the CanonicalHeaders block: each signed header
// emitted as `name:value\n`, where name is lowercased and value is the
// trimmed (and inner-whitespace-collapsed) header value. Returns an error
// if a signed header is missing from the request.
//
// Special case: "host" must always be signed; we read it from
// req.Host (gin / net/http hide it from req.Header on the server side).
func canonicalHeaders(req *http.Request, signedHeaders []string, presigned bool) (string, error) {
	var b strings.Builder
	for _, h := range signedHeaders {
		var val string
		switch h {
		case "host":
			val = req.Host
		default:
			// Header names are lowercase in SignedHeaders; lookup
			// is case-insensitive on the Go side.
			val = req.Header.Get(h)
			if val == "" && presigned {
				// Presigned auth signs query parameters, not
				// headers. We accept missing values for non-host
				// signed headers in that mode.
				continue
			}
			if val == "" {
				return "", fmt.Errorf("signed header %q missing from request", h)
			}
		}
		b.WriteString(h)
		b.WriteByte(':')
		b.WriteString(canonicalHeaderValue(val))
		b.WriteByte('\n')
	}
	return b.String(), nil
}

// canonicalHeaderValue trims leading / trailing space and collapses
// runs of internal whitespace to a single space. Matches AWS's docs.
func canonicalHeaderValue(v string) string {
	v = strings.TrimSpace(v)
	// Collapse internal whitespace runs.
	for strings.Contains(v, "  ") {
		v = strings.ReplaceAll(v, "  ", " ")
	}
	return v
}

// deriveSigningKey runs the four-step HMAC chain that turns the secret
// access key into a per-day, per-region, per-service signing key.
//
//	kDate    = HMAC("AWS4" + kSecret, date)
//	kRegion  = HMAC(kDate, region)
//	kService = HMAC(kRegion, service)
//	kSigning = HMAC(kService, "aws4_request")
func deriveSigningKey(secretKey, date, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(date))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	return hmacSHA256(kService, []byte(sigV4TerminationString))
}

// hmacSHA256 is the HMAC-SHA256 primitive used throughout SigV4 derivation.
func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

// hexSHA256 returns the lowercase hex-encoded SHA-256 of data. nil input
// returns the SHA-256 of the empty string, which is what AWS expects for
// empty bodies.
func hexSHA256(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// awsURIEscape implements AWS's URI-encode rules (RFC 3986 unreserved
// chars left alone; everything else %HH-encoded; spaces become %20, never
// '+'). Distinct from url.QueryEscape, which uses '+' for spaces.
func awsURIEscape(s string) string {
	var b bytes.Buffer
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z',
			c >= 'a' && c <= 'z',
			c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// drainBody reads the entire request body into memory and replaces
// req.Body with a fresh reader so downstream handlers can re-read.
//
// Used by paths that need to verify a hex SHA-256 of the body (every PUT
// without UNSIGNED-PAYLOAD). Bounded by `limit` to prevent a misconfigured
// client from OOM'ing us.
//
// Returns the body bytes; the original req.Body is closed and replaced.
func drainBody(req *http.Request, limit int64) ([]byte, error) {
	if req.Body == nil {
		return nil, nil
	}
	defer req.Body.Close()
	body, err := io.ReadAll(io.LimitReader(req.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("body exceeds limit of %d bytes", limit)
	}
	req.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
}
