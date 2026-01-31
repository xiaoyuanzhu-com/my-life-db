# Authentication

The auth system supports three modes configured via `MLD_AUTH_MODE` environment variable.

## Auth Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `none` | No authentication (default) | Local development, single-user |
| `password` | Simple password auth | Basic protection |
| `oauth` | OIDC/OAuth 2.0 | Enterprise, SSO integration |

## Key Components

| Location | Purpose |
|----------|---------|
| `backend/auth/oauth.go` | Auth mode detection, helper functions |
| `backend/auth/oidc_provider.go` | OIDC provider initialization |
| `backend/api/auth.go` | Password auth handlers |
| `backend/api/oauth.go` | OAuth flow handlers |
| `frontend/app/contexts/auth-context.tsx` | Frontend auth state |
| `frontend/app/lib/fetch-with-refresh.ts` | Token refresh logic |

## Current Implementation Status

> **Important**: This documents the **actual** implementation, not an ideal design.

| Feature | Status | Notes |
|---------|--------|-------|
| OAuth flow | ✅ Complete | Full authorization code flow |
| Token refresh | ✅ Complete | Frontend auto-refresh on 401 |
| Password login | ⚠️ Partial | Handlers exist, but uses SHA256 (not secure) |
| Password sessions | ❌ Incomplete | TODO in code - no database session storage |
| Auth middleware | ❌ Not implemented | Routes are currently unprotected |

## Auth Mode Detection

```go
// backend/auth/oauth.go
type AuthMode string

const (
    AuthModeNone     AuthMode = "none"
    AuthModePassword AuthMode = "password"
    AuthModeOAuth    AuthMode = "oauth"
)

func GetAuthMode() AuthMode {
    mode := strings.ToLower(config.Get().AuthMode)
    switch mode {
    case "password":
        return AuthModePassword
    case "oauth":
        return AuthModeOAuth
    default:
        return AuthModeNone
    }
}

// Helper functions
func IsOAuthEnabled() bool { return GetAuthMode() == AuthModeOAuth }
func IsPasswordAuthEnabled() bool { return GetAuthMode() == AuthModePassword }
func IsAuthRequired() bool { return GetAuthMode() != AuthModeNone }
```

## OAuth/OIDC

### Flow Diagram

```
Browser                    Backend                    OIDC Provider
   |                          |                            |
   |-- GET /api/oauth/authorize -->                        |
   |                          |-- redirect to provider --->|
   |                          |                            |
   |<-------------------------|<-- callback with code -----|
   |                          |                            |
   |                          |-- exchange code for token ->|
   |                          |<-- access + refresh token --|
   |                          |                            |
   |<-- set cookies -----------|                            |
```

### Configuration

```bash
MLD_AUTH_MODE=oauth
MLD_OAUTH_CLIENT_ID=your-client-id
MLD_OAUTH_CLIENT_SECRET=your-secret
MLD_OAUTH_ISSUER_URL=https://your-idp.com
MLD_OAUTH_REDIRECT_URI=https://your-app.com/api/oauth/callback
MLD_EXPECTED_USERNAME=optional-username-filter
```

### Token Storage

Tokens are stored in HTTP-only cookies:

```go
// Access token cookie
c.SetCookie(
    "access_token",
    accessToken,
    int(expiresIn.Seconds()),
    "/",              // Available to all paths
    "",
    !isDev,           // Secure in production
    true,             // HttpOnly
)

// Refresh token cookie
c.SetCookie(
    "refresh_token",
    refreshToken,
    86400 * 30,       // 30 days
    "/api/oauth",     // Only available to OAuth endpoints
    "",
    !isDev,
    true,
)
```

### Known Issues

**State parameter validation**: The OAuth state parameter is currently hardcoded:
```go
state := "state-token"  // TODO: Generate random state and store in session
```

This is a security concern - should generate random state per request.

## Password Auth

### Current Implementation

