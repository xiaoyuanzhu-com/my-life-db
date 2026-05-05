# User Management Flows — Design Doc

**Date:** 2026-03-07
**Status:** Approved
**Scope:** Product-level user flow definitions for the Xiao Yuan Zhu account system (Authentik) to prepare for public registration.

## Context

Xiao Yuan Zhu runs Authentik as the central identity provider. All apps (MyLifeDB, future apps) are OIDC clients — users create one Xiao Yuan Zhu account and use it across all apps.

Today, account creation is invitation-only. We are opening to public registration with email verification as the activation gate.

## Architecture

```
┌──────────────┐     OIDC      ┌───────────┐
│  MyLifeDB    │◄─────────────►│           │
├──────────────┤               │ Authentik  │
│  Future App  │◄─────────────►│ (IdP)     │
├──────────────┤               │           │
│  Future App  │◄─────────────►│           │
└──────────────┘               └───────────┘
```

**Key principles:**
- All user-facing auth flows (sign up, login, reset password) happen on Authentik's hosted pages. Apps never build their own auth UI — they redirect to Authentik and get tokens back via OIDC.
- Apps remove `MLD_EXPECTED_USERNAME` restriction (or make it optional) to support multiple users.

---

## User Properties

The Authentik user record — the single source of truth for identity across all apps.

| Property | Type | Rules | Set By | Notes |
|----------|------|-------|--------|-------|
| `username` | string | **Lowercase only**. Alphanumeric + hyphens + underscores. 3-30 chars. Unique. | User (at sign up) | Silently converted to lowercase on input. URL-safe (e.g., `/u/xiaoyuan`). Immutable after creation (for now). |
| `email` | string | Valid email format. Unique (one account per email). | User (at sign up) | Used for verification and recovery. Not shown publicly. |
| `password` | string (hashed) | Min 8 chars. Checked against common password lists. | User | Stored as hash by Authentik. Never exposed via API. |
| `is_active` | boolean | Default: `false` | System | Set to `true` after email verification. Inactive users cannot log in. |
| `email_verified` | boolean | Default: `false` | System | Set to `true` when user clicks verification link. Gates `is_active`. |
| `date_joined` | timestamp | Auto-set on creation. | System | When the account was created. |
| `last_login` | timestamp | Auto-updated on each login. | System | Tracked by Authentik automatically. |
| `name` | string | Optional. Free-form display name. | User (optional) | Separate from username. Can contain spaces, mixed case, emoji, etc. |

**OIDC claims mapping** — what apps receive in the ID token:

| OIDC Claim | Authentik Property | Used By Apps |
|------------|-------------------|--------------|
| `sub` | Internal UUID | Stable user identifier (never changes) |
| `preferred_username` | `username` | Display identity, URL-safe |
| `email` | `email` | Contact / notifications |
| `email_verified` | `email_verified` | Trust level check |
| `name` | `name` | Display name (if set) |

---

## Flow 1: Sign Up (Create Account)

**Trigger:** User clicks "Sign Up" on any app, or navigates to Authentik enrollment page directly.

**Steps:**
1. User is redirected to Authentik enrollment page
2. User enters: **username**, **email**, **password**
3. Authentik validates inputs (see validation rules below)
4. Authentik creates account with status **INACTIVE**
5. Authentik sends verification email with a time-limited link
6. User sees a "Check your email" confirmation page

**Validation rules:**
| Field | Rules |
|-------|-------|
| Username | **Lowercase only**. Alphanumeric + hyphens/underscores, 3-30 chars. Unique. Silently lowercased on input. |
| Email | Valid format, unique (one account per email) |
| Password | Minimum 8 characters, checked against common password lists (Authentik built-in) |

**Error handling:**
- Username taken → "This username is already taken"
- Email taken → generic "Unable to create account" (no user enumeration — do not reveal that the email is registered)
- Weak password → "Password does not meet requirements"

