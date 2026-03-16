import Foundation

@MainActor
func handleRequest(method: String, path: String, body: Data?) async -> (Int, Data, String) {
    let manager = YaaiaVMManager.shared
    print("[YaaiaVM] handleRequest \(method) \(path)")

    func jsonResponse(_ data: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: data)) ?? Data()
    }

    switch (method, path) {
    case ("GET", "/vms"):
        let vms = manager.listVMs()
        return (200, jsonResponse(["ok": true, "vms": vms]), "application/json")

    case ("POST", "/create"):
        var isoPath: String?
        var ramMb: Int?
        var diskGb: Int?
        if let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        {
            if let path = obj["iso_path"] as? String, !path.isEmpty { isoPath = path }
            if let n = obj["ram_mb"] as? NSNumber { ramMb = n.intValue }
            if let n = obj["disk_gb"] as? NSNumber { diskGb = n.intValue }
        }
        do {
            let vm = try manager.createVM(isoPath: isoPath, ramMb: ramMb, diskGb: diskGb)
            return (200, jsonResponse(["ok": true, "vm": vm]), "application/json")
        } catch {
            return (500, jsonResponse(["ok": false, "error": error.localizedDescription]), "application/json")
        }

    case ("POST", _) where path.hasPrefix("/start/"):
        let id = String(path.dropFirst("/start/".count))
        guard !id.isEmpty else {
            return (400, jsonResponse(["ok": false, "error": "Missing vm id"]), "application/json")
        }
        do {
            try await manager.startVM(id: id)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (500, jsonResponse(["ok": false, "error": error.localizedDescription]), "application/json")
        }

    case ("POST", _) where path.hasPrefix("/stop/"):
        let id = String(path.dropFirst("/stop/".count))
        guard !id.isEmpty else {
            return (400, jsonResponse(["ok": false, "error": "Missing vm id"]), "application/json")
        }
        var force = false
        if let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let f = (obj["force"] as? NSNumber)?.boolValue
        {
            force = f
        }
        do {
            try await manager.stopVM(id: id, force: force)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (500, jsonResponse(["ok": false, "error": error.localizedDescription]), "application/json")
        }

    case ("POST", _) where path.hasPrefix("/delete/"):
        let id = String(path.dropFirst("/delete/".count))
        guard !id.isEmpty else {
            return (400, jsonResponse(["ok": false, "error": "Missing vm id"]), "application/json")
        }
        do {
            try await manager.deleteVM(id: id)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (500, jsonResponse(["ok": false, "error": error.localizedDescription]), "application/json")
        }

    case ("POST", _) where path.hasPrefix("/console/"):
        let id = String(path.dropFirst("/console/".count))
        manager.showConsole(id: id)
        return (200, jsonResponse(["ok": true]), "application/json")

    case ("GET", _) where path.hasPrefix("/serial-port/"):
        let id = String(path.dropFirst("/serial-port/".count))
        guard !id.isEmpty else {
            return (400, jsonResponse(["ok": false, "error": "Missing vm id"]), "application/json")
        }
        if let port = manager.serialPort(forVMId: id) {
            return (200, jsonResponse(["ok": true, "port": port]), "application/json")
        }
        return (404, jsonResponse(["ok": false, "error": "VM not running or no serial bridge"]), "application/json")

    default:
        return (404, jsonResponse(["ok": false, "error": "Not found"]), "application/json")
    }
}
