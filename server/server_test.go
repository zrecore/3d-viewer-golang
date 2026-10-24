package server

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/zrecore/3d-viewer-golang/auth"
	"github.com/zrecore/3d-viewer-golang/internal/fakeidp"
)

const (
	testClientID     = "test-client"
	testClientSecret = "test-secret"
	testSessionKey   = "0123456789abcdef0123456789abcdef-session"
)

func init() {
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
}

func binarySTL(n int) []byte {
	b := make([]byte, 84+50*n)
	binary.LittleEndian.PutUint32(b[80:], uint32(n))
	return b
}

type app struct {
	t      *testing.T
	cfg    Config
	srv    *httptest.Server
	idp    *fakeidp.IDP // nil when auth disabled
	client *http.Client // keeps cookies, never follows redirects
}

type swapHandler struct{ h http.Handler }

func (s *swapHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.h.ServeHTTP(w, r) }

// newApp starts the app. withAuth wires it to a fake OIDC provider.
func newApp(t *testing.T, withAuth bool, maxMB int64) *app {
	t.Helper()
	assets := t.TempDir()
	tpl := t.TempDir()
	if err := os.MkdirAll(filepath.Join(assets, "stl"), 0o755); err != nil {
		t.Fatal(err)
	}
	const tplBody = `{{.title}}|{{range .entries}}[{{.Name}} {{.Size}} {{.ModTime}}]{{end}}|{{if .user}}{{.user.Name}} {{.user.Email}}{{end}}`
	if err := os.WriteFile(filepath.Join(tpl, "index.html"), []byte(tplBody), 0o644); err != nil {
		t.Fatal(err)
	}
	h := &swapHandler{}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	cfg := Config{AssetsDir: assets, TemplatesDir: tpl, Addr: ":0", MaxUploadMB: maxMB}
	a := &app{t: t, cfg: cfg, srv: srv}
	if withAuth {
		a.idp = fakeidp.New(testClientID, testClientSecret)
		t.Cleanup(a.idp.Close)
		a.cfg.Auth = auth.Config{
			Issuer: a.idp.Issuer(), ClientID: testClientID, ClientSecret: testClientSecret,
			RedirectURL: srv.URL + "/auth/callback", SessionSecret: testSessionKey, CookieSecure: false,
		}
	}
	au, err := auth.New(a.cfg.Auth)
	if err != nil {
		t.Fatal(err)
	}
	r, err := New(a.cfg, au)
	if err != nil {
		t.Fatal(err)
	}
	h.h = r
	jar, _ := cookiejar.New(nil)
	a.client = &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return a
}

