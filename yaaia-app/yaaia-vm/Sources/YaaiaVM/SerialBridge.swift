import Foundation
import Network

/// TCP bridge for VM serial port. Accepts one client at a time, forwards data bidirectionally.
final class SerialBridge {
    private let serialRead: FileHandle
    private let serialWrite: FileHandle
    private var listener: NWListener?
    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "YaaiaVM.SerialBridge")

    init(serialRead: FileHandle, serialWrite: FileHandle, vmId: String) {
        self.serialRead = serialRead
        self.serialWrite = serialWrite
    }

    /// Start listening on a random port. Returns the port number.
    func start() -> Int {
        var port: Int = 0
        let sem = DispatchSemaphore(value: 0)
        do {
            let params = NWParameters.tcp
            let listener = try NWListener(using: params, on: 0)
            self.listener = listener
            listener.stateUpdateHandler = { [weak self] state in
                if case .ready = state {
                    if let p = self?.listener?.port?.rawValue {
                        port = Int(p)
                    }
                    sem.signal()
                }
            }
            listener.newConnectionHandler = { [weak self] conn in
                self?.handleNewConnection(conn)
            }
            listener.start(queue: queue)
        } catch {
            print("[YaaiaVM] Serial bridge failed to start: \(error)")
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 5)
        return port
    }

    func stop() {
        queue.async { [weak self] in
            self?.connection?.cancel()
            self?.connection = nil
            self?.listener?.cancel()
            self?.listener = nil
        }
    }

    private func handleNewConnection(_ conn: NWConnection) {
        if connection != nil {
            conn.cancel()
            return
        }
        connection = conn
        conn.stateUpdateHandler = { [weak self] state in
            if case .cancelled = state {
                self?.connection = nil
            }
            if case .failed = state {
                self?.connection = nil
            }
        }
        conn.start(queue: queue)

        serialRead.readabilityHandler = { [weak self] _ in
            guard let self = self, let conn = self.connection else { return }
            let data = self.serialRead.availableData
            if !data.isEmpty {
                conn.send(content: data, completion: .contentProcessed { _ in })
            }
        }
        readSocketAndForward(conn)
    }

    private func readSocketAndForward(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, _ in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                try? self.serialWrite.write(contentsOf: data)
            }
            if !isComplete, self.connection != nil {
                self.readSocketAndForward(conn)
            }
        }
    }
}
