//go:build ntgcalls

package voip

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/amarnathcjd/gogram/telegram"
	"gotgcalls/ntgcalls"
	"gotgcalls/ubot"

	tgstate "github.com/yaaia/yaaia-telegram-gateway/internal/tg"
)

var (
	voipMu  sync.Mutex
	voipCtx *ubot.Context
)

// OnTelegramConnected attaches NTgCalls / ubot to the live gogram client (after MTProto session).
func OnTelegramConnected(c *telegram.Client) {
	voipMu.Lock()
	defer voipMu.Unlock()
	if voipCtx != nil {
		voipCtx.Close()
		voipCtx = nil
	}
	voipCtx = ubot.NewInstance(c)
}

// OnTelegramDisconnected tears down VoIP before the Telegram client is stopped.
func OnTelegramDisconnected() {
	voipMu.Lock()
	defer voipMu.Unlock()
	if voipCtx != nil {
		voipCtx.Close()
		voipCtx = nil
	}
}

func getVoipCtx() (*ubot.Context, error) {
	voipMu.Lock()
	defer voipMu.Unlock()
	if voipCtx == nil {
		return nil, fmt.Errorf("telegram not connected")
	}
	return voipCtx, nil
}

// silenceMedia feeds stereo silence via ffmpeg (must be on PATH) for outgoing/accepted calls.
func silenceMedia() ntgcalls.MediaDescription {
	return ntgcalls.MediaDescription{
		Microphone: &ntgcalls.AudioDescription{
			MediaSource:  ntgcalls.MediaSourceShell,
			SampleRate:   48000,
			ChannelCount: 2,
			Input:        "ffmpeg -loglevel quiet -f lavfi -i anullsrc=r=48000:cl=stereo -f s16le -ac 2 -ar 48000 -v quiet pipe:1",
		},
	}
}

func parseTelegramBus(busID string) (int64, error) {
	s := strings.TrimSpace(busID)
	if !strings.HasPrefix(s, "telegram-") {
		return 0, fmt.Errorf("invalid bus_id")
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(s, "telegram-"), 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid bus_id")
	}
	return n, nil
}

// Register mounts real VoIP handlers (requires CGO + libntgcalls).
func Register(mux *http.ServeMux, token string) {
	mux.HandleFunc("POST /v1/voip/call", wrapBearerAuth(token, handleCall))
	mux.HandleFunc("POST /v1/voip/pickup", wrapBearerAuth(token, handlePickup))
	mux.HandleFunc("POST /v1/voip/hangup", wrapBearerAuth(token, handleHangup))
	mux.HandleFunc("POST /v1/voip/reject", wrapBearerAuth(token, handleReject))
}

type voipReq struct {
	BusID     string `json:"bus_id"`
	TimeoutMS int    `json:"timeout_ms"`
}

func jsonErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
}

func jsonOk(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func handleCall(w http.ResponseWriter, r *http.Request) {
	if tgstate.Client() == nil {
		jsonErr(w, http.StatusBadRequest, "not connected")
		return
	}
	var req voipReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	peerID, err := parseTelegramBus(req.BusID)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	timeout := 120 * time.Second
	if req.TimeoutMS >= 5000 {
		timeout = time.Duration(req.TimeoutMS) * time.Millisecond
	}
	uc, err := getVoipCtx()
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	done := make(chan error, 1)
	go func() {
		done <- uc.Play(peerID, silenceMedia())
	}()
	select {
	case err = <-done:
		if err != nil {
			jsonErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		jsonOk(w, map[string]any{
			"ok": true, "bus_id": req.BusID,
			"call_id": fmt.Sprintf("p2p-%d", peerID), "key_fingerprint": "0", "encryption_key_b64": "",
		})
	case <-time.After(timeout):
		_ = uc.DiscardP2P(peerID, false)
		jsonErr(w, http.StatusGatewayTimeout, "call timed out")
	}
}

func handlePickup(w http.ResponseWriter, r *http.Request) {
	if tgstate.Client() == nil {
		jsonErr(w, http.StatusBadRequest, "not connected")
		return
	}
	var req voipReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	peerID, err := parseTelegramBus(req.BusID)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	timeout := 90 * time.Second
	if req.TimeoutMS >= 5000 {
		timeout = time.Duration(req.TimeoutMS) * time.Millisecond
	}
	uc, err := getVoipCtx()
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	done := make(chan error, 1)
	go func() {
		done <- uc.Play(peerID, silenceMedia())
	}()
	select {
	case err = <-done:
		if err != nil {
			jsonErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		jsonOk(w, map[string]any{
			"ok": true, "bus_id": req.BusID,
			"call_id": fmt.Sprintf("p2p-%d", peerID), "key_fingerprint": "0", "encryption_key_b64": "",
		})
	case <-time.After(timeout):
		_ = uc.DiscardP2P(peerID, false)
		jsonErr(w, http.StatusGatewayTimeout, "pickup timed out")
	}
}

func handleHangup(w http.ResponseWriter, r *http.Request) {
	var req voipReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	if strings.TrimSpace(req.BusID) == "" {
		jsonErr(w, http.StatusBadRequest, "bus_id required")
		return
	}
	peerID, err := parseTelegramBus(req.BusID)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uc, err := getVoipCtx()
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := uc.DiscardP2P(peerID, false); err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOk(w, map[string]any{"ok": true})
}

func handleReject(w http.ResponseWriter, r *http.Request) {
	var req voipReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	peerID, err := parseTelegramBus(req.BusID)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uc, err := getVoipCtx()
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := uc.DiscardP2P(peerID, true); err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOk(w, map[string]any{"ok": true})
}
