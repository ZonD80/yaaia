// yaaia-vm-agent: runs inside Linux VM, connects to host via WebSocket,
// receives bash scripts to execute, streams stdout/stderr, supports stdin for interactive prompts.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultPort    = 29542
	reconnectDelay = 5 * time.Second
)

type scriptMsg struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Script string `json:"script"`
	User   string `json:"user"` // required: run as this user (e.g. root, user)
}

type stdinMsg struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Data string `json:"data"`
}

type resultMsg struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

type streamMsg struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Stream string `json:"stream"` // "stdout" or "stderr"
	Data   string `json:"data"`
}

// getDefaultGateway returns the default gateway IP (host in NAT). Uses `ip route`.
func getDefaultGateway() (string, error) {
	out, err := exec.Command("ip", "-4", "route", "show", "default").Output()
	if err != nil {
		return "", fmt.Errorf("ip route: %w", err)
	}
	// Parse "default via 10.0.2.2 dev eth0" or "default via 192.168.64.1 dev eth0"
	line := string(out)
	const via = "via "
	idx := strings.Index(line, via)
	if idx < 0 {
		return "", fmt.Errorf("no default route found")
	}
	rest := line[idx+len(via):]
	space := strings.Index(rest, " ")
	if space > 0 {
		rest = rest[:space]
	}
	rest = strings.TrimSpace(rest)
	if ip := net.ParseIP(rest); ip != nil && ip.To4() != nil {
		return ip.String(), nil
	}
	return "", fmt.Errorf("invalid gateway in route: %q", rest)
}

func runScript(conn *websocket.Conn, writeMux *sync.Mutex, id, script string, user string, stdinCh chan string, onDone func()) {
	var cmd *exec.Cmd
	var useSuFallback bool
	if _, err := exec.LookPath("runuser"); err == nil {
		cmd = exec.Command("runuser", "-u", user, "--", "bash", "-c", script)
	} else {
		// Fallback for Alpine/minimal distros: su - user -c "bash -s" with script on stdin
		useSuFallback = true
		cmd = exec.Command("su", "-", user, "-c", "bash -s")
	}
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	var stdinPipe io.WriteCloser
	if useSuFallback {
		pr, pw := io.Pipe()
		cmd.Stdin = pr
		go func() {
			pw.Write([]byte(script))
			for data := range stdinCh {
				pw.Write([]byte(data))
			}
			pw.Close()
		}()
		stdinPipe = pw
	} else {
		stdinPipe, _ = cmd.StdinPipe()
	}

	if err := cmd.Start(); err != nil {
		sendResultB64(conn, writeMux, id, nil, []byte(err.Error()), -1)
		return
	}

	var stdoutBuf, stderrBuf bytes.Buffer
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2)

	// Stream stdout (base64 for safe transfer, no encoding issues)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				mu.Lock()
				stdoutBuf.Write(buf[:n])
				mu.Unlock()
				sendStreamB64(conn, writeMux, id, "stdout", buf[:n])
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				break
			}
		}
	}()

	// Stream stderr (base64 for safe transfer)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				mu.Lock()
				stderrBuf.Write(buf[:n])
				mu.Unlock()
				sendStreamB64(conn, writeMux, id, "stderr", buf[:n])
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				break
			}
		}
	}()

	// Stdin from host (interactive). For su fallback, script+stdinCh already handled above.
	if !useSuFallback {
		go func() {
			for data := range stdinCh {
				stdinPipe.Write([]byte(data))
			}
			stdinPipe.Close()
		}()
	}

	// Wait for completion
	err := cmd.Wait()
	close(stdinCh)

	// Wait for stdout/stderr goroutines to finish before reading buffers
	wg.Wait()

	mu.Lock()
	outBytes := stdoutBuf.Bytes()
	errOutBytes := stderrBuf.Bytes()
	mu.Unlock()

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
			errOutBytes = append(errOutBytes, []byte(err.Error())...)
		}
	}

	fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Script id=%s done exitCode=%d stdout=%d stderr=%d\n", id, exitCode, len(outBytes), len(errOutBytes))
	if len(outBytes) > 0 && len(outBytes) <= 500 {
		fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] stdout content: %q\n", string(outBytes))
	} else if len(outBytes) > 500 {
		fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] stdout (first 200): %q ...\n", string(outBytes[:min(200, len(outBytes))]))
	}
	sendResultB64(conn, writeMux, id, outBytes, errOutBytes, exitCode)
	if onDone != nil {
		onDone()
	}
}

func sendResultB64(conn *websocket.Conn, mux *sync.Mutex, id string, stdout, stderr []byte, exitCode int) {
	msg := resultMsg{
		Type:     "result",
		ID:       id,
		Stdout:   base64.StdEncoding.EncodeToString(stdout),
		Stderr:   base64.StdEncoding.EncodeToString(stderr),
		ExitCode: exitCode,
	}
	mux.Lock()
	defer mux.Unlock()
	conn.WriteMessage(websocket.TextMessage, mustJSON(msg))
}

func sendStreamB64(conn *websocket.Conn, mux *sync.Mutex, id, stream string, data []byte) {
	msg := streamMsg{Type: "stream", ID: id, Stream: stream, Data: base64.StdEncoding.EncodeToString(data)}
	mux.Lock()
	defer mux.Unlock()
	conn.WriteMessage(websocket.TextMessage, mustJSON(msg))
}

func mustJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] JSON marshal error: %v\n", err)
		return []byte(`{"type":"error","error":"marshal failed"}`)
	}
	return b
}

func run(conn *websocket.Conn) {
	stdinChans := make(map[string]chan string)
	var mu sync.Mutex
	var writeMux sync.Mutex

	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var base struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(msgBytes, &base); err != nil {
			continue
		}

		switch base.Type {
		case "script":
			var m scriptMsg
			if err := json.Unmarshal(msgBytes, &m); err != nil {
				fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Invalid script msg: %v\n", err)
				continue
			}
			fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Running script id=%s len=%d\n", m.ID, len(m.Script))
			ch := make(chan string, 8)
			mu.Lock()
			stdinChans[m.ID] = ch
			mu.Unlock()
			go runScript(conn, &writeMux, m.ID, m.Script, m.User, ch, func() {
				mu.Lock()
				delete(stdinChans, m.ID)
				mu.Unlock()
			})
		case "stdin":
			var m stdinMsg
			if err := json.Unmarshal(msgBytes, &m); err != nil {
				continue
			}
			mu.Lock()
			ch := stdinChans[m.ID]
			mu.Unlock()
			if ch != nil {
				select {
				case ch <- m.Data:
				default:
				}
			}
		}
	}
}

func main() {
	gateway, err := getDefaultGateway()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Failed to get gateway: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Gateway (host): %s\n", gateway)

	port := defaultPort
	if p := os.Getenv("YAAIA_VM_AGENT_PORT"); p != "" {
		fmt.Sscanf(p, "%d", &port)
	}

	url := fmt.Sprintf("ws://%s:%d/vm-eval", gateway, port)
	fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Connecting to %s\n", url)

	for {
		conn, _, err := websocket.DefaultDialer.Dial(url, http.Header{})
		if err != nil {
			fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Connect failed: %v, retry in %v\n", err, reconnectDelay)
			time.Sleep(reconnectDelay)
			continue
		}
		fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Connected to %s\n", url)
		run(conn)
		conn.Close()
		fmt.Fprintf(os.Stderr, "[yaaia-vm-agent] Disconnected, reconnecting in %v\n", reconnectDelay)
		time.Sleep(reconnectDelay)
	}
}
