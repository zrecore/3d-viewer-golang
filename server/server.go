// Package server wires the Gin router, model routes and authentication.
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
	"github.com/zrecore/3d-viewer-golang/auth"
	"github.com/zrecore/3d-viewer-golang/viewer"
)

// multipartOverhead is extra body room for multipart framing on top of the
// file size limit.
const multipartOverhead = 1 << 20

type handlers struct {
	cfg  Config
	auth *auth.Auth
}

// New builds the Gin engine. Templates are loaded from cfg.TemplatesDir.
func New(cfg Config, a *auth.Auth) (*gin.Engine, error) {
	matches, err := filepath.Glob(filepath.Join(cfg.TemplatesDir, "*"))
	if err != nil || len(matches) == 0 {
		return nil, errors.New("no templates found in " + cfg.TemplatesDir)
	}
	h := &handlers{cfg: cfg, auth: a}

	r := gin.Default()
	r.LoadHTMLGlob(filepath.Join(cfg.TemplatesDir, "*"))
	r.Static("/assets", cfg.AssetsDir)

	r.GET("/", h.index)

	r.GET("/sign-in", func(c *gin.Context) { c.Redirect(http.StatusFound, "/auth/login") })
	r.GET("/auth/login", a.Login)
	r.GET("/auth/callback", a.Callback)
	r.POST("/auth/logout", a.Logout)

	r.GET("/api/me", h.me)
	r.GET("/api/models", h.list)
	r.GET("/api/load-entries", h.list)
	r.GET("/api/models/:name", h.download)
	r.POST("/api/models", h.upload)
	return r, nil
}

func jsonError(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": msg})
}

func (h *handlers) currentUser(c *gin.Context) (auth.User, bool) {
	return h.auth.CurrentUser(c.Request)
}

func (h *handlers) index(c *gin.Context) {
	entries, err := viewer.List(h.cfg.ModelsDir())
	if err != nil {
		log.Printf("listing models: %v", err)
		entries = []viewer.Model{}
	}
	var user any
	if u, ok := h.currentUser(c); ok {
		user = u
	}
	c.HTML(http.StatusOK, "index.html", gin.H{
		"title":   "3D Viewer",
		"entries": entries,
		"user":    user,
	})
}

func (h *handlers) me(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	body := gin.H{"authenticated": false, "loginAvailable": h.auth.Enabled()}
	if u, ok := h.currentUser(c); ok {
		body["authenticated"] = true
		body["user"] = gin.H{"name": u.Name, "email": u.Email}
	}
	c.JSON(http.StatusOK, body)
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

func (h *handlers) upload(c *gin.Context) {
	if !h.auth.Enabled() {
		jsonError(c, http.StatusServiceUnavailable, "uploads are disabled: authentication is not configured")
		return
	}
	if _, ok := h.currentUser(c); !ok {
		jsonError(c, http.StatusUnauthorized, "login required")
		return
	}
	max := h.cfg.MaxUploadBytes()
	if c.Request.ContentLength > max+multipartOverhead {
		jsonError(c, http.StatusRequestEntityTooLarge, "file is too large")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, max+multipartOverhead)

	fh, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			jsonError(c, http.StatusRequestEntityTooLarge, "file is too large")
			return
		}
		jsonError(c, http.StatusBadRequest, "multipart field \"file\" is required")
		return
	}
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	if fh.Size > max {
		jsonError(c, http.StatusRequestEntityTooLarge, "file is too large")
		return
	}
	// Browsers send base names, but other clients may send paths; both
	// separator styles are reduced to the final element.
	name := baseName(fh.Filename)
	f, err := fh.Open()
	if err != nil {
		log.Printf("opening upload: %v", err)
		jsonError(c, http.StatusInternalServerError, "could not read upload")
		return
	}
	defer f.Close()

	m, err := viewer.Save(h.cfg.ModelsDir(), name, f, max)
	switch {
	case err == nil:
		c.JSON(http.StatusCreated, m)
	case errors.Is(err, viewer.ErrInvalidName):
		jsonError(c, http.StatusBadRequest, "invalid file name: use a plain name ending in .stl")
	case errors.Is(err, viewer.ErrInvalidContent):
		jsonError(c, http.StatusBadRequest, "file is not a valid STL")
	case errors.Is(err, viewer.ErrExists):
		jsonError(c, http.StatusConflict, "a model with that name already exists")
	case errors.Is(err, viewer.ErrTooLarge):
		jsonError(c, http.StatusRequestEntityTooLarge, "file is too large")
	default:
		log.Printf("saving model %q: %v", name, err)
		jsonError(c, http.StatusInternalServerError, "could not save model")
	}
}

// baseName returns the last element of a client-supplied filename, treating
// both "/" and "\" as separators.
func baseName(s string) string {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '/' || s[i] == '\\' {
			return s[i+1:]
		}
	}
	return s
}
