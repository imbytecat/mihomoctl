package manager

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"reflect"
	"strconv"

	"dario.cat/mergo"
	"go.yaml.in/yaml/v3"
)

const overridesLimit = 20 * 1024

func overrideMapping(data []byte) (map[string]any, error) {
	if len(data) > overridesLimit {
		return nil, errors.New("覆写 YAML 不能超过 20 KiB")
	}
	var mapping map[string]any
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&mapping); err != nil && !errors.Is(err, io.EOF) {
		return nil, errors.New("覆写必须是有效的 YAML 映射")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("覆写只能包含一个 YAML 文档")
	}
	if mapping == nil {
		mapping = map[string]any{}
	}
	return mapping, nil
}

// The active generation owns its overlay, including rollback. The standalone
// file only holds settings before the first subscription configuration exists.
func (a *Manager) overrides() ([]byte, error) {
	id, err := a.activeGeneration()
	if err != nil {
		return nil, err
	}
	path := a.runtime("overrides.yaml")
	if id != "" {
		path = a.runtime("configurations", id, "overrides.yaml")
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil // An absent overlay means the base configuration applies.
	}
	return data, err
}

func (a *Manager) defaultOverrides(control Controller) ([]byte, error) {
	address := ""
	if control.Enabled {
		address = net.JoinHostPort(a.Platform.Policy().Controller, strconv.Itoa(control.Port))
	}
	return yaml.Marshal(map[string]any{"external-controller": address, "secret": control.Secret})
}

func (a *Manager) overlayController(control Controller, overlay map[string]any) (Controller, error) {
	if value, ok := overlay["external-controller"]; ok {
		address, ok := value.(string)
		if !ok {
			return control, errors.New("external-controller 必须是地址字符串，空字符串表示关闭")
		}
		control.Enabled = address != ""
		if address != "" {
			host, port, err := net.SplitHostPort(address)
			if err != nil || (host != "" && host != a.Platform.Policy().Controller) {
				return control, errors.New("管理接口地址须符合平台监听范围，可填写 :端口")
			}
			control.Port, err = strconv.Atoi(port)
			if err != nil {
				return control, errors.New("管理接口端口无效")
			}
		}
	}
	if value, ok := overlay["secret"]; ok {
		var valid bool
		control.Secret, valid = value.(string)
		if !valid {
			return control, errors.New("secret 必须是字符串")
		}
	}
	return control, control.validate()
}

// These values must agree with the platform's route rules and listener ownership checks.
// Other Mihomo fields are intentionally not enumerated here.
func (a *Manager) validateManagedOverrides(overlay map[string]any) error {
	policy := a.Platform.Policy()
	managed := map[string]any{"allow-lan": true, "bind-address": policy.Bind, "tproxy-port": 7894, "ipv6": false}
	check := func(values, fixed map[string]any, prefix string) error {
		for key, expected := range fixed {
			if value, present := values[key]; present && !reflect.DeepEqual(value, expected) {
				return fmt.Errorf("%s%s 由管理器维护，不能通过覆写改变", prefix, key)
			}
		}
		return nil
	}
	if err := check(overlay, managed, ""); err != nil {
		return err
	}
	if dns, ok := overlay["dns"].(map[string]any); ok {
		if err := check(dns, map[string]any{"enable": true, "listen": net.JoinHostPort(policy.DNS, "1053"), "ipv6": false}, "dns."); err != nil {
			return err
		}
	}
	if tun, ok := overlay["tun"].(map[string]any); ok {
		if err := check(tun, map[string]any{"enable": false}, "tun."); err != nil {
			return err
		}
	}
	return nil
}

func mergeOverrides(source []byte, overlay map[string]any) ([]byte, error) {
	if len(overlay) == 0 {
		return source, nil
	}
	var base map[string]any
	decoder := yaml.NewDecoder(bytes.NewReader(source))
	if err := decoder.Decode(&base); err != nil || base == nil {
		return nil, errors.New("订阅必须是有效的 YAML 映射")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("订阅只能包含一个 YAML 文档")
	}
	if err := mergo.Merge(&base, overlay, mergo.WithOverride); err != nil {
		return nil, errors.New("无法合并覆写配置")
	}
	return yaml.Marshal(base)
}
