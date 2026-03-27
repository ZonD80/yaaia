package voip

import (
	"net/http"
	"strings"
)

func wrapBearerAuth(token string, next http.HandlerFunc) http.HandlerFunc {
	if token == "" {
		return next
	}
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get("Authorization")
		if strings.HasPrefix(tok, "Bearer ") {
			tok = strings.TrimPrefix(tok, "Bearer ")
		}
		if tok != token {
			http.Error(w, `{"ok":false,"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}
