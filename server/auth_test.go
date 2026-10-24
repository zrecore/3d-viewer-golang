package server

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/zrecore/3d-viewer-golang/auth"
)

type meBody struct {
	Authenticated bool `json:"authenticated"`
	User          *struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"user"`
}

func (a *app) me() meBody {
	a.t.Helper()
	resp, body := a.get("/api/me")
	if resp.StatusCode != 200 {
		a.t.Fatalf("/api/me status %d", resp.StatusCode)
	}
	var m meBody
	if err := json.Unmarshal(body, &m); err != nil {
		a.t.Fatal(err)
	}
	return m
}

func TestMeAnonymous(t *testing.T) {
	for _, withAuth := range []bool{false, true} {
		a := newApp(t, withAuth, 1)
		resp, body := a.get("/api/me")
		var raw map[string]any
		_ = json.Unmarshal(body, &raw)
		if resp.StatusCode != 200 || raw["authenticated"] != false {
			t.Errorf("withAuth=%v: %d %s", withAuth, resp.StatusCode, body)
		}
		if _, ok := raw["user"]; ok {
			t.Errorf("user must be omitted: %s", body)
		}
	}
}

func TestLoginRedirectParameters(t *testing.T) {
	a := newApp(t, true, 1)
	resp, _ := a.get("/auth/login")
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status %d", resp.StatusCode)
	}
	u, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || !strings.HasPrefix(u.String(), a.idp.Issuer()+"/authorize") {
		t.Fatalf("location %v", resp.Header.Get("Location"))
	}
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" ||
		len(q.Get("state")) < 16 || len(q.Get("nonce")) < 16 || q.Get("response_type") != "code" ||
		q.Get("redirect_uri") != a.cfg.Auth.RedirectURL || !strings.Contains(q.Get("scope"), "openid") {
		t.Errorf("bad params: %v", q)
	}
	var flow *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "oidc_flow" {
			flow = c
		}
	}
	if flow == nil || !flow.HttpOnly || flow.SameSite != http.SameSiteLaxMode || flow.MaxAge <= 0 {
		t.Errorf("flow cookie: %+v", flow)
	}
}

func TestAuthFlowSuccessAndLogout(t *testing.T) {
	a := newApp(t, true, 1)
	if a.me().Authenticated {
		t.Fatal("authenticated before login")
	}
	a.login()
	m := a.me()
	if !m.Authenticated || m.User == nil || m.User.Name != "Test User" || m.User.Email != "test@example.com" {
		t.Fatalf("me after login: %+v", m)
	}

	// Session cookie attributes.
	u, _ := url.Parse(a.srv.URL)
	var sess *http.Cookie
	for _, c := range a.client.Jar.Cookies(u) {
		if c.Name == "session" {
			sess = c
		}
	}
	if sess == nil {
		t.Fatal("no session cookie in jar")
	}

	// Logout (browser style: redirect).
	resp, _ := a.do("POST", "/auth/logout", nil, nil)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/" {
		t.Errorf("logout: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if a.me().Authenticated {
		t.Error("still authenticated after logout")
	}
	// Logout (JSON style).
	a.login()
	resp, _ = a.do("POST", "/auth/logout", nil, map[string]string{"Accept": "application/json"})
	if resp.StatusCode != http.StatusNoContent || a.me().Authenticated {
		t.Errorf("json logout: %d", resp.StatusCode)
	}
	// GET must not log out / is not routed.
	a.login()
	if resp, _ = a.get("/auth/logout"); resp.StatusCode == 200 || resp.StatusCode == 303 || !a.me().Authenticated {
		t.Errorf("GET /auth/logout: %d", resp.StatusCode)
	}
}

func TestAuthCallbackRejections(t *testing.T) {
	tests := []struct {
		name   string
		setup  func(a *app)
		tamper func(cb string) string
		want   int
	}{
		{name: "state mismatch", want: 400,
			tamper: func(cb string) string { return replaceQuery(cb, "state", "forged-state") }},
		{name: "missing state", want: 400,
			tamper: func(cb string) string { return replaceQuery(cb, "state", "") }},
		{name: "missing code", want: 400, // state valid, code empty
			tamper: func(cb string) string { return replaceQuery(cb, "code", "") }},
		{name: "unknown code", want: 401,
			tamper: func(cb string) string { return replaceQuery(cb, "code", "bogus") }},
		{name: "provider error", want: 401,
			tamper: func(cb string) string { return "/auth/callback?error=access_denied&state=" + queryOf(cb, "state") }},
		{name: "nonce mismatch", want: 401, setup: func(a *app) { a.idp.NonceOverride = "attacker-nonce" }},
		{name: "token signed with wrong key", want: 401, setup: func(a *app) { a.idp.WrongKey = true }},
		{name: "wrong audience", want: 401, setup: func(a *app) { a.idp.Audience = "someone-else" }},
		{name: "expired token", want: 401, setup: func(a *app) { a.idp.Expired = true }},
		{name: "no id_token in response", want: 401, setup: func(a *app) { a.idp.OmitIDToken = true }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := newApp(t, true, 1)
			if tt.setup != nil {
				tt.setup(a)
			}
			resp, _ := a.get("/auth/login")
			cb := a.authorize(resp.Header.Get("Location"))
			if tt.tamper != nil {
				cb = tt.tamper(cb)
			}
			resp, body := a.get(cb)
			if resp.StatusCode != tt.want {
				t.Fatalf("status %d, want %d (%s)", resp.StatusCode, tt.want, body)
			}
			var e errBody
			if json.Unmarshal(body, &e) != nil || e.Error == "" {
				t.Errorf("error body %s", body)
			}
			if a.me().Authenticated {
				t.Error("authenticated despite rejection")
			}
			if resp, _ := a.upload("x.stl", binarySTL(1)); resp.StatusCode != 401 {
				t.Errorf("upload status %d, want 401", resp.StatusCode)
			}
		})
	}
}

func TestCallbackWithoutFlowCookieAndReplay(t *testing.T) {
	a := newApp(t, true, 1)
	resp, _ := a.get("/auth/callback?code=x&state=y")
	if resp.StatusCode != 400 {
		t.Errorf("no flow cookie: %d", resp.StatusCode)
	}
	// Replay: after a successful callback the flow cookie is gone.
	resp, _ = a.get("/auth/login")
	cb := a.authorize(resp.Header.Get("Location"))
	if resp, _ = a.get(cb); resp.StatusCode != 303 {
		t.Fatalf("first callback %d", resp.StatusCode)
	}
	if resp, _ = a.get(cb); resp.StatusCode != 400 {
		t.Errorf("replayed callback %d, want 400", resp.StatusCode)
	}
}

func TestForgedSessionCookie(t *testing.T) {
	a := newApp(t, true, 1)
	a.login()
	u, _ := url.Parse(a.srv.URL)
	var val string
	for _, c := range a.client.Jar.Cookies(u) {
		if c.Name == "session" {
			val = c.Value
		}
	}
	payload, sig, _ := strings.Cut(val, ".")
	for name, v := range map[string]string{
		"bad signature": payload + ".AAAA",
		"no signature":  payload,
		"garbage":       "xyz",
		"swapped sig":   sig + "." + payload,
	} {
		req, _ := http.NewRequest("GET", a.srv.URL+"/api/me", nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: v})
		fresh := &app{t: t, srv: a.srv, client: &http.Client{}}
		_, body := fresh.send(req)
		if !strings.Contains(string(body), `"authenticated":false`) {
			t.Errorf("%s accepted: %s", name, body)
		}
	}
}

func TestProviderUnreachableDegrades(t *testing.T) {
	a := newApp(t, true, 1)
	a.idp.Close() // provider goes away; server must keep serving
	resp, body := a.get("/auth/login")
	var e errBody
	if resp.StatusCode != 503 || json.Unmarshal(body, &e) != nil || e.Error == "" {
		t.Errorf("login: %d %s", resp.StatusCode, body)
	}
	if resp, _ := a.get("/api/models"); resp.StatusCode != 200 {
		t.Errorf("models: %d", resp.StatusCode)
	}
}

func TestAuthDisabledRoutes(t *testing.T) {
	a := newApp(t, false, 1)
	for _, p := range []string{"/auth/login", "/auth/callback"} {
		if resp, _ := a.get(p); resp.StatusCode != 503 {
			t.Errorf("%s: %d, want 503", p, resp.StatusCode)
		}
	}
}

func TestAuthNewValidation(t *testing.T) {
	good := auth.Config{Issuer: "http://x", ClientID: "c", RedirectURL: "http://x/cb", SessionSecret: strings.Repeat("s", 32)}
	if a, err := auth.New(auth.Config{}); err != nil || a.Enabled() {
		t.Errorf("empty config must be disabled without error: %v", err)
	}
	if a, err := auth.New(good); err != nil || !a.Enabled() {
		t.Errorf("good config: %v", err)
	}
	short := good
	short.SessionSecret = "too-short"
	if _, err := auth.New(short); err == nil {
		t.Error("short secret accepted")
	}
	noClient := good
	noClient.ClientID = ""
	if _, err := auth.New(noClient); err == nil {
		t.Error("missing client id accepted")
	}
}

func TestSecureCookieFlag(t *testing.T) {
	a := newApp(t, true, 1)
	a.cfg.Auth.CookieSecure = true
	au, _ := auth.New(a.cfg.Auth)
	r, _ := New(a.cfg, au)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/auth/login", nil)
	r.ServeHTTP(w, req)
	found := false
	for _, c := range w.Result().Cookies() {
		if c.Name == "oidc_flow" {
			found = true
			if !c.Secure || !c.HttpOnly {
				t.Errorf("flow cookie flags: %+v", c)
			}
		}
	}
	if !found {
		t.Error("no flow cookie")
	}
}

func queryOf(path, key string) string {
	u, _ := url.Parse(path)
	return u.Query().Get(key)
}

func replaceQuery(path, key, val string) string {
	u, _ := url.Parse(path)
	q := u.Query()
	if val == "" {
		q.Del(key)
	} else {
		q.Set(key, val)
	}
	u.RawQuery = q.Encode()
	return u.RequestURI()
}
