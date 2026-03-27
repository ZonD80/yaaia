package main

import (
	"log"
	"net/http"
	"os"

	"github.com/yaaia/yaaia-telegram-gateway/internal/api"
	"github.com/yaaia/yaaia-telegram-gateway/internal/voip"
)

func main() {
	addr := os.Getenv("YAAIA_TG_GATEWAY_ADDR")
	if addr == "" {
		addr = "127.0.0.1:37567"
	}
	token := os.Getenv("YAAIA_TG_GATEWAY_TOKEN")
	if token == "" {
		log.Println("[yaaia-tg-gateway] YAAIA_TG_GATEWAY_TOKEN not set — listening without auth (localhost only recommended)")
	}

	mux := http.NewServeMux()
	srv := &api.Server{Token: token}
	srv.Register(mux)
	voip.Register(mux, token)

	log.Printf("[yaaia-tg-gateway] listening on http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
