package viewer

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
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
	// ErrInvalidContent is returned when the data does not look like an STL file.
	ErrInvalidContent = errors.New("content is not a valid STL file")
	// ErrExists is returned when a model with the same name already exists.
	ErrExists = errors.New("model already exists")
	// ErrTooLarge is returned when an upload exceeds the size limit.
	ErrTooLarge = errors.New("model is too large")
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

// validSTL reports whether data is plausibly a binary or ASCII STL file.
func validSTL(data []byte) bool {
	// Binary: 80 byte header, uint32 triangle count, 50 bytes per triangle.
	if len(data) >= 84 {
		count := binary.LittleEndian.Uint32(data[80:84])
		if uint64(len(data)) == 84+50*uint64(count) {
			return true
		}
	}
	// ASCII: starts with "solid" and contains "facet".
	trimmed := bytes.TrimLeft(data, " \t\r\n\xef\xbb\xbf")
	if len(trimmed) >= 5 && strings.EqualFold(string(trimmed[:5]), "solid") &&
		bytes.Contains(bytes.ToLower(data), []byte("facet")) {
		return true
	}
	return false
}

// Save validates and atomically writes an STL file named name into dir. It
// never overwrites an existing file. At most maxBytes are accepted
// (maxBytes <= 0 means unlimited).
func Save(dir, name string, r io.Reader, maxBytes int64) (Model, error) {
	if !ValidName(name) {
		return Model{}, ErrInvalidName
	}
	src := r
	if maxBytes > 0 {
		src = io.LimitReader(r, maxBytes+1)
	}
	data, err := io.ReadAll(src)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return Model{}, ErrTooLarge
		}
		return Model{}, err
	}
	if maxBytes > 0 && int64(len(data)) > maxBytes {
		return Model{}, ErrTooLarge
	}
	if !validSTL(data) {
		return Model{}, ErrInvalidContent
	}

	dest := filepath.Join(dir, name)
	if _, err := os.Lstat(dest); err == nil {
		return Model{}, ErrExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return Model{}, err
	}

	tmp, err := os.CreateTemp(dir, ".upload-*.tmp")
	if err != nil {
		return Model{}, err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return Model{}, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return Model{}, err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return Model{}, err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		cleanup()
		return Model{}, err
	}
	// os.Link fails if dest exists, which makes the no-overwrite check atomic.
	// Filesystems without hard links fall back to a re-checked rename.
	if err := os.Link(tmpName, dest); err != nil {
		if errors.Is(err, os.ErrExist) {
			cleanup()
			return Model{}, ErrExists
		}
		if _, serr := os.Lstat(dest); serr == nil {
			cleanup()
			return Model{}, ErrExists
		}
		if rerr := os.Rename(tmpName, dest); rerr != nil {
			cleanup()
			return Model{}, fmt.Errorf("saving model: %w", rerr)
		}
		return Stat(dir, name)
	}
	cleanup()
	return Stat(dir, name)
}
