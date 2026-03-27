package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/amarnathcjd/gogram/telegram"
	"github.com/yaaia/yaaia-telegram-gateway/internal/events"
	tgstate "github.com/yaaia/yaaia-telegram-gateway/internal/tg"
	"github.com/yaaia/yaaia-telegram-gateway/internal/voip"
)

// Server is the YAAIA Telegram gateway (gogram MTProto + SSE events).
type Server struct {
	Token string
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Token == "" {
			next(w, r)
			return
		}
		tok := r.Header.Get("Authorization")
		if strings.HasPrefix(tok, "Bearer ") {
			tok = strings.TrimPrefix(tok, "Bearer ")
		}
		if tok != s.Token {
			http.Error(w, `{"ok":false,"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
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

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/health", s.auth(s.handleHealth))
	mux.HandleFunc("GET /v1/status", s.auth(s.handleStatus))
	mux.HandleFunc("POST /v1/session", s.auth(s.handleSession))
	mux.HandleFunc("POST /v1/login/send-code", s.auth(s.handleSendCode))
	mux.HandleFunc("POST /v1/login", s.auth(s.handleLogin))
	mux.HandleFunc("POST /v1/disconnect", s.auth(s.handleDisconnect))
	mux.HandleFunc("POST /v1/send", s.auth(s.handleSend))
	mux.HandleFunc("POST /v1/typing", s.auth(s.handleTyping))
	mux.HandleFunc("GET /v1/resolve", s.auth(s.handleResolve))
	mux.HandleFunc("GET /v1/events", s.auth(s.handleSSE))
	mux.HandleFunc("POST /v1/messages/missed", s.auth(s.handleMissedMessages))
	mux.HandleFunc("POST /v1/delete-history", s.auth(s.handleDeleteHistory))
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	jsonOk(w, map[string]any{"ok": true, "service": "yaaia-telegram-gateway"})
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	c := tgstate.Client()
	if c == nil {
		jsonOk(w, map[string]any{"ok": true, "connected": false})
		return
	}
	ok, err := c.IsAuthorized()
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOk(w, map[string]any{"ok": true, "connected": c.IsConnected(), "authorized": ok})
}

type sessionReq struct {
	AppID       int32  `json:"api_id"`
	AppHash     string `json:"api_hash"`
	SessionPath string `json:"session_path"`
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	var req sessionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.AppID == 0 || req.AppHash == "" || req.SessionPath == "" {
		jsonErr(w, http.StatusBadRequest, "api_id, api_hash, session_path required")
		return
	}
	voip.OnTelegramDisconnected()
	tgstate.ClearClient()

	cfg := telegram.ClientConfig{
		AppID:   req.AppID,
		AppHash: req.AppHash,
		Session: req.SessionPath,
		DeviceConfig: telegram.DeviceConfig{
			DeviceModel:   "Yaaia",
			SystemVersion: "gateway",
			AppVersion:    "1.0",
			LangCode:      "en",
		},
		SessionName: "yaaia",
	}
	cli, err := telegram.NewClient(cfg)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	cli.On(func(m *telegram.NewMessage) error {
		payload, ok := privateTextPayload(m)
		if !ok {
			return nil
		}
		payload["is_outgoing"] = false
		events.Publish("telegram_message", payload)
		_ = m.MarkRead()
		return nil
	})
	if err := cli.Connect(); err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	tgstate.SetClient(cli)
	voip.OnTelegramConnected(cli)
	jsonOk(w, map[string]any{"ok": true})
}

type sendCodeReq struct {
	Phone string `json:"phone"`
}

func (s *Server) handleSendCode(w http.ResponseWriter, r *http.Request) {
	c := tgstate.Client()
	if c == nil {
		jsonErr(w, http.StatusBadRequest, "call POST /v1/session first")
		return
	}
	var req sendCodeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Phone == "" {
		jsonErr(w, http.StatusBadRequest, "phone required")
		return
	}
	hash, err := c.SendCode(req.Phone)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOk(w, map[string]any{"ok": true, "code_hash": hash})
}

type loginReq struct {
	Phone       string `json:"phone"`
	Code        string `json:"code"`
	CodeHash    string `json:"code_hash"`
	Password    string `json:"password,omitempty"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	c := tgstate.Client()
	if c == nil {
		jsonErr(w, http.StatusBadRequest, "call POST /v1/session first")
		return
	}
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Phone == "" || req.Code == "" || req.CodeHash == "" {
		jsonErr(w, http.StatusBadRequest, "phone, code, code_hash required")
		return
	}
	opts := &telegram.LoginOptions{
		Code:     req.Code,
		CodeHash: req.CodeHash,
	}
	if req.Password != "" {
		opts.Password = req.Password
	}
	ok, err := c.Login(req.Phone, opts)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		jsonErr(w, http.StatusUnauthorized, "login failed")
		return
	}
	jsonOk(w, map[string]any{"ok": true})
}

func (s *Server) handleDisconnect(w http.ResponseWriter, _ *http.Request) {
	voip.OnTelegramDisconnected()
	tgstate.ClearClient()
	jsonOk(w, map[string]any{"ok": true})
}

type sendReq struct {
	PeerID int64  `json:"peer_id"`
	Text   string `json:"text"`
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	c := tgstate.Client()
	if c == nil {
		jsonErr(w, http.StatusBadRequest, "not connected")
		return
	}
	var req sendReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.PeerID == 0 || req.Text == "" {
		jsonErr(w, http.StatusBadRequest, "peer_id and text required")
		return
	}
	_, err := c.SendMessage(req.PeerID, req.Text)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOk(w, map[string]any{"ok": true})
}

type typingReq struct {
	PeerID int64 `json:"peer_id"`
}

func (s *Server) handleTyping(w http.ResponseWriter, r *http.Request) {
	c := tgstate.Client()
	if c == nil {
		jsonErr(w, http.StatusBadRequest, "not connected")
		return
	}
	var req typingReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.PeerID == 0 {
		jsonErr(w, http.StatusBadRequest, "peer_id required")
		return
	}
	_, err := c.SendAction(req.PeerID, "typing")
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOk(w, map[string]any{"ok": true})
}

func (s *Server) handleResolve(w http.ResponseWriter, r *http.Request) {
	c := tgstate.Client()
	if c == nil {
		jsonErr(w, http.StatusBadRequest, "not connected")
		return
	}
	u := strings.TrimSpace(r.URL.Query().Get("username"))
	if u == "" {
		jsonErr(w, http.StatusBadRequest, "username query required")
		return
	}
	u = strings.TrimPrefix(u, "@")
	p, err := c.ResolvePeer(u)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	id := c.GetPeerID(p)
	if id == 0 {
		jsonErr(w, http.StatusBadRequest, "could not resolve peer id")
		return
	}
	jsonOk(w, map[string]any{"ok": true, "bus_id": fmt.Sprintf("telegram-%d", id), "peer_id": id})
}

type missedReq struct {
	MaxDialogs   int32 `json:"max_dialogs"`
	PerPeerLimit int32 `json:"per_peer_limit"`
}

func (s *Server) handleMissedMessages(w http.ResponseWriter, r *http.Request) {
	c := tgstate.Client()
	if c == nil {
		jsonErr(w, http.StatusBadRequest, "not connected")
		return
	}
	var req missedReq
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	maxDialogs := req.MaxDialogs
	if maxDialogs <= 0 || maxDialogs > 500 {
		maxDialogs = 200
	}
	perPeer := req.PerPeerLimit
	if perPeer <= 0 || perPeer > 500 {
		perPeer = 100
	}
	dialogs, err := c.GetDialogs(&telegram.DialogOptions{Limit: maxDialogs})
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var out []map[string]any
	for i := range dialogs {
		d := &dialogs[i]
		if !d.IsUser() {
			continue
		}
		dlgObj, ok := d.Dialog.(*telegram.DialogObj)
		if !ok || dlgObj.UnreadCount == 0 {
			continue
		}
		peerID := d.GetID()
		limit := dlgObj.UnreadCount
		if limit > perPeer {
			limit = perPeer
		}
		msgs, err := c.GetHistory(peerID, &telegram.HistoryOption{Limit: limit})
		if err != nil {
			jsonErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		for j := len(msgs) - 1; j >= 0; j-- {
			m := &msgs[j]
			payload, ok := privateTextPayload(m)
			if !ok {
				continue
			}
			out = append(out, payload)
		}
	}
	peerMaxID := map[int64]int32{}
	for _, row := range out {
		cid, ok1 := jsonNumberToInt64(row["chat_id"])
		mid, ok2 := jsonNumberToInt64(row["message_id"])
		if !ok1 || !ok2 {
			continue
		}
		id32 := int32(mid)
		if prev, ok := peerMaxID[cid]; !ok || id32 > prev {
			peerMaxID[cid] = id32
		}
	}
	for peerID, maxID := range peerMaxID {
		_, _ = c.SendReadAck(peerID, maxID)
	}
	jsonOk(w, map[string]any{"ok": true, "messages": out})
}

type deleteHistoryReq struct {
	PeerID int64 `json:"peer_id"`
}

func (s *Server) handleDeleteHistory(w http.ResponseWriter, r *http.Request) {
	c := tgstate.Client()
	if c == nil {
		jsonErr(w, http.StatusBadRequest, "not connected")
		return
	}
	var req deleteHistoryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.PeerID == 0 {
		jsonErr(w, http.StatusBadRequest, "peer_id required")
		return
	}
	peer, err := c.ResolvePeer(req.PeerID)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	hist, err := c.GetHistory(req.PeerID, &telegram.HistoryOption{Limit: 1})
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var maxID int32
	if len(hist) > 0 {
		maxID = hist[0].ID
	}
	if maxID == 0 {
		jsonOk(w, map[string]any{"ok": true, "deleted": false, "note": "no messages"})
		return
	}
	_, err = c.MessagesDeleteHistory(&telegram.MessagesDeleteHistoryParams{
		Peer:   peer,
		MaxID:  maxID,
		Revoke: true,
	})
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOk(w, map[string]any{"ok": true, "deleted": true})
}

func jsonNumberToInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case int:
		return int64(x), true
	case int32:
		return int64(x), true
	case float64:
		return int64(x), true
	case json.Number:
		n, err := x.Int64()
		return n, err == nil
	default:
		return 0, false
	}
}

