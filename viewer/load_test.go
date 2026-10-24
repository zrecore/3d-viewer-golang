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

const asciiSTL = "solid cube\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid cube\n"

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

func TestSave(t *testing.T) {
	badCount := binarySTL(2)
	binary.LittleEndian.PutUint32(badCount[80:], 5)

	tests := []struct {
		name    string
		file    string
		content []byte
		max     int64
		want    error
	}{
		{"binary ok", "ok.stl", binarySTL(3), 1 << 20, nil},
		{"ascii ok", "ascii.stl", []byte(asciiSTL), 1 << 20, nil},
		{"ascii leading space ok", "ascii2.stl", []byte("  \n" + asciiSTL), 1 << 20, nil},
		{"unlimited", "unl.stl", binarySTL(1), 0, nil},
		{"traversal", "../x.stl", binarySTL(1), 1 << 20, ErrInvalidName},
		{"separator", "a/b.stl", binarySTL(1), 1 << 20, ErrInvalidName},
		{"hidden", ".hidden.stl", binarySTL(1), 1 << 20, ErrInvalidName},
		{"wrong ext", "x.txt", binarySTL(1), 1 << 20, ErrInvalidName},
		{"garbage", "g.stl", []byte("hello world, not an stl"), 1 << 20, ErrInvalidContent},
		{"empty", "e.stl", nil, 1 << 20, ErrInvalidContent},
		{"count mismatch", "c.stl", badCount, 1 << 20, ErrInvalidContent},
		{"solid without facet", "s.stl", []byte("solid nothing here"), 1 << 20, ErrInvalidContent},
		{"too large", "big.stl", binarySTL(100), 100, ErrTooLarge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			m, err := Save(dir, tt.file, bytes.NewReader(tt.content), tt.max)
			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
			entries, _ := os.ReadDir(dir)
			if tt.want == nil {
				if m.Name != tt.file || m.Size != int64(len(tt.content)) {
					t.Errorf("model = %+v", m)
				}
				if len(entries) != 1 {
					t.Errorf("expected exactly 1 file (no temp leftovers), got %d", len(entries))
				}
				got, _ := os.ReadFile(filepath.Join(dir, tt.file))
				if !bytes.Equal(got, tt.content) {
					t.Error("content mismatch")
				}
			} else if len(entries) != 0 {
				t.Errorf("failed save left files behind: %v", entries)
			}
		})
	}
}

func TestSaveCollisionDoesNotOverwrite(t *testing.T) {
	dir := t.TempDir()
	orig := binarySTL(1)
	if _, err := Save(dir, "a.stl", bytes.NewReader(orig), 1<<20); err != nil {
		t.Fatal(err)
	}
	_, err := Save(dir, "a.stl", bytes.NewReader(binarySTL(2)), 1<<20)
	if !errors.Is(err, ErrExists) {
		t.Fatalf("err = %v, want ErrExists", err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "a.stl"))
	if !bytes.Equal(got, orig) {
		t.Error("original file was modified")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("temp file left behind: %v", entries)
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
