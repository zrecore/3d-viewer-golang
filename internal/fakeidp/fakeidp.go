// Package fakeidp is a minimal OpenID Connect provider for tests. It serves
// discovery, JWKS, authorize and token endpoints and signs ID tokens with a
// generated RSA key.
package fakeidp

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

const kid = "test-key"

type codeRecord struct {
	nonce     string
	challenge string
}

// IDP is a fake identity provider. Exported fields tweak the tokens it issues.
type IDP struct {
	Server       *httptest.Server
	ClientID     string
	ClientSecret string

	// Per-test knobs, set before the callback happens.
	Name          string
	Email         string
	NonceOverride string // when set, replaces the nonce in the ID token
	WrongKey      bool   // sign with a key that is not in the JWKS
	Audience      string // when set, replaces aud
	Expired       bool
	OmitIDToken   bool

	key      *rsa.PrivateKey
	otherKey *rsa.PrivateKey

	mu    sync.Mutex
	codes map[string]codeRecord
}

// New starts the provider. Call Close when done.
func New(clientID, clientSecret string) *IDP {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	p := &IDP{
		ClientID: clientID, ClientSecret: clientSecret,
		Name: "Test User", Email: "test@example.com",
		key: key, otherKey: other, codes: map[string]codeRecord{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", p.discovery)
	mux.HandleFunc("/keys", p.keys)
	mux.HandleFunc("/authorize", p.authorize)
	mux.HandleFunc("/token", p.token)
	p.Server = httptest.NewServer(mux)
	return p
}

// Close stops the server.
func (p *IDP) Close() { p.Server.Close() }

// Issuer is the issuer URL.
func (p *IDP) Issuer() string { return p.Server.URL }

func (p *IDP) discovery(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"issuer":                                p.Issuer(),
		"authorization_endpoint":                p.Issuer() + "/authorize",
		"token_endpoint":                        p.Issuer() + "/token",
		"jwks_uri":                              p.Issuer() + "/keys",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"code_challenge_methods_supported":      []string{"S256"},
	})
}

func (p *IDP) keys(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
		{Key: &p.key.PublicKey, KeyID: kid, Algorithm: "RS256", Use: "sig"},
	}})
}

func randHex() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// authorize requires S256 PKCE, then redirects back with a code and the state.
func (p *IDP) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("response_type") != "code" || q.Get("client_id") != p.ClientID ||
		q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" ||
		q.Get("state") == "" || q.Get("nonce") == "" || q.Get("redirect_uri") == "" {
		http.Error(w, "bad authorize request", http.StatusBadRequest)
		return
	}
	code := randHex()
	p.mu.Lock()
	p.codes[code] = codeRecord{nonce: q.Get("nonce"), challenge: q.Get("code_challenge")}
	p.mu.Unlock()
	u, _ := url.Parse(q.Get("redirect_uri"))
	v := u.Query()
	v.Set("code", code)
	v.Set("state", q.Get("state"))
	u.RawQuery = v.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

func (p *IDP) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	id, secret, ok := r.BasicAuth()
	if ok {
		// oauth2 form-encodes credentials in the Basic header.
		id, _ = url.QueryUnescape(id)
		secret, _ = url.QueryUnescape(secret)
	} else {
		id, secret = r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
	}
	if id != p.ClientID || secret != p.ClientSecret {
		tokenErr(w, "invalid_client")
		return
	}
	p.mu.Lock()
	rec, found := p.codes[r.PostForm.Get("code")]
	delete(p.codes, r.PostForm.Get("code"))
	p.mu.Unlock()
	if !found || r.PostForm.Get("grant_type") != "authorization_code" {
		tokenErr(w, "invalid_grant")
		return
	}
	sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != rec.challenge {
		tokenErr(w, "invalid_grant")
		return
	}
	resp := map[string]any{"access_token": randHex(), "token_type": "Bearer", "expires_in": 3600}
	if !p.OmitIDToken {
		resp["id_token"] = p.signToken(rec.nonce)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func tokenErr(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

func (p *IDP) signToken(nonce string) string {
	if p.NonceOverride != "" {
		nonce = p.NonceOverride
	}
	aud := p.ClientID
	if p.Audience != "" {
		aud = p.Audience
	}
	exp := time.Now().Add(time.Hour)
	if p.Expired {
		exp = time.Now().Add(-time.Hour)
	}
	key := p.key
	if p.WrongKey {
		key = p.otherKey
	}
	signer, _ := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", kid),
	)
	raw, _ := jwt.Signed(signer).Claims(jwt.Claims{
		Issuer:   p.Issuer(),
		Subject:  "user-123",
		Audience: jwt.Audience{aud},
		Expiry:   jwt.NewNumericDate(exp),
		IssuedAt: jwt.NewNumericDate(time.Now().Add(-time.Minute)),
	}).Claims(map[string]any{
		"nonce": nonce, "name": p.Name, "email": p.Email,
	}).Serialize()
	return raw
}
