package manager

import (
	"context"
	"time"

	"github.com/imbytecat/mihomoctl/internal/platform"
)

type Status struct {
	Updates      *Updates              `json:"updates"`
	Platform     string                `json:"platform"`
	Capabilities platform.Capabilities `json:"capabilities"`
	Protocol     int                   `json:"protocol"`
	Version      string                `json:"version"`
	PublicKey    string                `json:"publicKey"`
	Service      bool                  `json:"service"`
	Core         bool                  `json:"core"`
	CoreVersion  string                `json:"coreVersion"`
	Config       bool                  `json:"config"`
	Subscription bool                  `json:"subscription"`
	Running      bool                  `json:"running"`
	Supervisor   bool                  `json:"supervisor"`
	Listeners    bool                  `json:"listeners"`
	Network      bool                  `json:"network"`
	Boot         bool                  `json:"boot"`
	Locked       bool                  `json:"locked"`
	Capture      bool                  `json:"capture"`
	Settings     Settings              `json:"settings"`
	Task         *Job                  `json:"task"`
	Controller   *ControllerStatus     `json:"controller"`
	Dashboard    DashboardStatus       `json:"dashboard"`
}

func (a *Manager) Inspect() (Status, error) {
	status := Status{Protocol: Protocol, Version: a.Version, Platform: a.Platform.Config().Kind, Capabilities: a.Platform.Capabilities()}
	if err := a.requireIdentity(); err != nil {
		return status, err
	}
	var err error
	status.PublicKey, err = a.PublicKey()
	if err != nil {
		return status, err
	}
	status.Service, err = a.store.Installed()
	if err != nil {
		return status, err
	}
	status.Updates, err = a.store.Updates()
	if err != nil {
		return status, err
	}
	status.Core = a.coreInstalled()
	if status.Core {
		status.CoreVersion = a.coreVersion()
	}
	if id, e := a.activeGeneration(); e == nil {
		status.Config = id != ""
	}
	if config, e := a.configuration(); e == nil {
		status.Subscription = config.URL != ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	state, err := a.Platform.Inspect(ctx)
	if err != nil {
		return status, err
	}
	status.Running, status.Supervisor, status.Listeners, status.Network, status.Capture, status.Boot = state.Running, state.Supervisor, state.Listeners, state.Network, state.Capture, state.Boot
	status.Settings, err = a.settings()
	if err != nil {
		return status, err
	}
	if status.Service {
		control, e := a.controller()
		if e != nil {
			return status, e
		}
		config, _ := a.configuration()
		status.Controller = &ControllerStatus{Enabled: control.Enabled, Port: control.Port, Applied: config.Controller != nil, Overrides: true}
		status.Dashboard = a.dashboard()
	}
	if status.Settings.Interfaces == nil {
		status.Settings.Interfaces = []string{}
	}
	if status.Updates != nil {
		compareUpdate(&status.Updates.Self, status.Version, true)
		compareUpdate(&status.Updates.Core, status.CoreVersion, status.Core)
		compareUpdate(&status.Updates.Dashboard, status.Dashboard.Version, status.Dashboard.Installed)
	}
	status.Task = a.latestJob()
	if lock, e := a.lock(); e == nil {
		lock.Close()
	} else {
		status.Locked = true
	}
	return status, nil
}
