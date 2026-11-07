import AppKit
import Foundation

// Source artwork: a luminous spiral shell and little stars on an indigo tile.
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor { NSColor(srgbRed: r, green: g, blue: b, alpha: a) }
func draw(_ size: Int, _ name: String) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState(); defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let context = NSGraphicsContext.current!.cgContext
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    let tile = NSBezierPath(roundedRect: NSRect(x: 38, y: 38, width: 948, height: 948), xRadius: 216, yRadius: 216)
    NSGradient(colors: [color(0.055, 0.065, 0.19), color(0.26, 0.13, 0.46), color(0.40, 0.24, 0.64)])!.draw(in: tile, angle: 55)
    color(0.77, 0.78, 1, 0.22).setStroke(); tile.lineWidth = 3; tile.stroke()
    let spiral = NSBezierPath()
    for index in 0...650 {
        let t = CGFloat(index) / 650
        let angle = t * .pi * 4.5 - .pi / 3
        let radius = 18 + 290 * pow(t, 1.03)
        let point = NSPoint(x: 493 + cos(angle) * radius, y: 465 + sin(angle) * radius)
        if index == 0 { spiral.move(to: point) } else { spiral.line(to: point) }
    }
    spiral.lineCapStyle = .round; spiral.lineJoinStyle = .round
    let shadow = NSShadow(); shadow.shadowColor = color(0.32, 0.85, 1, 0.6); shadow.shadowBlurRadius = 38; shadow.set()
    color(0.53, 0.95, 0.97).setStroke(); spiral.lineWidth = 34; spiral.stroke()
    NSShadow().set(); color(0.93, 1, 1, 0.85).setStroke(); spiral.lineWidth = 9; spiral.stroke()
    func star(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat) {
        let shape = NSBezierPath()
        for point in 0..<8 {
            let angle = CGFloat(point) * .pi / 4
            let length = point % 2 == 0 ? radius : radius * 0.25
            let value = NSPoint(x: x + cos(angle) * length, y: y + sin(angle) * length)
            if point == 0 { shape.move(to: value) } else { shape.line(to: value) }
        }
        shape.close(); color(1, 0.9, 0.67).setFill(); shape.fill()
    }
    star(778, 787, 68); star(259, 783, 29); star(792, 264, 22)
    try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(name))
}
for size in [16, 32, 128, 256, 512] {
    try draw(size, "icon_" + String(size) + "x" + String(size) + ".png")
    try draw(size * 2, "icon_" + String(size) + "x" + String(size) + "@2x.png")
}
