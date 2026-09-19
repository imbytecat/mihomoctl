package fsutil

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogCursorAppendRotationAndWholeLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.log")
	write := func(text string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	read := func(cursor string) LogChunk {
		t.Helper()
		chunk, err := ReadLog(path, cursor)
		if err != nil {
			t.Fatal(err)
		}
		return chunk
	}
	write("first\npartial")
	a := read("")
	if a.Text != "first\n" {
		t.Fatalf("partial line exposed: %#v", a)
	}
	if b := read(a.Cursor); b.Text != "" || b.Reset {
		t.Fatalf("repeated old lines: %#v", b)
	}
	write("first\npartial complete\nfirst\n")
	b := read(a.Cursor)
	if b.Text != "partial complete\nfirst\n" || b.Reset {
		t.Fatalf("lost appended or duplicate lines: %#v", b)
	}
	// Same inode, truncated and rewritten beyond the old offset.
	write("replacement longer than the previous file content\n")
	c := read(b.Cursor)
	if !c.Reset || !strings.HasPrefix(c.Text, "replacement") {
		t.Fatalf("missed truncation: %#v", c)
	}
	if err := AtomicWrite(path, []byte("rotated\n"), 0600); err != nil {
		t.Fatal(err)
	}
	d := read(c.Cursor)
	if !d.Reset || d.Text != "rotated\n" {
		t.Fatalf("missed rotation: %#v", d)
	}
	write("password: " + strings.Repeat("s", 80*1024) + "\nsafe\n")
	e := read("")
	if strings.Contains(e.Text, "sss") || e.Text != "safe\n" || !e.Skipped {
		t.Fatalf("unsafe tail: %#v", e)
	}
	for _, cursor := range []string{"!", strings.Repeat("a", 513), "eyJvIjotMX0"} {
		if _, err := ReadLog(path, cursor); err == nil {
			t.Fatal("accepted invalid cursor")
		}
	}
}

func TestLogCursorDoesNotStallOnOversizedAppendedLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.log")
	if err := os.WriteFile(path, []byte("first\n"), 0600); err != nil {
		t.Fatal(err)
	}
	chunk, err := ReadLog(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("first\npassword: "+strings.Repeat("s", 80*1024)+"\nsafe\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var output string
	for range 8 {
		chunk, err = ReadLog(path, chunk.Cursor)
		if err != nil {
			t.Fatal(err)
		}
		output += chunk.Text
	}
	if output != "safe\n" {
		t.Fatalf("leaked partial line or stalled: %.100q", output)
	}
}
