// Package auth implements OpenID Connect login (Authorization Code flow with
// PKCE S256, state and nonce) and signed cookie sessions.
package auth

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"
)

const (
	// MinSecretBytes is the minimum accepted SESSION_SECRET length.
	MinSecretBytes = 32

	sessionCookie = "session"
	flowCookie    = "oidc_flow"
	sessionTTL    = 12 * time.Hour
	flowTTL       = 10 * time.Minute
	discoveryTTL  = 10 * time.Second
)

// Config holds the OIDC and session settings. An empty Issuer disables auth.
type Config struct {
	Issuer        string
	ClientID      string
	ClientSecret  string
	RedirectURL   string
	SessionSecret string
	// CookieSecure sets the Secure attribute on cookies. Only disable for
	// plain-http local development.
	CookieSecure bool
	// HTTPClient is optional and used for discovery, JWKS and token requests.
	HTTPClient *http.Client
}

// User is the authenticated identity stored in the session.
type User struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Auth handles login, callback, logout and session lookup.
type Auth struct {
	cfg        Config
	sessionKey []byte
	flowKey    []byte

	mu       sync.Mutex
	provider *oidc.Provider
}

// New validates cfg. It never contacts the identity provider; discovery is
// performed lazily on the first login attempt.
func New(cfg Config) (*Auth, error) {
	a := &Auth{cfg: cfg}
	if cfg.Issuer == "" {
		return a, nil
	}
	if len(cfg.SessionSecret) < MinSecretBytes {
		return nil, fmt.Errorf("SESSION_SECRET must be at least %d bytes when OIDC_ISSUER is set", MinSecretBytes)
	}
	if cfg.ClientID == "" || cfg.RedirectURL == "" {
		return nil, errors.New("OIDC_CLIENT_ID and OIDC_REDIRECT_URL are required when OIDC_ISSUER is set")
	}
	a.sessionKey = deriveKey(cfg.SessionSecret, "session")
	a.flowKey = deriveKey(cfg.SessionSecret, "oidc-flow")
	return a, nil
}

// Enabled reports whether OIDC is configured.
func (a *Auth) Enabled() bool { return a != nil && a.cfg.Issuer != "" }

func deriveKey(secret, purpose string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(purpose))
	return m.Sum(nil)
}

// ---- signed cookie helpers ----

func sign(key, payload []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func unsign(key []byte, value string) ([]byte, bool) {
	p, s, ok := strings.Cut(value, ".")
	if !ok {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return nil, false
	}
	got, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, false
	}
	m := hmac.New(sha256.New, key)
	m.Write(payload)
	if !hmac.Equal(got, m.Sum(nil)) {
		return nil, false
	}
	return payload, true
}

type sessionData struct {
	Name  string `json:"n"`
	Email string `json:"e"`
	Exp   int64  `json:"x"`
}

type flowData struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Exp      int64  `json:"x"`
}

func (a *Auth) setCookie(c *gin.Context, name, value, path string, ttl time.Duration) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     path,
		MaxAge:   int(ttl / time.Second),
		HttpOnly: true,
		Secure:   a.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (a *Auth) clearCookie(c *gin.Context, name, path string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     path,
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   a.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func randomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// CurrentUser returns the logged-in user from the session cookie, if any.
func (a *Auth) CurrentUser(r *http.Request) (User, bool) {
	if !a.Enabled() {
		return User{}, false
	}
	ck, err := r.Cookie(sessionCookie)
	if err != nil {
		return User{}, false
	}
	payload, ok := unsign(a.sessionKey, ck.Value)
	if !ok {
		return User{}, false
	}
	var s sessionData
	if err := json.Unmarshal(payload, &s); err != nil || time.Now().Unix() >= s.Exp {
		return User{}, false
	}
	return User{Name: s.Name, Email: s.Email}, true
}

// ---- OIDC ----

func (a *Auth) getProvider(ctx context.Context) (*oidc.Provider, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.provider != nil {
		return a.provider, nil
	}
	ctx, cancel := context.WithTimeout(ctx, discoveryTTL)
	defer cancel()
	if a.cfg.HTTPClient != nil {
		ctx = oidc.ClientContext(ctx, a.cfg.HTTPClient)
	}
	p, err := oidc.NewProvider(ctx, a.cfg.Issuer)
	if err != nil {
		return nil, err
	}
	a.provider = p
	return p, nil
}

func (a *Auth) oauthConfig(p *oidc.Provider) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     a.cfg.ClientID,
		ClientSecret: a.cfg.ClientSecret,
		RedirectURL:  a.cfg.RedirectURL,
		Endpoint:     p.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}
}

func fail(c *gin.Context, status int, msg string) {
	c.Header("Cache-Control", "no-store")
	c.AbortWithStatusJSON(status, gin.H{"error": msg})
}