func privateTextPayload(m *telegram.NewMessage) (map[string]any, bool) {
	if m == nil || m.IsOutgoing() || !m.IsPrivate() {
		return nil, false
	}
	txt := strings.TrimSpace(m.MessageText())
	if txt == "" {
		txt = strings.TrimSpace(m.Text())
	}
	if txt == "" {
		return nil, false
	}
	chatID := m.ChatID()
	var userName string
	var userID int64
	if m.Sender != nil {
		userID = m.Sender.ID
		if m.Sender.Username != "" {
			userName = m.Sender.Username
		} else {
			userName = strings.TrimSpace(m.Sender.FirstName + " " + m.Sender.LastName)
		}
	}
	if userName == "" {
		userName = fmt.Sprintf("%d", userID)
	}
	ts := time.Unix(int64(m.Date()), 0).UTC().Format(time.RFC3339)
	return map[string]any{
		"bus_id":     fmt.Sprintf("telegram-%d", chatID),
		"user_id":    userID,
		"user_name":  userName,
		"content":    txt,
		"timestamp":  ts,
		"message_id": int64(m.ID),
		"chat_id":    chatID,
	}, true
}

func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no flush", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch := events.Subscribe()
	defer events.Unsubscribe(ch)
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			b, _ := json.Marshal(ev)
			fmt.Fprintf(w, "data: %s\n\n", b)
			fl.Flush()
		}
	}
}