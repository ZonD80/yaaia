import Foundation
import AppKit
import Swifter

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

@main
struct YaaiaVMApp {
    static let yaaiaDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("yaaia")
    static let vmPortFile = yaaiaDir.appendingPathComponent("vm.port")

    private static func gracefulShutdownAndExit() {
        let sem = DispatchSemaphore(value: 0)
        Task { @MainActor in
            defer { sem.signal() }
            if let id = YaaiaVMManager.shared.runningVM?.id {
                do {
                    try await YaaiaVMManager.shared.stopVM(id: id, force: false)
                } catch { }
            }
            fflush(stdout)
        }
        _ = sem.wait(timeout: .now() + 30)
        exit(0)
    }

    static func main() async {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        signal(SIGTERM, SIG_IGN)
        let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .utility))
        sigtermSource.setEventHandler {
            sigtermSource.cancel()
            gracefulShutdownAndExit()
        }
        sigtermSource.resume()

        if let parentPidStr = ProcessInfo.processInfo.environment["YAAIA_PARENT_PID"],
           let parentPid = pid_t(parentPidStr) {
            DispatchQueue.global(qos: .utility).async {
                while true {
                    sleep(2)
                    if kill(parentPid, 0) != 0 {
                        gracefulShutdownAndExit()
                    }
                }
            }
        }

        let server = HttpServer()

        func syncHandle(_ method: String, _ path: String, _ body: Data?) -> HttpResponse {
            let sem = DispatchSemaphore(value: 0)
            var result: (Int, Data, String)?
            Task { @MainActor in
                result = await handleRequest(method: method, path: path, body: body)
                sem.signal()
            }
            let waitResult = sem.wait(timeout: .now() + .seconds(120))
            guard waitResult == .success, let (status, data, contentType) = result else {
                let errData = (try? JSONSerialization.data(withJSONObject: ["ok": false, "error": "Timeout"])) ?? Data()
                return .raw(500, "Internal Server Error", ["Content-Type": "application/json"], { try $0.write(errData) })
            }
            let headers: [String: String] = ["Content-Type": contentType, "Content-Length": "\(data.count)"]
            let phrase = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 404 ? "Not Found" : "Internal Server Error"
            return .raw(status, phrase, headers, { try $0.write(data) })
        }

        server.GET["/vms"] = { _ in syncHandle("GET", "/vms", nil) }
        server.POST["/create"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/create", body)
        }
        func idParam(_ req: HttpRequest) -> String {
            req.params[":id"] ?? req.params["id"] ?? ""
        }
        server.POST["/start/:id"] = { req in
            return syncHandle("POST", "/start/\(idParam(req))", nil)
        }
        server.POST["/stop/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/stop/\(idParam(req))", body)
        }
        server.POST["/delete/:id"] = { req in
            return syncHandle("POST", "/delete/\(idParam(req))", nil)
        }
        server.POST["/console/:id"] = { req in
            return syncHandle("POST", "/console/\(idParam(req))", nil)
        }
        server.GET["/serial-port/:id"] = { req in
            return syncHandle("GET", "/serial-port/\(idParam(req))", nil)
        }

        do {
            try server.start(0, forceIPv4: true)
            let actualPort = try server.port()
            try FileManager.default.createDirectory(at: yaaiaDir, withIntermediateDirectories: true)
            try String(actualPort).write(to: vmPortFile, atomically: true, encoding: .utf8)
            print("YaaiaVM listening on port \(actualPort)")
            fflush(stdout)
        } catch {
            print("[YaaiaVM] Failed to start server: \(error)")
            exit(1)
        }

        app.run()
    }
}
