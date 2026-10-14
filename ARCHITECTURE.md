# Selene Architecture

**Status:** Canonical component naming and responsibility reference  
**Scope:** Selene's local-first assistant architecture; implementation maturity varies by component.

## Architecture at a glance

```text
                        Selene (assistant identity)
                                   |
                    Selene Core (NOVA primary host)
                      /                    \
          Twelve Pillars              Selene Link
       (capability modules)      (controlled communication)
                                         |
                         Authenticated native Homes
                       /        |         |        \
                  Windows     macOS       iOS      watchOS
                    |           |         |         |
                  NOVA/ENVY    ORION    iPhone   Apple Watch
                       \        |         |        /
                            Constellation
                        (connected device ecosystem)
```

The diagram describes responsibilities and intended connections, **not** a claim that every connection, permission, or feature is implemented.

## Canonical names and boundaries

| Name | Responsibility | Boundary |
| --- | --- | --- |
| **Selene** | One assistant identity across authorized devices | Not a separate assistant for each device |
| **Selene Core** | Models, request orchestration, authority, and local execution | Privileged operations stay behind Core authority checks |
| **Selene Link** | Non-privileged API and secure communication path between Core and native Homes | Never directly exposes privileged Core commands; transport, authentication, and pairing must be explicitly secured |
| **Selene Homes** | Native user experiences on Windows, macOS, iOS, and watchOS | Homes are device/platform environments, **not** capability modules |
| **Selene Constellation** | Registered devices, roles, connectivity, and authorized coordination | A network of devices, **not** a fifth Home or another API server |
| **Selene Pillars** | Twelve canonical capability domains | Pillars describe what Selene can do, not where she lives or what she may do without permission |
| **Selene Pebble** | Windows tray/overlay and interaction surface | A Windows UI component, not the Core or Link service |

### Native Homes

- **Windows Home:** NOVA (primary host) and ENVY.
- **macOS Home:** ORION.
- **iOS Home:** iPhone.
- **watchOS Home:** Apple Watch.

A single device may host multiple components: NOVA runs Core and can also run a Windows Home. Constellation membership does not automatically grant access to Core or another device.

## Communication and authority

1. A Home presents a request through **Selene Link** using an approved transport and authorization mechanism.
2. Link validates and routes only supported requests; it is not a shortcut around Core authority controls.
3. Core coordinates authorized capabilities and, when appropriate, the Twelve Pillars.
4. Results return through Link to the requesting Home.

**Security status:** Credential foundations and design decisions exist, but do not assume authentication, encrypted transport, pairing, or remote access are complete merely because the architecture specifies them. The privileged Core command server on port `3030` is loopback-only; the non-privileged Link service currently uses port `8787` and has configurable transport/LAN behavior. Follow `core/README.md` for actual current configuration and security warnings.

## Retirement and migration

**Web Companion is retired.** Its browser frontend (`companion/`) was deleted on the dedicated cleanup branch. It is **not** a Home and must not be reintroduced as a dependency for native Homes or the Pillars.

**Selene Link** is the permanent product/architecture name for the backend previously called *Companion API* and provisionally *Gateway*. Existing identifiers such as `companionServer.js`, Swift `CompanionAPI` types, `gatewayCredential*` modules, and `SELENE_COMPANION_*` environment variables are implementation/compatibility names, **not** separate architectural services. Rename them only with coordinated import, client, configuration, and test updates; do not silently break existing installations.

## Related references

- [Selene project overview](Selene.md)
- [Core runtime and transport instructions](core/README.md)
- [Pillar master roadmap](docs/pillars/00%20-%20Master%20Roadmap.md)

When architectural terminology conflicts, **this document defines the canonical component names**. Runtime documentation and code remain authoritative for what is actually implemented.
