//go:build ntgcalls && cgo && darwin && arm64

// Links libntgcalls from yaaia-app/native/ntgcalls/macos-arm64/lib/
// Prefer libntgcalls.dylib (see scripts/build-ntgcalls-macos-shared.sh). Ship the dylib next to yaaia-tg-gateway.
// At link time, pass rpath via env (Go rejects -Wl,-rpath,@loader_path in #cgo):
//   CGO_LDFLAGS='-Wl,-rpath,@loader_path' CGO_LDFLAGS_ALLOW='-Wl,-rpath,@loader_path'
// npm script build:telegram-gateway-voip sets these.
package main

/*
#cgo darwin,arm64 LDFLAGS: -L${SRCDIR}/../../../yaaia-app/native/ntgcalls/macos-arm64/lib -lntgcalls -lc++ -lz -lbz2 -liconv -framework AVFoundation -framework AudioToolbox -framework CoreAudio -framework QuartzCore -framework CoreMedia -framework VideoToolbox -framework AppKit -framework Metal -framework MetalKit -framework OpenGL -framework IOSurface -framework ScreenCaptureKit
*/
import "C"
