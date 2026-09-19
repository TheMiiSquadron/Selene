import Testing
@testable import Selene

@Suite("Selene Pebble")
struct SelenePebbleTests {
    @Test("Idle breathing keeps principal illumination stable")
    func idleBreathingIllumination() {
        let resting = SelenePebble.idleVisualValues(isExpanded: false)
        let expanded = SelenePebble.idleVisualValues(isExpanded: true)

        #expect(resting.internalBaseOpacity == expanded.internalBaseOpacity)
        #expect(resting.internalBloomOpacity == expanded.internalBloomOpacity)
        #expect(expanded.externalGlowOpacity > resting.externalGlowOpacity)
    }

    @Test("Idle breathing remains subtle")
    func idleBreathingScale() {
        let resting = SelenePebble.idleVisualValues(isExpanded: false)
        let expanded = SelenePebble.idleVisualValues(isExpanded: true)

        #expect(expanded.glowScale > resting.glowScale)
        #expect(expanded.internalLightScale > resting.internalLightScale)
        #expect(expanded.glowScale - resting.glowScale < 0.031)
        #expect(expanded.internalLightScale - resting.internalLightScale < 0.011)
    }
}
