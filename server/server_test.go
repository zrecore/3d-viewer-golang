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
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
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
	t   *testing.T
	cfg Config
	srv *httptest.Server
}

func newApp(t *testing.T) *app {
	t.Helper()
	assets := t.TempDir()
	tpl := t.TempDir()
	if err := os.MkdirAll(filepath.Join(assets, "stl"), 0o755); err != nil {
		t.Fatal(err)
	}
	const tplBody = `{{.title}}|{{range .entries}}[{{.Name}} {{.Size}} {{.ModTime}}]{{end}}`
	if err := os.WriteFile(filepath.Join(tpl, "index.html"), []byte(tplBody), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := Config{AssetsDir: assets, TemplatesDir: tpl, Addr: ":0"}
	r, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &app{t: t, cfg: cfg, srv: srv}
}

func (a *app) do(method, path string) (*http.Response, []byte) {
	a.t.Helper()
	req, err := http.NewRequest(method, a.srv.URL+path, nil)
	if err != nil {
		a.t.Fatal(err)
	}
	// never follow redirects: a redirect would be a (removed) sign-in route answering
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func (a *app) get(path string) (*http.Response, []byte) { return a.do("GET", path) }

func (a *app) modelsDir() string { return a.cfg.ModelsDir() }

func (a *app) writeModel(name string, data []byte) {
	a.t.Helper()
	if err := os.WriteFile(filepath.Join(a.modelsDir(), name), data, 0o644); err != nil {
		a.t.Fatal(err)
	}
}

type errBody struct {
	Error string `json:"error"`
}

func TestListModels(t *testing.T) {
	a := newApp(t)
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
	a := newApp(t)
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
	a := newApp(t)
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

func TestIndex(t *testing.T) {
	a := newApp(t)
	a.writeModel("cube.stl", binarySTL(1))
	resp, body := a.get("/")
	if resp.StatusCode != 200 || !strings.HasPrefix(string(body), "3D Viewer|") || !strings.Contains(string(body), "[cube.stl 134 ") {
		t.Fatalf("index: %d %s", resp.StatusCode, body)
	}
	if len(resp.Header.Values("Set-Cookie")) != 0 {
		t.Errorf("the server sets no cookies: %v", resp.Header.Values("Set-Cookie"))
	}
}

// The server has no accounts and accepts no uploads: those routes are gone, not merely disabled.
func TestRemovedRoutesAreGone(t *testing.T) {
	a := newApp(t)
	for _, r := range []struct{ method, path string }{
		{"GET", "/sign-in"},
		{"GET", "/auth/login"},
		{"GET", "/auth/callback"},
		{"POST", "/auth/logout"},
		{"GET", "/api/me"},
		{"POST", "/api/models"},
		{"PUT", "/api/models/new.stl"},
		{"DELETE", "/api/models/cube.stl"},
	} {
		resp, _ := a.do(r.method, r.path)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s: status %d, want 404", r.method, r.path, resp.StatusCode)
		}
	}
	if entries, _ := os.ReadDir(a.modelsDir()); len(entries) != 0 {
		t.Errorf("a request created files: %v", entries)
	}
}

func TestLoadConfig(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cfg := LoadConfig(env(nil))
	if cfg.AssetsDir != "./assets" || cfg.TemplatesDir != "./templates" || cfg.Addr != ":8080" ||
		cfg.ModelsDir() != filepath.Join("assets", "stl") {
		t.Errorf("defaults: %+v", cfg)
	}
	cfg = LoadConfig(env(map[string]string{"ASSETS_DIR": "/a", "TEMPLATES_DIR": "/t", "ADDR": ":9"}))
	if cfg.AssetsDir != "/a" || cfg.TemplatesDir != "/t" || cfg.Addr != ":9" || cfg.ModelsDir() != filepath.Join("/a", "stl") {
		t.Errorf("overrides: %+v", cfg)
	}
	cfg = LoadConfig(env(map[string]string{"ADDR": "   "}))
	if cfg.Addr != ":8080" {
		t.Errorf("blank values fall back to defaults: %+v", cfg)
	}
}
