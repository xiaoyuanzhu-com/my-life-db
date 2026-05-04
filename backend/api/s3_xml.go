// XML response envelopes for the S3-compatible surface.
//
// AWS S3 wire format is XML, not JSON — every successful list/multipart
// response and every error is an XML document. This file holds:
//
//   - The struct definitions used by encoding/xml for the response bodies
//     we actually emit (ListBuckets, ListObjectsV2, multipart init/complete,
//     CopyObject result).
//   - Canonical AWS error codes (NoSuchKey, AccessDenied, etc.) plus the
//     <Error> envelope that wraps them.
//   - writeXML / writeS3Error helpers that set the right Content-Type and
//     status code so handlers can stay short.
//
// We deliberately mirror the AWS XML shape exactly — clients (rclone,
// restic, MinIO clients) parse against AWS's published schemas. Inventing
// our own envelope would break the whole point of the surface.
package api

import (
	"encoding/xml"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// xmlContentType is the Content-Type AWS uses for every S3 response body.
const xmlContentType = "application/xml"

// xmlNS is the XML namespace AWS stamps onto every list response. Some
// clients ignore it but rclone and minio-go check for it; safer to emit.
const xmlNS = "http://s3.amazonaws.com/doc/2006-03-01/"

// xmlPreamble is prepended to every body we marshal so XML strict parsers
// (Java SDK in particular) don't complain about a missing declaration.
const xmlPreamble = `<?xml version="1.0" encoding="UTF-8"?>` + "\n"

// ---------------------------------------------------------------------------
// AWS error codes we use. The full list is much larger but these are the
// codes backup tools and SDKs branch on.
// ---------------------------------------------------------------------------

const (
	S3ErrNoSuchKey               = "NoSuchKey"
	S3ErrNoSuchBucket            = "NoSuchBucket"
	S3ErrNoSuchUpload            = "NoSuchUpload"
	S3ErrAccessDenied            = "AccessDenied"
	S3ErrSignatureDoesNotMatch   = "SignatureDoesNotMatch"
	S3ErrInvalidAccessKeyID      = "InvalidAccessKeyId"
	S3ErrAuthorizationHeaderMalformed = "AuthorizationHeaderMalformed"
	S3ErrInvalidRequest          = "InvalidRequest"
	S3ErrInvalidArgument         = "InvalidArgument"
	S3ErrMethodNotAllowed        = "MethodNotAllowed"
	S3ErrNotImplemented          = "NotImplemented"
	S3ErrInternalError           = "InternalError"
	S3ErrEntityTooLarge          = "EntityTooLarge"
	S3ErrXAmzContentSHA256Mismatch = "XAmzContentSHA256Mismatch"
	S3ErrInvalidPart             = "InvalidPart"
	S3ErrInvalidPartOrder        = "InvalidPartOrder"
)

// s3ErrorEnvelope is the body shape AWS returns for every error response.
// Resource is the bucket+key that caused the error; RequestId is a server-
// minted opaque id (we use the gin request id when available, otherwise a
// short random string).
type s3ErrorEnvelope struct {
	XMLName   xml.Name `xml:"Error"`
	Code      string   `xml:"Code"`
	Message   string   `xml:"Message"`
	Resource  string   `xml:"Resource,omitempty"`
	RequestID string   `xml:"RequestId,omitempty"`
}

// writeS3Error emits an AWS-shaped error envelope. statusCode should be
// the HTTP status that matches the code (e.g. NoSuchKey → 404, AccessDenied
// → 403, SignatureDoesNotMatch → 403, InternalError → 500).
//
// Sets Content-Type, writes the XML preamble, and aborts the gin pipeline
// so caller can `return` immediately after.
func writeS3Error(c *gin.Context, statusCode int, code, message, resource string) {
	env := s3ErrorEnvelope{
		Code:      code,
		Message:   message,
		Resource:  resource,
		RequestID: c.GetHeader("X-Amz-Request-Id"),
	}
	body, err := xml.Marshal(env)
	if err != nil {
		// Fall back to a plain status — we shouldn't be here, but if
		// xml.Marshal blew up we don't want a panic to bubble.
		log.Error().Err(err).Msg("s3: failed to marshal error envelope")
		c.Status(statusCode)
		c.Abort()
		return
	}
	c.Header("Content-Type", xmlContentType)
	c.Status(statusCode)
	_, _ = c.Writer.Write([]byte(xmlPreamble))
	_, _ = c.Writer.Write(body)
	c.Abort()
}

// writeXML marshals `body` into an XML response with the AWS preamble and
// Content-Type. Caller picks the status code (200 for most listings,
// 204 for delete, etc.).
func writeXML(c *gin.Context, statusCode int, body any) {
	out, err := xml.Marshal(body)
	if err != nil {
		log.Error().Err(err).Msg("s3: failed to marshal response body")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to marshal response body", "")
		return
	}
	c.Header("Content-Type", xmlContentType)
	c.Status(statusCode)
	_, _ = c.Writer.Write([]byte(xmlPreamble))
	_, _ = c.Writer.Write(out)
}

// ---------------------------------------------------------------------------
// ListBuckets
// ---------------------------------------------------------------------------

// listAllMyBucketsResult is the body of GET /s3/. We always return exactly
// one bucket — the credential's scope folder — because each credential is
// pinned to a single scope.
type listAllMyBucketsResult struct {
	XMLName xml.Name        `xml:"ListAllMyBucketsResult"`
	Xmlns   string          `xml:"xmlns,attr"`
	Owner   s3Owner         `xml:"Owner"`
	Buckets s3BucketList    `xml:"Buckets"`
}

type s3BucketList struct {
	Bucket []s3Bucket `xml:"Bucket"`
}

type s3Bucket struct {
	Name         string `xml:"Name"`
	CreationDate string `xml:"CreationDate"`
}

type s3Owner struct {
	ID          string `xml:"ID"`
	DisplayName string `xml:"DisplayName"`
}

// ---------------------------------------------------------------------------
// ListObjectsV2
// ---------------------------------------------------------------------------

// listBucketResultV2 is the body of GET /s3/<bucket>/?list-type=2.
//
// IsTruncated + NextContinuationToken implement opaque cursor pagination.
// Our cursor is just the last key emitted, base64-url encoded so the wire
// looks like AWS's continuation tokens.
type listBucketResultV2 struct {
	XMLName               xml.Name        `xml:"ListBucketResult"`
	Xmlns                 string          `xml:"xmlns,attr"`
	Name                  string          `xml:"Name"`
	Prefix                string          `xml:"Prefix"`
	Delimiter             string          `xml:"Delimiter,omitempty"`
	KeyCount              int             `xml:"KeyCount"`
	MaxKeys               int             `xml:"MaxKeys"`
	IsTruncated           bool            `xml:"IsTruncated"`
	ContinuationToken     string          `xml:"ContinuationToken,omitempty"`
	NextContinuationToken string          `xml:"NextContinuationToken,omitempty"`
	StartAfter            string          `xml:"StartAfter,omitempty"`
	Contents              []s3ObjectEntry `xml:"Contents"`
	CommonPrefixes        []s3CommonPrefix `xml:"CommonPrefixes"`
}

type s3ObjectEntry struct {
	Key          string  `xml:"Key"`
	LastModified string  `xml:"LastModified"`
	ETag         string  `xml:"ETag"`
	Size         int64   `xml:"Size"`
	StorageClass string  `xml:"StorageClass"`
	Owner        *s3Owner `xml:"Owner,omitempty"`
}

type s3CommonPrefix struct {
	Prefix string `xml:"Prefix"`
}

// ---------------------------------------------------------------------------
// Multipart upload
// ---------------------------------------------------------------------------

// initiateMultipartUploadResult is the body of POST /s3/<bucket>/<key>?uploads.
type initiateMultipartUploadResult struct {
	XMLName  xml.Name `xml:"InitiateMultipartUploadResult"`
	Xmlns    string   `xml:"xmlns,attr"`
	Bucket   string   `xml:"Bucket"`
	Key      string   `xml:"Key"`
	UploadID string   `xml:"UploadId"`
}

// completeMultipartUpload is the request body parsed from
// POST /s3/<bucket>/<key>?uploadId=…
type completeMultipartUpload struct {
	XMLName xml.Name              `xml:"CompleteMultipartUpload"`
	Parts   []completedMultipartPart `xml:"Part"`
}

type completedMultipartPart struct {
	PartNumber int    `xml:"PartNumber"`
	ETag       string `xml:"ETag"`
}

// completeMultipartUploadResult is the body of the same endpoint's response.
// Location is informational — clients pin to the bucket+key they sent, not
// to whatever we return here.
type completeMultipartUploadResult struct {
	XMLName  xml.Name `xml:"CompleteMultipartUploadResult"`
	Xmlns    string   `xml:"xmlns,attr"`
	Location string   `xml:"Location"`
	Bucket   string   `xml:"Bucket"`
	Key      string   `xml:"Key"`
	ETag     string   `xml:"ETag"`
}

// listMultipartUploadsResult is the body of GET /s3/<bucket>/?uploads.
// We always return an empty list — Phase 3 does not expose in-flight
// multipart uploads to the listing endpoint (clients track their own
// upload ids).
type listMultipartUploadsResult struct {
	XMLName    xml.Name `xml:"ListMultipartUploadsResult"`
	Xmlns      string   `xml:"xmlns,attr"`
	Bucket     string   `xml:"Bucket"`
	KeyMarker  string   `xml:"KeyMarker"`
	UploadIDMarker string `xml:"UploadIdMarker"`
	NextKeyMarker  string `xml:"NextKeyMarker,omitempty"`
	NextUploadIDMarker string `xml:"NextUploadIdMarker,omitempty"`
	MaxUploads int      `xml:"MaxUploads"`
	IsTruncated bool    `xml:"IsTruncated"`
}

// ---------------------------------------------------------------------------
// CopyObject
// ---------------------------------------------------------------------------

// copyObjectResult is the body of PUT /s3/<bucket>/<key> with
// `x-amz-copy-source` set. ETag matches the destination object's ETag,
// LastModified is the destination's mtime.
type copyObjectResult struct {
	XMLName      xml.Name `xml:"CopyObjectResult"`
	Xmlns        string   `xml:"xmlns,attr"`
	ETag         string   `xml:"ETag"`
	LastModified string   `xml:"LastModified"`
}