// Login redirects the browser to the identity provider.
func (a *Auth) Login(c *gin.Context) {
	if !a.Enabled() {
		fail(c, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	p, err := a.getProvider(c.Request.Context())
	if err != nil {
		log.Printf("auth: OIDC discovery failed: %v", err)
		fail(c, http.StatusServiceUnavailable, "identity provider is unavailable")
		return
	}
	state, err1 := randomString(32)
	nonce, err2 := randomString(32)
	if err1 != nil || err2 != nil {
		fail(c, http.StatusInternalServerError, "could not start login")
		return
	}
	verifier := oauth2.GenerateVerifier()
	payload, _ := json.Marshal(flowData{State: state, Nonce: nonce, Verifier: verifier, Exp: time.Now().Add(flowTTL).Unix()})
	a.setCookie(c, flowCookie, sign(a.flowKey, payload), "/auth", flowTTL)

	url := a.oauthConfig(p).AuthCodeURL(state,
		oauth2.S256ChallengeOption(verifier),
		oidc.Nonce(nonce),
	)
	c.Header("Cache-Control", "no-store")
	c.Redirect(http.StatusFound, url)
}

// Callback completes the Authorization Code flow and creates the session.
func (a *Auth) Callback(c *gin.Context) {
	if !a.Enabled() {
		fail(c, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	ck, err := c.Request.Cookie(flowCookie)
	if err != nil {
		fail(c, http.StatusBadRequest, "login session expired, please try again")
		return
	}
	// The flow cookie is single-use regardless of the outcome. This must
	// happen before any response body is written.
	a.clearCookie(c, flowCookie, "/auth")
	payload, ok := unsign(a.flowKey, ck.Value)
	var flow flowData
	if !ok || json.Unmarshal(payload, &flow) != nil || time.Now().Unix() >= flow.Exp {
		fail(c, http.StatusBadRequest, "login session invalid or expired")
		return
	}
	state := c.Query("state")
	if state == "" || subtle.ConstantTimeCompare([]byte(state), []byte(flow.State)) != 1 {
		fail(c, http.StatusBadRequest, "state mismatch")
		return
	}
	if e := c.Query("error"); e != "" {
		log.Printf("auth: provider returned error %q: %s", e, c.Query("error_description"))
		fail(c, http.StatusUnauthorized, "login was denied by the identity provider")
		return
	}
	code := c.Query("code")
	if code == "" {
		fail(c, http.StatusBadRequest, "missing authorization code")
		return
	}

	p, err := a.getProvider(c.Request.Context())
	if err != nil {
		log.Printf("auth: OIDC discovery failed: %v", err)
		fail(c, http.StatusServiceUnavailable, "identity provider is unavailable")
		return
	}
	ctx := c.Request.Context()
	if a.cfg.HTTPClient != nil {
		ctx = context.WithValue(ctx, oauth2.HTTPClient, a.cfg.HTTPClient)
		ctx = oidc.ClientContext(ctx, a.cfg.HTTPClient)
	}
	tok, err := a.oauthConfig(p).Exchange(ctx, code, oauth2.VerifierOption(flow.Verifier))
	if err != nil {
		log.Printf("auth: code exchange failed: %v", err)
		fail(c, http.StatusUnauthorized, "code exchange failed")
		return
	}
	rawID, _ := tok.Extra("id_token").(string)
	if rawID == "" {
		fail(c, http.StatusUnauthorized, "identity provider returned no ID token")
		return
	}
	idToken, err := p.Verifier(&oidc.Config{ClientID: a.cfg.ClientID}).Verify(ctx, rawID)
	if err != nil {
		log.Printf("auth: ID token verification failed: %v", err)
		fail(c, http.StatusUnauthorized, "invalid ID token")
		return
	}
	if subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(flow.Nonce)) != 1 {
		fail(c, http.StatusUnauthorized, "nonce mismatch")
		return
	}
	var claims struct {
		Name              string `json:"name"`
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		fail(c, http.StatusUnauthorized, "invalid ID token claims")
		return
	}
	name := claims.Name
	if name == "" {
		name = claims.PreferredUsername
	}
	if name == "" {
		name = claims.Email
	}
	if name == "" {
		name = idToken.Subject
	}
	sess, _ := json.Marshal(sessionData{Name: name, Email: claims.Email, Exp: time.Now().Add(sessionTTL).Unix()})
	a.setCookie(c, sessionCookie, sign(a.sessionKey, sess), "/", sessionTTL)
	c.Header("Cache-Control", "no-store")
	c.Redirect(http.StatusSeeOther, "/")
}

// Logout clears the session. JSON clients get 204, browsers a redirect to /.
func (a *Auth) Logout(c *gin.Context) {
	a.clearCookie(c, sessionCookie, "/")
	c.Header("Cache-Control", "no-store")
	if strings.Contains(c.GetHeader("Accept"), "application/json") {
		c.Status(http.StatusNoContent)
		return
	}
	c.Redirect(http.StatusSeeOther, "/")
}
