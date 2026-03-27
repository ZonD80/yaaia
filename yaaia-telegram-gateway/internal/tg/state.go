package tg

import (
	"sync"

	"github.com/amarnathcjd/gogram/telegram"
)

var (
	mu     sync.RWMutex
	client *telegram.Client
)

func Client() *telegram.Client {
	mu.RLock()
	defer mu.RUnlock()
	return client
}

func SetClient(c *telegram.Client) {
	mu.Lock()
	defer mu.Unlock()
	client = c
}

func ClearClient() {
	mu.Lock()
	defer mu.Unlock()
	if client != nil {
		_ = client.Stop()
		client = nil
	}
}
