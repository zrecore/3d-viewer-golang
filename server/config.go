package server

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/zrecore/3d-viewer-golang/auth"
)

// Config is the runtime configuration of the web server.
type Config struct {
	AssetsDir    string
	TemplatesDir string
	Addr         string
	MaxUploadMB  int64
	Auth         auth.Config
}

// ModelsDir is where STL files live.
func (c Config) ModelsDir() string { return filepath.Join(c.AssetsDir, "stl") }

// MaxUploadBytes is the per-file upload limit.
func (c Config) MaxUploadBytes() int64 { return c.MaxUploadMB << 20 }

// LoadConfig builds a Config from environment variables via getenv
// (typically os.Getenv).
func LoadConfig(getenv func(string) string) (Config, error) {
	def := func(key, fallback string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return fallback
	}
	cfg := Config{
		AssetsDir:    def("ASSETS_DIR", "./assets"),
		TemplatesDir: def("TEMPLATES_DIR", "./templates"),
		Addr:         def("ADDR", ":8080"),
		MaxUploadMB:  50,
	}
	if v := strings.TrimSpace(getenv("MAX_UPLOAD_MB")); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 || n > 4096 {
			return cfg, fmt.Errorf("MAX_UPLOAD_MB must be an integer between 1 and 4096, got %q", v)
		}
		cfg.MaxUploadMB = n
	}
	secure := true
	if v := strings.TrimSpace(getenv("COOKIE_SECURE")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return cfg, fmt.Errorf("COOKIE_SECURE must be a boolean, got %q", v)
		}
		secure = b
	}
	cfg.Auth = auth.Config{
		Issuer:        strings.TrimSpace(getenv("OIDC_ISSUER")),
		ClientID:      strings.TrimSpace(getenv("OIDC_CLIENT_ID")),
		ClientSecret:  getenv("OIDC_CLIENT_SECRET"),
		RedirectURL:   strings.TrimSpace(getenv("OIDC_REDIRECT_URL")),
		SessionSecret: getenv("SESSION_SECRET"),
		CookieSecure:  secure,
	}
	return cfg, nil
}