---

## Flow 2: Email Verification

**Trigger:** User clicks the verification link in their email.

**Steps:**
1. User clicks link in email
2. Authentik verifies the token
3. Account status changes: **INACTIVE → ACTIVE**
4. User is redirected to login page (or auto-logged in)

**Edge cases:**
- **Link expired (>24 hours):** Show "This link has expired" with option to request a new verification email
- **Link already used:** Show "Your email is already verified" with link to login
- **User tries to log in while inactive:** Show "Please verify your email first" with a resend verification option

---

## Flow 3: Login

**Trigger:** User clicks "Login" on any app.

**Steps:**
1. App redirects user to Authentik login page
2. User enters **email or username** + **password**
3. Authentik validates credentials
4. On success: Authentik issues OIDC tokens, redirects back to app
5. App stores tokens (cookies) and establishes session

**Error handling:**
- Invalid credentials → generic "Invalid email/username or password" (no user enumeration)
- Inactive account → "Please verify your email first" + resend option
- Rate limiting on failed attempts (Authentik built-in)

---

## Flow 4: Logout

**Trigger:** User clicks "Logout" in an app.

**Steps:**
1. App clears local session cookies (`access_token`, `refresh_token`, `session`)
2. User is returned to the app's login/landing page

**Scope:**
- Per-app logout only — does NOT end the Authentik SSO session
- Other apps remain logged in until their tokens expire
- SSO logout (ending Authentik session across all apps) can be added later if needed

---

## Flow 5: Forgot Password / Reset Password

**Trigger:** User clicks "Forgot password?" on the login page.

**Steps:**
1. User enters their email address
2. Authentik sends a password reset email with a time-limited link (**1 hour** expiry)
3. User clicks link → enters new password → confirms
4. Password is updated
5. All existing sessions are invalidated
6. User is redirected to login page

**Security:**
- Same response whether email exists or not: "If an account exists with this email, a reset link has been sent" (no user enumeration)
- Link is single-use — cannot be reused after password is reset
- All active sessions (across all apps) are invalidated after reset

---

## Flow 6: Change Password (Authenticated)

**Trigger:** User navigates to Authentik self-service profile page.

**Steps:**
1. User enters current password
2. User enters new password + confirmation
3. Authentik validates new password (same rules as sign up)
4. Password is updated

**Notes:**
- Accessible from Authentik's built-in user profile page
- Apps can link to this page but do not implement it themselves
- Session invalidation is optional (user stays logged in on current device)

---

## Security Baseline

Cross-cutting concerns that apply to all flows:

| Concern | Approach |
|---------|----------|
| **No user enumeration** | Sign up (email field), login, and password reset all return generic messages — never reveal whether an email exists |
| **Rate limiting** | Authentik built-in rate limiting on login, sign up, and password reset endpoints |
| **Password policy** | Min 8 chars, common password list check (Authentik built-in) |
| **Session management** | OIDC tokens with refresh; password reset invalidates all sessions |
| **Email as trust anchor** | Email verification gates account activation; email is the recovery channel |
| **CSRF protection** | OAuth state parameter (already implemented in MyLifeDB) |
| **Secure cookies** | httpOnly, Secure flag in production (already implemented in MyLifeDB) |

---

## What Changes in MyLifeDB

To support multi-user after public registration:

1. **Remove or make optional** the `MLD_EXPECTED_USERNAME` check — currently rejects any user whose username doesn't match the configured value
2. **Keep everything else** — the existing OIDC flow, token handling, cookie management, and auth middleware all work as-is for multiple users

---

## Out of Scope (for now)

These flows are explicitly deferred:

- Social login (Google, GitHub, etc.)
- Multi-factor authentication (MFA/2FA)
- Account deletion (self-service)
- Change email (self-service)
- Admin flows (suspend/ban users)
- SSO logout (cross-app session termination)

These can be added incrementally later without changing the core flows above.