func (a *app) do(method, path string, body io.Reader, hdr map[string]string) (*http.Response, []byte) {
	a.t.Helper()
	req, err := http.NewRequest(method, a.srv.URL+path, body)
	if err != nil {
		a.t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	return a.send(req)
}

func (a *app) send(req *http.Request) (*http.Response, []byte) {
	a.t.Helper()
	resp, err := a.client.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func (a *app) get(path string) (*http.Response, []byte) { return a.do("GET", path, nil, nil) }

func (a *app) modelsDir() string { return a.cfg.ModelsDir() }

func (a *app) writeModel(name string, data []byte) {
	a.t.Helper()
	if err := os.WriteFile(filepath.Join(a.modelsDir(), name), data, 0o644); err != nil {
		a.t.Fatal(err)
	}
}

// login performs the full browser flow against the fake provider.
func (a *app) login() {
	a.t.Helper()
	resp, _ := a.get("/auth/login")
	if resp.StatusCode != http.StatusFound {
		a.t.Fatalf("login status %d", resp.StatusCode)
	}
	cb := a.authorize(resp.Header.Get("Location"))
	resp, body := a.get(cb)
	if resp.StatusCode != http.StatusSeeOther {
		a.t.Fatalf("callback status %d: %s", resp.StatusCode, body)
	}
}

// authorize visits the provider's authorize URL and returns the callback path.
func (a *app) authorize(loc string) string {
	a.t.Helper()
	req, _ := http.NewRequest("GET", loc, nil)
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r, err := c.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusFound {
		a.t.Fatalf("authorize status %d", r.StatusCode)
	}
	u, err := url.Parse(r.Header.Get("Location"))
	if err != nil {
		a.t.Fatal(err)
	}
	return u.RequestURI()
}

func (a *app) upload(filename string, content []byte) (*http.Response, []byte) {
	a.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", filename)
	_, _ = fw.Write(content)
	_ = mw.Close()
	return a.do("POST", "/api/models", &buf, map[string]string{"Content-Type": mw.FormDataContentType()})
}

type errBody struct {
	Error string `json:"error"`
}

func TestUploadStatuses(t *testing.T) {
	valid := binarySTL(2)
	ascii := []byte("solid x\nfacet normal 0 0 1\nendfacet\nendsolid x\n")

	t.Run("503 when OIDC is not configured", func(t *testing.T) {
		a := newApp(t, false, 1)
		resp, body := a.upload("a.stl", valid)
		if resp.StatusCode != 503 {
			t.Fatalf("status %d", resp.StatusCode)
		}
		var e errBody
		if json.Unmarshal(body, &e) != nil || e.Error == "" {
			t.Errorf("body %s", body)
		}
		if _, err := os.Stat(filepath.Join(a.modelsDir(), "a.stl")); err == nil {
			t.Error("file was written")
		}
	})

	t.Run("401 without session", func(t *testing.T) {
		a := newApp(t, true, 1)
		resp, body := a.upload("a.stl", valid)
		if resp.StatusCode != 401 {
			t.Fatalf("status %d", resp.StatusCode)
		}
		var e errBody
		if json.Unmarshal(body, &e) != nil || e.Error == "" {
			t.Errorf("body %s", body)
		}
	})

	a := newApp(t, true, 1)
	a.login()
	a.writeModel("exists.stl", binarySTL(1))
	big := binarySTL(3 * 1024 * 1024 / 50) // ~3 MiB, over the body limit
	mid := binarySTL(1100000 / 50)         // ~1.05 MiB: over file limit, under body limit

	tests := []struct {
		name     string
		filename string
		content  []byte
		want     int
	}{
		{"201 binary", "new.stl", valid, 201},
		{"201 ascii", "ascii.stl", ascii, 201},
		{"400 bad extension", "x.txt", valid, 400},
		{"400 hidden", ".hidden.stl", valid, 400},
		{"400 garbage content", "garbage.stl", []byte("not an stl at all"), 400},
		{"409 collision", "exists.stl", valid, 409},
		{"413 over body limit", "big.stl", big, 413},
		{"413 over file limit", "mid.stl", mid, 413},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := a.upload(tt.filename, tt.content)
			if resp.StatusCode != tt.want {
				t.Fatalf("status %d, want %d (%s)", resp.StatusCode, tt.want, body)
			}
			if tt.want == 201 {
				var m struct {
					Name    string `json:"name"`
					Size    int64  `json:"size"`
					ModTime string `json:"modTime"`
				}
				if err := json.Unmarshal(body, &m); err != nil || m.Name != tt.filename || m.Size != int64(len(tt.content)) || m.ModTime == "" {
					t.Errorf("bad 201 body %s", body)
				}
			} else {
				var e errBody
				if json.Unmarshal(body, &e) != nil || e.Error == "" {
					t.Errorf("error body %s", body)
				}
			}
		})
	}

	t.Run("collision keeps original", func(t *testing.T) {
		got, _ := os.ReadFile(filepath.Join(a.modelsDir(), "exists.stl"))
		if len(got) != 134 {
			t.Errorf("exists.stl was overwritten (%d bytes)", len(got))
		}
	})

	t.Run("400 missing file field", func(t *testing.T) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		_ = mw.WriteField("other", "x")
		_ = mw.Close()
		resp, _ := a.do("POST", "/api/models", &buf, map[string]string{"Content-Type": mw.FormDataContentType()})
		if resp.StatusCode != 400 {
			t.Errorf("status %d", resp.StatusCode)
		}
	})

	t.Run("filename path is reduced to base name", func(t *testing.T) {
		resp, body := a.upload("../../evil.stl", valid)
		if resp.StatusCode != 201 {
			t.Fatalf("status %d %s", resp.StatusCode, body)
		}
		if _, err := os.Stat(filepath.Join(a.modelsDir(), "evil.stl")); err != nil {
			t.Error("evil.stl not in models dir")
		}
		if _, err := os.Stat(filepath.Join(a.cfg.AssetsDir, "..", "evil.stl")); err == nil {
			t.Error("file escaped the models dir")
		}
	})

	t.Run("no temp files left behind", func(t *testing.T) {
		entries, _ := os.ReadDir(a.modelsDir())
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				t.Errorf("leftover %s", e.Name())
			}
		}
	})
}

func TestListModels(t *testing.T) {
	a := newApp(t, false, 1)
	for _, path := range []string{"/api/models", "/api/load-entries"} {
		resp, body := a.get(path)
		if resp.StatusCode != 200 || strings.TrimSpace(string(body)) != "[]" {
			t.Fatalf("%s empty: %d %q, want []", path, resp.StatusCode, body)
		}
	}
	a.writeModel("b.stl", binarySTL(1))
	a.writeModel("a.stl", binarySTL(2))
	a.writeModel("readme.txt", []byte("x"))
	for _, path := range []string{"/api/models", "/api/load-entries"} {
		resp, body := a.get(path)
		if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
			t.Fatalf("%s: %d %s", path, resp.StatusCode, resp.Header.Get("Content-Type"))
		}
		var raw []map[string]any
		if err := json.Unmarshal(body, &raw); err != nil {
			t.Fatal(err)
		}
		if len(raw) != 2 || raw[0]["name"] != "a.stl" || raw[1]["name"] != "b.stl" {
			t.Fatalf("%s: %s", path, body)
		}
		if raw[0]["size"].(float64) != 184 || raw[0]["modTime"] == nil || len(raw[0]) != 3 {
			t.Errorf("%s: bad shape %v", path, raw[0])
		}
	}
}

