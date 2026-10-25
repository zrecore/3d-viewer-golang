package server

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"path/filepath"
	"strings"
)

// Config is the runtime configuration of the web server.
type Config struct {
	AssetsDir    string
	TemplatesDir string
	Addr         string
}

// ModelsDir is where the example STL files live.
func (c Config) ModelsDir() string { return filepath.Join(c.AssetsDir, "stl") }

// LoadConfig builds a Config from environment variables via getenv
// (typically os.Getenv). Unset or blank variables fall back to defaults.
func LoadConfig(getenv func(string) string) Config {
	def := func(key, fallback string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return fallback
	}
	return Config{
		AssetsDir:    def("ASSETS_DIR", "./assets"),
		TemplatesDir: def("TEMPLATES_DIR", "./templates"),
		Addr:         def("ADDR", ":8080"),
	}
}
