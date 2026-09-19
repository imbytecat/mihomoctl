package manager

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"go.yaml.in/yaml/v3"

	"golang.org/x/crypto/nacl/box"
)

type Controller struct {
	Enabled bool   `json:"enabled"`
	Port    int    `json:"port"`
	Secret  string `json:"secret"`
}

type ControllerStatus struct {
	Enabled   bool `json:"enabled"`
	Port      int  `json:"port"`
	Applied   bool `json:"applied"`
	Overrides bool `json:"overrides"`
}

func newSecret() string {
	var key [32]byte
	rand.Read(key[:])
	return hex.EncodeToString(key[:])
}

func (c Controller) validate() error {
	if c.Port < 1024 || c.Port > 65535 || c.Port == 7894 || c.Port == 1053 {
		return errors.New("API 端口须为 1024–65535，且不能占用代理或 DNS 端口")
	}
	if c.Secret == "" {
		return errors.New("API 密钥不能为空")
	}
	for _, char := range c.Secret {
		if char < 33 || char > 126 {
			return errors.New("API 密钥包含无法用于 HTTP 鉴权的字符")
		}
	}
	return nil
}

func (a *Manager) controller() (Controller, error) {
	if err := a.requireIdentity(); err != nil {
		return Controller{}, err
	}
	config, err := a.configuration()
	if err != nil {
		return Controller{}, err
	}
	if config.Controller != nil {
		return *config.Controller, config.Controller.validate()
	}
	stored, err := a.store.Controller()
	value := Controller(stored)
	if err != nil {
		return value, err
	}
	data, err := a.overrides()
	if err != nil {
		return value, err
	}
	overlay, err := overrideMapping(data)
	if err != nil {
		return value, err
	}
	return a.overlayController(value, overlay)
}

func (a *Manager) saveController(ctx context.Context, request Request, phase func(string)) (string, error) {
	input := request.Params.Controller
	if input == nil || (input.Enabled == nil && input.YAML == nil) {
		return "", errors.New("覆写设置无效")
	}
	value, err := a.controller()
	if err != nil {
		return "", err
	}
	previous, err := a.overrides()
	if err != nil {
		return "", err
	}
	next := previous
	if input.YAML != nil {
		next = []byte(*input.YAML)
	} else {
		value.Enabled, value.Port = *input.Enabled, input.Port
		if input.Reset {
			value.Secret = newSecret()
		} else if input.Secret != nil {
			value.Secret = *input.Secret
		}
		if err := value.validate(); err != nil {
			return "", err
		}
		overlay, err := overrideMapping(previous)
		if err != nil {
			return "", err
		}
		managed, err := a.defaultOverrides(value)
		if err != nil {
			return "", err
		}
		fields, err := overrideMapping(managed)
		if err != nil {
			return "", err
		}
		for key, field := range fields {
			overlay[key] = field
		}
		next, err = yaml.Marshal(overlay)
		if err != nil {
			return "", err
		}
	}
	overlay, err := overrideMapping(next)
	if err != nil {
		return "", err
	}
	if len(overlay) == 0 {
		next, err = a.defaultOverrides(value)
		if err != nil {
			return "", err
		}
		overlay, err = overrideMapping(next)
		if err != nil {
			return "", err
		}
	}
	if err := a.validateManagedOverrides(overlay); err != nil {
		return "", err
	}
	value, err = a.overlayController(value, overlay)
	if err != nil {
		return "", err
	}
	phase("saving")
	config, err := a.configuration()
	if err != nil {
		return "", err
	}
	if config.URL == "" {
		// Before a generation exists, preserve omitted management settings in the
		// same YAML write instead of leaving them dependent on stale DB defaults.
		defaults, err := a.defaultOverrides(value)
		if err != nil {
			return "", err
		}
		fields, err := overrideMapping(defaults)
		if err != nil {
			return "", err
		}
		var document yaml.Node
		if err := yaml.Unmarshal(next, &document); err != nil {
			return "", errors.New("覆写 YAML 无效")
		}
		changed := false
		for _, key := range []string{"external-controller", "secret"} {
			if _, present := overlay[key]; present {
				continue
			}
			keyNode, valueNode := &yaml.Node{}, &yaml.Node{}
			if err := keyNode.Encode(key); err != nil {
				return "", err
			}
			if err := valueNode.Encode(fields[key]); err != nil {
				return "", err
			}
			document.Content[0].Content = append(document.Content[0].Content, keyNode, valueNode)
			changed = true
		}
		if changed {
			next, err = yaml.Marshal(&document)
			if err != nil {
				return "", err
			}
			if _, err := overrideMapping(next); err != nil {
				return "", err
			}
		}
		return "覆写已保存，生成订阅配置时由内核校验", fsutil.AtomicWrite(a.runtime("overrides.yaml"), next, 0600)
	}
	if config.Controller != nil && value == *config.Controller && config.Dashboard == (value.Enabled && a.dashboard().Installed) && bytes.Equal(previous, next) {
		return "覆写未改变", nil
	}
	source, err := os.ReadFile(a.runtime("current", "source.yaml"))
	if err != nil {
		return "", err
	}
	if err = a.applyConfigWithOverrides(ctx, request.ID, source, config.URL, value, next, phase); err != nil {
		return "", err
	}
	return "覆写已应用", nil
}

// Only ciphertext crosses UFI's logged root-shell response. The browser owns the recipient key.
func (a *Manager) ControllerSecret(recipient string) (string, error) {
	value, err := a.controller()
	if err != nil {
		return "", err
	}
	return sealResponse(recipient, []byte(value.Secret))
}

func (a *Manager) ControllerOverrides(recipient string) (string, error) {
	if err := a.requireIdentity(); err != nil {
		return "", err
	}
	data, err := a.overrides()
	if err != nil {
		return "", err
	}
	mapping, err := overrideMapping(data)
	if err != nil {
		return "", err
	}
	if len(mapping) == 0 {
		control, err := a.controller()
		if err != nil {
			return "", err
		}
		data, err = a.defaultOverrides(control)
		if err != nil {
			return "", err
		}
	}
	return sealResponse(recipient, data)
}

func sealResponse(recipient string, data []byte) (string, error) {
	key, err := base64.StdEncoding.DecodeString(recipient)
	if err != nil || len(key) != 32 {
		return "", errors.New("浏览器公钥无效")
	}
	var public [32]byte
	copy(public[:], key)
	sealed, err := box.SealAnonymous(nil, data, &public, rand.Reader)
	return base64.StdEncoding.EncodeToString(sealed), err
}
