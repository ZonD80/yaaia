package events

import (
	"encoding/json"
	"sync"
)

// Event is pushed to SSE subscribers (new Telegram messages, future: VoIP).
type Event struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

var (
	mu          sync.Mutex
	subscribers []chan Event
)

func Subscribe() chan Event {
	ch := make(chan Event, 64)
	mu.Lock()
	subscribers = append(subscribers, ch)
	mu.Unlock()
	return ch
}

func Unsubscribe(ch chan Event) {
	mu.Lock()
	defer mu.Unlock()
	for i, s := range subscribers {
		if s == ch {
			subscribers = append(subscribers[:i], subscribers[i+1:]...)
			return
		}
	}
}

func Publish(t string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ev := Event{Type: t, Data: b}
	mu.Lock()
	subs := append([]chan Event(nil), subscribers...)
	mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}