```go
// backend/api/auth.go
func (h *Handlers) Login(c *gin.Context) {
    // Uses SHA256 hash (NOT secure for passwords)
    // Should use bcrypt/argon2
    hash := sha256.Sum256([]byte(password))
    // ...

    // TODO: Session storage not implemented
    // Note: We'd need to add a CreateSession function to db package
}
```

### Security Concerns

1. **SHA256 for passwords** - Vulnerable to rainbow table attacks. Should use bcrypt/argon2/scrypt
2. **No session storage** - Password sessions are not persisted to database
3. **No CSRF protection** - No token validation

## Route Protection

> **Important**: There is currently **NO route protection middleware**.

Routes in `backend/api/routes.go` are registered **without** any authentication middleware:

```go
// Current state - all routes are public
api := router.Group("/api")
api.GET("/inbox", h.GetInbox)  // No middleware
api.POST("/files", h.UploadFile)  // No middleware
```

Authentication is only enforced by:
1. Frontend AuthContext checking auth state
2. `fetch-with-refresh.ts` handling 401 errors

## Frontend Integration

### AuthContext

```typescript
// frontend/app/contexts/auth-context.tsx
// Note: Actual implementation is simpler than previously documented

const AuthContext = createContext<{
    isAuthenticated: boolean
    isLoading: boolean
    checkAuth: () => Promise<void>
}>()
```

The context checks auth by calling `/api/settings` - if it succeeds, user is authenticated.

### Token Refresh

```typescript
// frontend/app/lib/fetch-with-refresh.ts
export async function fetchWithRefresh(url: string, options: RequestInit) {
    const response = await fetch(url, options);

    if (response.status === 401) {
        // Try to refresh token
        const refreshResponse = await fetch('/api/oauth/refresh', {
            method: 'POST',
            credentials: 'include',
        });

        if (refreshResponse.ok) {
            // Retry original request
            return fetch(url, options);
        }

        // Refresh failed, redirect to login
        window.location.href = '/login';
    }

    return response;
}
```

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/login` | POST | Password login |
| `/api/auth/logout` | POST | Logout (all modes) |
| `/api/oauth/authorize` | GET | Start OAuth flow |
| `/api/oauth/callback` | GET | OAuth callback (receives code) |
| `/api/oauth/refresh` | POST | Refresh access token |
| `/api/oauth/logout` | POST | OAuth logout (clears cookies) |

## Common Modifications

### Adding Route Protection

To actually protect routes, you would need to add middleware:

```go
// backend/auth/middleware.go (to create)
func RequireAuth() gin.HandlerFunc {
    return func(c *gin.Context) {
        mode := GetAuthMode()
        if mode == AuthModeNone {
            c.Next()
            return
        }

        // Check token/session based on mode
        if mode == AuthModeOAuth {
            token, err := c.Cookie("access_token")
            if err != nil || token == "" {
                c.AbortWithStatus(401)
                return
            }
            // Validate token...
        }

        c.Next()
    }
}

// backend/api/routes.go
protected := router.Group("/api")
protected.Use(auth.RequireAuth())
protected.GET("/inbox", h.GetInbox)
```

### Fixing Password Auth Security

```go
// Use bcrypt instead of SHA256
import "golang.org/x/crypto/bcrypt"

hashedPassword, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
err := bcrypt.CompareHashAndPassword(hashedPassword, []byte(inputPassword))
```

### Adding Session Storage

```go
// backend/db/sessions.go (to create)
type Session struct {
    ID        string
    UserID    string
    ExpiresAt time.Time
    CreatedAt time.Time
}

func CreateSession(userID string) (*Session, error)
func GetSession(sessionID string) (*Session, error)
func DeleteSession(sessionID string) error
```

## Files to Modify

| Task | Files |
|------|-------|
| Add auth middleware | Create `backend/auth/middleware.go` |
| Fix password hashing | `backend/api/auth.go` |
| Add session storage | Create `backend/db/sessions.go` |
| Change OAuth flow | `backend/api/oauth.go` |
| Frontend auth state | `frontend/app/contexts/auth-context.tsx` |
