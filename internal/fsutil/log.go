package fsutil

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"syscall"
)

// LogChunk contains only complete lines. Cursors contain file identity, never paths.
type LogChunk struct {
	Text    string `json:"text"`
	Cursor  string `json:"cursor"`
	Reset   bool   `json:"reset"`
	Skipped bool   `json:"skipped"`
}
type logCursor struct {
	Device uint64 `json:"d"`
	Inode  uint64 `json:"i"`
	Offset int64  `json:"o"`
	Anchor string `json:"a"`
}

func ReadLog(path, cursor string) (LogChunk, error) {
	const limit int64 = 24 * 1024
	var previous logCursor
	if cursor != "" {
		if len(cursor) > 512 {
			return LogChunk{}, errors.New("无效日志游标")
		}
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(raw, &previous) != nil || previous.Offset < 0 {
			return LogChunk{}, errors.New("无效日志游标")
		}
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return LogChunk{Cursor: cursor}, nil
	}
	if err != nil {
		return LogChunk{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return LogChunk{}, err
	}
	if !info.Mode().IsRegular() {
		return LogChunk{}, errors.New("日志不是普通文件")
	}
	stat := info.Sys().(*syscall.Stat_t)
	next := logCursor{Device: uint64(stat.Dev), Inode: stat.Ino}
	anchor := func(offset int64) string {
		data, _ := io.ReadAll(io.NewSectionReader(f, max(0, offset-64), min(offset, 64)))
		sum := sha256.Sum256(data)
		return hex.EncodeToString(sum[:])
	}
	reset := cursor != "" && (previous.Device != next.Device || previous.Inode != next.Inode || previous.Offset > info.Size() || previous.Anchor != anchor(previous.Offset))
	start := previous.Offset
	if cursor == "" || reset {
		start = 0
	}
	// Return to live output after a long pause rather than replaying an unbounded backlog.
	result := LogChunk{Reset: reset, Skipped: start < info.Size()-limit}
	start = max(start, info.Size()-limit)
	readStart := max(0, start-1)
	data, err := io.ReadAll(io.NewSectionReader(f, readStart, min(info.Size()-readStart, limit+start-readStart)))
	if err != nil {
		return LogChunk{}, err
	}
	next.Offset = start
	if start > 0 {
		cut := bytes.IndexByte(data, '\n')
		if cut < 0 {
			next.Offset = readStart + int64(len(data))
			result.Skipped = len(data) > 1
			data = nil
		} else {
			result.Skipped = result.Skipped || cut > 0
			next.Offset = readStart + int64(cut+1)
			data = data[cut+1:]
		}
	}
	if end := bytes.LastIndexByte(data, '\n'); end >= 0 {
		result.Text = string(data[:end+1])
		next.Offset += int64(end + 1)
	} else if int64(len(data)) >= limit {
		// Skip an oversized line, including its remainder in the next read.
		next.Offset += int64(len(data))
		result.Skipped = true
	}
	next.Anchor = anchor(next.Offset)
	raw, _ := json.Marshal(next)
	result.Cursor = base64.RawURLEncoding.EncodeToString(raw)
	return result, nil
}
