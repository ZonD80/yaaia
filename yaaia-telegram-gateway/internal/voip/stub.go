//go:build !ntgcalls

package voip

import (
	"net/http"

	"github.com/amarnathcjd/gogram/telegram"
)

// OnTelegramConnected is a no-op without NTgCalls.
func OnTelegramConnected(_ *telegram.Client) {}

// OnTelegramDisconnected is a no-op without NTgCalls.
func OnTelegramDisconnected() {}

// Register mounts VoIP routes (501) when built without -tags ntgcalls.
func Register(mux *http.ServeMux, token string) {
	for _, p := range []string{"/v1/voip/call", "/v1/voip/pickup", "/v1/voip/hangup", "/v1/voip/reject"} {
		path := p
		mux.HandleFunc(path, wrapBearerAuth(token, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotImplemented)
			_, _ = w.Write([]byte(`{"ok":false,"error":"rebuild gateway with: CGO_ENABLED=1 go build -tags ntgcalls (requires libntgcalls + ffmpeg in PATH)"}`))
		}))
	}
}