func TestListMissingDir(t *testing.T) {
	a := newApp(t, false, 1)
	if err := os.RemoveAll(a.modelsDir()); err != nil {
		t.Fatal(err)
	}
	resp, body := a.get("/api/models")
	var e errBody
	if resp.StatusCode != 500 || json.Unmarshal(body, &e) != nil || e.Error == "" {
		t.Errorf("api: %d %s", resp.StatusCode, body)
	}
	resp, body = a.get("/")
	if resp.StatusCode != 200 || !strings.HasPrefix(string(body), "3D Viewer|") {
		t.Errorf("index must still render: %d %s", resp.StatusCode, body)
	}
}

func TestDownload(t *testing.T) {
	a := newApp(t, false, 1)
	data := binarySTL(2)
	a.writeModel("cube.stl", data)
	// A file next to the models dir that must never be reachable.
	if err := os.WriteFile(filepath.Join(a.cfg.AssetsDir, "secret.stl"), []byte("SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp, body := a.get("/api/models/cube.stl")
	if resp.StatusCode != 200 || !bytes.Equal(body, data) {
		t.Fatalf("download: %d len=%d", resp.StatusCode, len(body))
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/sla" {
		t.Errorf("content type %q", ct)
	}

	tests := []struct {
		name string
		path string
		want int
	}{
		{"missing", "/api/models/nope.stl", 404},
		{"wrong extension", "/api/models/cube.txt", 400},
		{"hidden", "/api/models/.hidden.stl", 400},
		{"dotdot", "/api/models/..stl", 400},
		{"backslash", "/api/models/..%5Csecret.stl", 400},
		{"encoded slash traversal", "/api/models/..%2Fsecret.stl", 0},
		{"double encoded", "/api/models/..%252Fsecret.stl", 400},
		{"raw traversal", "/api/models/../secret.stl", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := a.get(tt.path)
			if bytes.Contains(body, []byte("SECRET")) {
				t.Fatal("traversal leaked file contents")
			}
			if tt.want == 0 {
				if resp.StatusCode == 200 {
					t.Errorf("status 200 for %s", tt.path)
				}
				return
			}
			if resp.StatusCode != tt.want {
				t.Errorf("status %d, want %d", resp.StatusCode, tt.want)
			}
		})
	}
}

func TestIndexAndSignIn(t *testing.T) {
	a := newApp(t, true, 1)
	a.writeModel("cube.stl", binarySTL(1))
	resp, body := a.get("/")
	if resp.StatusCode != 200 || !strings.Contains(string(body), "[cube.stl 134 ") || !strings.HasSuffix(string(body), "|") {
		t.Fatalf("anonymous index: %d %s", resp.StatusCode, body)
	}
	a.login()
	_, body = a.get("/")
	if !strings.HasSuffix(string(body), "|Test User test@example.com") {
		t.Errorf("logged-in index: %s", body)
	}
	resp, _ = a.get("/sign-in")
	if resp.StatusCode != 302 || resp.Header.Get("Location") != "/auth/login" {
		t.Errorf("/sign-in: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
}

func TestLoadConfig(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cfg, err := LoadConfig(env(nil))
	if err != nil || cfg.AssetsDir != "./assets" || cfg.TemplatesDir != "./templates" || cfg.Addr != ":8080" ||
		cfg.MaxUploadMB != 50 || !cfg.Auth.CookieSecure || cfg.ModelsDir() != filepath.Join("assets", "stl") {
		t.Errorf("defaults: %+v, %v", cfg, err)
	}
	cfg, err = LoadConfig(env(map[string]string{"ASSETS_DIR": "/a", "TEMPLATES_DIR": "/t", "ADDR": ":9", "MAX_UPLOAD_MB": "7", "COOKIE_SECURE": "false"}))
	if err != nil || cfg.AssetsDir != "/a" || cfg.TemplatesDir != "/t" || cfg.Addr != ":9" || cfg.MaxUploadBytes() != 7<<20 || cfg.Auth.CookieSecure {
		t.Errorf("overrides: %+v, %v", cfg, err)
	}
	for _, m := range []map[string]string{{"MAX_UPLOAD_MB": "x"}, {"MAX_UPLOAD_MB": "0"}, {"COOKIE_SECURE": "maybe"}} {
		if _, err := LoadConfig(env(m)); err == nil {
			t.Errorf("expected error for %v", m)
		}
	}
}
