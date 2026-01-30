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
| `backend/auth/auth.go` | Auth middleware, mode detection |
| `backend/auth/password.go` | Password authentication |
| `backend/auth/oauth.go` | OAuth/OIDC implementation |
| `backend/api/auth.go` | Auth HTTP handlers |
| `frontend/app/contexts/auth-context.tsx` | Frontend auth state |

## Middleware

```go
// backend/auth/auth.go
func Middleware(mode string) gin.HandlerFunc {
    return func(c *gin.Context) {
        switch mode {
        case "none":
            c.Next()  // Allow all
        case "password":
            validatePasswordSession(c)
        case "oauth":
            validateOAuthToken(c)
        }
    }
}
```

The middleware is applied to protected routes in `api/routes.go`.

## Password Auth

Simple session-based authentication:

```go
// Login: POST /api/auth/login
// - Validates password against MLD_PASSWORD env var
// - Sets secure session cookie
// - Returns success/failure

// Logout: POST /api/auth/logout
// - Clears session cookie
```

Session stored in secure HTTP-only cookie.

## OAuth/OIDC

Standard OAuth 2.0 Authorization Code flow:

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
   |<-- set session cookie ---|                            |
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

### Token Management

- Access tokens stored in session
- Refresh tokens used to get new access tokens
- Automatic refresh before expiration

## Frontend Integration

```typescript
// frontend/app/contexts/auth-context.tsx
const AuthContext = createContext<{
    user: User | null
    isAuthenticated: boolean
    login: () => void
    logout: () => void
}>()

// Protected route wrapper
const ProtectedRoute = ({ children }) => {
    const { isAuthenticated } = useAuth()
    if (!isAuthenticated) {
        return <Navigate to="/login" />
    }
    return children
}
```

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/login` | POST | Password login |
| `/api/auth/logout` | POST | Logout (all modes) |
| `/api/auth/me` | GET | Get current user |
| `/api/oauth/authorize` | GET | Start OAuth flow |
| `/api/oauth/callback` | GET | OAuth callback |
| `/api/oauth/token` | POST | Token exchange |
| `/api/oauth/refresh` | POST | Refresh token |

## Common Modifications

### Adding a new auth mode

1. Add mode constant in `backend/auth/auth.go`
2. Add case in middleware switch
3. Implement validation logic
4. Add necessary handlers in `backend/api/auth.go`

### Adding role-based access

```go
// Extend user struct
type User struct {
    ID    string
    Email string
    Roles []string  // Add roles
}

// Add role middleware
func RequireRole(role string) gin.HandlerFunc {
    return func(c *gin.Context) {
        user := GetUser(c)
        if !slices.Contains(user.Roles, role) {
            c.AbortWithStatus(403)
            return
        }
        c.Next()
    }
}
```

### Customizing session duration

- Password mode: modify cookie expiration in `password.go`
- OAuth mode: tied to token expiration from provider

## Files to Modify

| Task | Files |
|------|-------|
| Modify auth logic | `backend/auth/auth.go` |
| Change password auth | `backend/auth/password.go` |
| Change OAuth flow | `backend/auth/oauth.go` |
| Add auth endpoints | `backend/api/auth.go` |
| Frontend auth state | `frontend/app/contexts/auth-context.tsx` |
