# Lighting Previz Tool — Build Spec

## Goal
Browser-based 3D lighting previz to design and test stage lighting setups, including fixtures not physically present. Faster iteration than Blender DMX. **Design preview / look-dev only — NOT full photometric simulation.**

## Signal Source
**Soundswitch → Art-Net over the network.** Soundswitch outputs Art-Net to third-party visualizers natively (v2.1+). The tool just listens on the network. No DMX hardware node required — software-to-software on the same machine or LAN.

## Stack
- **Three.js** (browser) for rendering
- **Node bridge** for Art-Net UDP input (listens for Soundswitch's output)
- **JSON fixture profiles** (hand-authored, not GDTF)

---

## Build Order

### Phase 1 — Scene + fixtures + input (easy, ~1-2 days)
- 3D scene: stage, trusses, fixture mount positions
- Fixtures as objects with params: pan, tilt, color (RGB/CMY), intensity, zoom
- **Art-Net listener** (see Networking section below)
- Map DMX channels → fixture params via per-fixture JSON profiles I author

### Phase 2 — The look (hard part, do it FAKED)
- **Volumetric beams via cone meshes** with additive blending + haze/fog. Do NOT attempt true raymarched volumetric scattering — fake it. Gets ~70% of the Capture look for a fraction of the effort.
- Beam falloff, color, intensity driven by fixture params

---

## Networking / Art-Net Input

- **Protocol:** Art-Net over UDP, **port 6454**, usually broadcast on the local network
- **Parse:** `ArtDMX` opcode (`0x5000`) → extract universe number + 512-byte data array
- **State:** `universes` object keyed by universe number → `Uint8Array(512)`, updated on every packet
- **Binding gotcha:** If Soundswitch and the tool run on the same machine, bind the UDP listener to the correct interface (often `0.0.0.0`, or the loopback/LAN adapter Soundswitch sends on). Net/Sub-Net/Universe addressing mismatches are the usual failure mode.
- **Debug:** Log incoming universe numbers on startup to confirm what Soundswitch is actually sending.

---

## Patching

Patching = the lookup table mapping each fixture to its DMX address. Two layers:

1. **Universe → channel array:** `universes[universeNum] = Uint8Array(512)`, updated per packet.
2. **Patch map → fixtures:** each fixture has `{ fixtureId, universe, startAddress, profileName }`. The profile JSON defines channel offsets (e.g. pan=0, tilt=1, dimmer=4).

Fixtures resolve params each frame:
```
universes[universe][startAddress + profile.offsets.pan]
```

**CRITICAL — match the Soundswitch patch by hand.** The tool does not auto-discover anything. Whatever universe / address / channel mode a fixture has in Soundswitch must be replicated exactly in the tool's patch map and JSON profile. If the profile's channel order doesn't match the fixture's mode in Soundswitch, beams move on the wrong axes.

---

## Data Structures (for implementation)
- **Art-Net listener:** UDP 6454, parse `ArtDMX` (0x5000), extract universe + 512-byte data
- **`universes`:** object keyed by universe number, updated per packet
- **`patch[]`:** array of `{ fixtureId, universe, startAddress, profileName }`
- **Fixture profiles:** hand-authored JSON, channel offsets per param, must match Soundswitch fixture mode
- Log incoming universe numbers on startup for debugging

**CRITICAL - create profiles for the files oppskbar.pdf and rockwedge.pdf**. These are the primary ones I am using, generate appropriate spec based on the json description, make sure to do so for each different channel mode since they may work for exmpale with 6, 8, 48, 53 (read each spec to determine the exact details)

---

## OUT of Scope (scope creep = rebuilding a commercial product)
- True raymarched volumetrics
- Gobos, prisms, framing shutters, beam profiles (each = custom shader work)
- GDTF fixture library import / large fixture libraries
- Multi-universe merging, full patch management UI, pixel mapping

## Reference Facts
- Art-Net/sACN packet specs are public and simple — integration is not the time sink
- GDTF/MVR are the industry-standard open fixture/scene formats. Not used here; only relevant for later real-fixture-data import.
- The silent time-sinks are fixture libraries and realistic beams. Avoid both: hand-author a few profiles, fake the volumetrics.

## Hold the Line
Target = fake-volumetric look-dev with a small hand-authored fixture set driven by live Soundswitch Art-Net. The moment it drifts toward accurate beams + gobos + full library, it becomes a months-long Capture rebuild. Keep it a layout/look-dev tool.