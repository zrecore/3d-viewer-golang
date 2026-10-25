// Package server wires the Gin router and the read-only model routes.
package server

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
	"github.com/zrecore/3d-viewer-golang/viewer"
)

type handlers struct {
	cfg Config
}

// New builds the Gin engine. Templates are loaded from cfg.TemplatesDir.
func New(cfg Config) (*gin.Engine, error) {
	matches, err := filepath.Glob(filepath.Join(cfg.TemplatesDir, "*"))
	if err != nil || len(matches) == 0 {
		return nil, errors.New("no templates found in " + cfg.TemplatesDir)
	}
	h := &handlers{cfg: cfg}

	r := gin.Default()
	r.LoadHTMLGlob(filepath.Join(cfg.TemplatesDir, "*"))
	r.Static("/assets", cfg.AssetsDir)

	r.GET("/", h.index)

	r.GET("/api/models", h.list)
	r.GET("/api/load-entries", h.list)
	r.GET("/api/models/:name", h.download)
	return r, nil
}

func jsonError(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": msg})
}

func (h *handlers) index(c *gin.Context) {
	entries, err := viewer.List(h.cfg.ModelsDir())
	if err != nil {
		log.Printf("listing models: %v", err)
		entries = []viewer.Model{}
	}
	c.HTML(http.StatusOK, "index.html", gin.H{
		"title":   "3D Viewer",
		"entries": entries,
	})
}

func (h *handlers) list(c *gin.Context) {
	models, err := viewer.List(h.cfg.ModelsDir())
	if err != nil {
		log.Printf("listing models: %v", err)
		jsonError(c, http.StatusInternalServerError, "could not list models")
		return
	}
	c.JSON(http.StatusOK, models)
}

func (h *handlers) download(c *gin.Context) {
	name := c.Param("name")
	p, err := viewer.Path(h.cfg.ModelsDir(), name)
	if err != nil {
		jsonError(c, http.StatusBadRequest, "invalid model name")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			jsonError(c, http.StatusNotFound, "model not found")
			return
		}
		log.Printf("opening model %q: %v", name, err)
		jsonError(c, http.StatusInternalServerError, "could not read model")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		jsonError(c, http.StatusNotFound, "model not found")
		return
	}
	c.Header("Content-Type", "application/sla")
	c.Header("X-Content-Type-Options", "nosniff")
	http.ServeContent(c.Writer, c.Request, name, info.ModTime(), f)
}
