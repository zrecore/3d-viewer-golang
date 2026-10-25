package viewer

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// binarySTL builds a binary STL with n zeroed triangles.
func binarySTL(n int) []byte {
	b := make([]byte, 84+50*n)
	binary.LittleEndian.PutUint32(b[80:], uint32(n))
	return b
}

func TestValidName(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"cube.stl", true},
		{"CUBE.STL", true},
		{"my model-v1.0.stl", true},
		{"", false},
		{".stl", false},
		{"../x.stl", false},
		{"..stl", false},
		{"a/b.stl", false},
		{`a\b.stl`, false},
		{"/etc/passwd.stl", false},
		{".hidden.stl", false},
		{"x.txt", false},
		{"x.stl.txt", false},
		{"x\x00.stl", false},
		{"x\n.stl", false},
		{"a..b.stl", false},
		{strings.Repeat("a", 300) + ".stl", false},
	}
	for _, tt := range tests {
		if got := ValidName(tt.name); got != tt.want {
			t.Errorf("ValidName(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestList(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"b.stl", "a.STL", "notes.txt", ".hidden.stl", ".upload-1.tmp"} {
		if err := os.WriteFile(filepath.Join(dir, n), binarySTL(1), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "dir.stl"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "a.STL" || got[1].Name != "b.stl" {
		t.Fatalf("List = %+v", got)
	}
	if got[0].Size != 134 || got[0].ModTime.IsZero() {
		t.Errorf("bad size/modtime: %+v", got[0])
	}

	empty, err := List(t.TempDir())
	if err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("empty dir: got %#v, %v; want non-nil empty slice", empty, err)
	}
	if _, err := List(filepath.Join(dir, "missing")); err == nil {
		t.Error("expected error for missing dir")
	}
}

func TestStatAndPath(t *testing.T) {
	dir := t.TempDir()
	if _, err := Path(dir, "../x.stl"); !errors.Is(err, ErrInvalidName) {
		t.Errorf("Path traversal err = %v", err)
	}
	if _, err := Stat(dir, "missing.stl"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Stat missing err = %v", err)
	}
}
