package manager

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type ControllerInput struct {
	Enabled *bool   `json:"enabled"`
	Port    int     `json:"port"`
	Secret  *string `json:"secret,omitempty"`
	Reset   bool    `json:"reset,omitempty"`
	YAML    *string `json:"yaml,omitempty"`
}

func (input ControllerInput) MarshalJSON() ([]byte, error) {
	if input.YAML != nil {
		return json.Marshal(struct {
			YAML string `json:"yaml"`
		}{*input.YAML})
	}
	type fields ControllerInput
	return json.Marshal(fields(input))
}

type Params struct {
	ReleaseProxy *string          `json:"releaseProxy,omitempty"`
	URL          string           `json:"url,omitempty"`
	Interfaces   *string          `json:"interfaces,omitempty"`
	Controller   *ControllerInput `json:"controller,omitempty"`
}
type Request struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Params Params `json:"params"`
}

func DecodeRequest(data []byte) (Request, error) {
	var req Request
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if len(data) > 48*1024 || decoder.Decode(&req) != nil {
		return req, errors.New("请求格式无效")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return req, errors.New("请求只能包含一个 JSON 对象")
	}
	// Presence matters: an inapplicable parameter stays invalid even if empty or null.
	var fields struct {
		Params map[string]json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return req, errors.New("请求格式无效")
	}
	if req.Params.Controller != nil && req.Params.Controller.YAML != nil {
		var controller map[string]json.RawMessage
		if err := json.Unmarshal(fields.Params["controller"], &controller); err != nil || len(controller) != 1 {
			return req, errors.New("yaml 不能与其他控制面板参数混用")
		}
	}
	provided := make(map[string]bool, len(fields.Params))
	for name := range fields.Params {
		provided[strings.ToLower(name)] = true
	}
	return req, req.validate(provided)
}
func (r Request) validate(provided map[string]bool) error {
	if !validID(r.ID) {
		return errors.New("无效任务 ID")
	}
	p := r.Params
	allowInterfaces, allowURL, allowController, allowProxy := false, false, false, false
	switch r.Action {
	case "save-release-proxy":
		allowProxy = true
		if p.ReleaseProxy == nil {
			return errors.New("缺少发行转发参数")
		}
	case "save-interfaces":
		allowInterfaces = true
		if p.Interfaces == nil {
			return errors.New("缺少共享接口参数")
		}
	case "start":
		allowInterfaces = true
	case "update":
		allowURL = true
	case "save-controller":
		allowController = true
		if p.Controller == nil || (p.Controller.Enabled == nil && p.Controller.YAML == nil) {
			return errors.New("缺少控制面板参数")
		}
		if p.Controller.YAML != nil && (p.Controller.Enabled != nil || p.Controller.Port != 0 || p.Controller.Secret != nil || p.Controller.Reset) {
			return errors.New("yaml 不能与其他控制面板参数混用")
		}
	case "install", "download", "download-dashboard", "self-update", "stop", "restart", "boot-on", "boot-off", "uninstall":
	default:
		return errors.New("未知设备操作")
	}
	if (provided["releaseproxy"] || p.ReleaseProxy != nil) && !allowProxy || (provided["interfaces"] || p.Interfaces != nil) && !allowInterfaces || (provided["url"] || p.URL != "") && !allowURL || (provided["controller"] || p.Controller != nil) && !allowController {
		return errors.New("该操作不接受这些参数")
	}
	return nil
}
func (a *Manager) authorize(r Request) error {
	if err := r.validate(nil); err != nil {
		return err
	}
	if (r.Action == "save-interfaces" || r.Params.Interfaces != nil) && !a.Platform.Capabilities().Interfaces {
		return errors.New("共享网络由系统配置管理")
	}
	return nil
}
