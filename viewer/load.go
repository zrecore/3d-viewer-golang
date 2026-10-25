package viewer

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Model describes one STL file on disk.
type Model struct {
	Name    string    `json:"name"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
}

var (
	// ErrInvalidName is returned for names that are not a plain *.stl base name.
	ErrInvalidName = errors.New("invalid model name")
	// ErrNotFound is returned when a model does not exist.
	ErrNotFound = errors.New("model not found")
)

const (
	ext          = ".stl"
	maxNameBytes = 200
)

// ValidName reports whether name is a plain base name ending in .stl
// (case-insensitive) with no separators, NUL bytes, leading dot or "..".
func ValidName(name string) bool {
	if name == "" || len(name) > maxNameBytes {
		return false
	}
	if strings.ContainsAny(name, "/\\\x00") || strings.Contains(name, "..") {
		return false
	}
	if strings.HasPrefix(name, ".") || filepath.Base(name) != name {
		return false
	}
	if len(name) <= len(ext) || !strings.EqualFold(name[len(name)-len(ext):], ext) {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// List returns the .stl files in dir sorted by name. Directories and other
// file types are skipped. The result is never nil on success.
func List(dir string) ([]Model, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	models := make([]Model, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !ValidName(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			// File vanished between ReadDir and Info; skip it.
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		models = append(models, Model{Name: e.Name(), Size: info.Size(), ModTime: info.ModTime()})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
	return models, nil
}

// Path returns the on-disk path of a validated model name.
func Path(dir, name string) (string, error) {
	if !ValidName(name) {
		return "", ErrInvalidName
	}
	return filepath.Join(dir, name), nil
}

// Stat returns the Model for name, or ErrNotFound.
func Stat(dir, name string) (Model, error) {
	p, err := Path(dir, name)
	if err != nil {
		return Model{}, err
	}
	info, err := os.Stat(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Model{}, ErrNotFound
		}
		return Model{}, err
	}
	if !info.Mode().IsRegular() {
		return Model{}, ErrNotFound
	}
	return Model{Name: name, Size: info.Size(), ModTime: info.ModTime()}, nil
}
